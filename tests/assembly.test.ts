import { Dotk, OwnerType, SubnameError, encodeActiveDeedState, fromHex, hex32, toHex } from '@dotk/sdk'
import { describe, expect, it } from 'vitest'
import { assemble, build, DUST_SOMPI, FOLD_CEILING_SOMPI, MAX_FEE_SOMPI } from '../src/assemble.js'
import { FeeCeilingError, InsufficientFundingError, MassCeilingError, TxError } from '../src/errors.js'

import type { SpendableUtxo } from '../src/ports.js'
import { ecdsaSighash, schnorrSighash, transactionId } from '../src/sighash.js'
import { transferIntent, type Deed } from '../src/transfer.js'
import { requiredFee } from '../src/mass.js'
import { emptyTx, toSafeJson } from '../src/tx.js'
import { vectors } from './vectors.js'

const dotk = new Dotk({ api: null, network: 'testnet-10' })
const registry = dotk.protocol

function stateBytes(name: string, ownerType: number, owner: string): Uint8Array {
  const padded = new Uint8Array(32)
  padded.set(new TextEncoder().encode(name))
  return encodeActiveDeedState(fromHex(dotk.keyOf(name)), ownerType, hex32(owner, 'owner'), padded)
}

/** The deed the vector describes, as the node would report it. */
function deedOf(name: string, ownerType: number, owner: string, txid: string, index: number): Deed {
  return {
    state: { key: dotk.keyOf(name), ownerType, owner, name },
    utxo: {
      outpoint: { transactionId: txid, index },
      amount: BigInt(registry.params.bond),
      scriptPublicKey: toHex(registry.deed.scriptPublicKey(stateBytes(name, ownerType, owner))),
      scriptVersion: 0,
      blockDaaScore: 0n,
      isCoinbase: false,
      covenantId: registry.registryCovenantId,
    },
  }
}

/**
 * The fee is the one number this package computes rather than reads, and a wrong one is either
 * an overpayment or a transaction the mempool silently will not relay. These replay what
 * the corpus holds for the same transaction.
 */
describe('the assembled transfer', () => {
  it.each(vectors.transferAssembly)(
    '$name at feerate $feerate',
    ({
      name,
      ownerType,
      owner,
      newOwnerType,
      newOwner,
      deedOutpoint,
      funding,
      fundingSpk,
      changeSpk,
      feerate,
      size,
      computeMass,
      transientMass,
      feeMass,
      fee,
      changeValue,
    }) => {
      const deed = deedOf(name, ownerType, owner, deedOutpoint[0], deedOutpoint[1])
      const plan = transferIntent(registry, registry.deedAbi, deed, newOwnerType, newOwner)
      const coins: SpendableUtxo[] = funding.map(([txid, index, value]) => ({
        outpoint: { transactionId: txid, index },
        amount: BigInt(value),
        scriptPublicKey: fundingSpk,
        scriptVersion: 0,
        blockDaaScore: 0n,
        isCoinbase: false,
      }))

      const assembled = assemble(plan.base, {
        funding: coins,
        changeScriptPublicKey: changeSpk,
        feerate,
        requiredFunding: 0n,
      })

      const masses = assembled.mass
      expect(masses.size).toBe(BigInt(size))
      expect(masses.compute).toBe(BigInt(computeMass))
      expect(masses.transient).toBe(BigInt(transientMass))
      expect(masses.fee).toBe(BigInt(feeMass))
      expect(assembled.fee).toBe(BigInt(fee))
      const change = assembled.changeIndex < 0 ? null : assembled.tx.outputs[assembled.changeIndex]!.value
      expect(change).toBe(changeValue === null ? null : BigInt(changeValue))
    }
  )
})

/**
 * KIP-9 prices an output at 10^12 / value in storage mass. Change under the floor is not worth
 * an output, and change just above it can still overrun the cap beside the other outputs. Both
 * go to fee rather than refusing the transaction, and the fee stays under the ceiling.
 */
describe('change near the storage floor', () => {
  const c = vectors.transferAssembly[0]!
  const deed = deedOf(c.name, c.ownerType, c.owner, c.deedOutpoint[0], c.deedOutpoint[1])
  const base = () => transferIntent(registry, registry.deedAbi, deed, c.newOwnerType, c.newOwner).base
  const coin = (amount: bigint): SpendableUtxo => ({
    outpoint: { transactionId: 'cc'.repeat(32), index: 0 },
    amount,
    scriptPublicKey: c.fundingSpk,
    scriptVersion: 0,
    blockDaaScore: 0n,
    isCoinbase: false,
  })
  const at = (amount: bigint) =>
    assemble(base(), { funding: [coin(amount)], changeScriptPublicKey: c.changeSpk, feerate: 1, requiredFunding: 0n })
  const leftover = (a: ReturnType<typeof at>) =>
    a.tx.inputs.reduce((n, i) => n + i.utxo.amount, 0n) - a.tx.outputs.reduce((n, o) => n + o.value, 0n)

  it('folds change under the floor into the fee, and keeps change above it', () => {
    const wide = at(10_000_000_000n)
    expect(wide.changeIndex).toBeGreaterThanOrEqual(0)
    const folded = at(wide.fee + DUST_SOMPI - 1n)
    expect(folded.changeIndex).toBe(-1)
    expect(folded.fee).toBe(leftover(folded))
    expect(folded.fee).toBeLessThanOrEqual(MAX_FEE_SOMPI)
    const kept = at(wide.fee + 10_000_000n)
    expect(kept.changeIndex).toBeGreaterThanOrEqual(0)
    expect(kept.tx.outputs[kept.changeIndex]!.value).toBe(10_000_000n)
    expect(kept.fee).toBe(wide.fee)
  })

  /** Past the fold's ceiling the transaction is refused, and another coin is the remedy, not a fee nobody asked for. */
  it('refuses rather than folds change past the ceiling', () => {
    const extra = { value: 2_500_000n, scriptPublicKey: c.changeSpk, scriptVersion: 0 }
    const withExtra = (amount: bigint) =>
      assemble(
        { ...base(), outputs: [...base().outputs, extra] },
        { funding: [coin(amount)], changeScriptPublicKey: c.changeSpk, feerate: 1, requiredFunding: 0n }
      )
    const wide = withExtra(10_000_000_000n)
    // Change at the ceiling still overruns storage beside the extra output and folds; just past
    // it, the same overrun is refused.
    expect(withExtra(extra.value + wide.fee + FOLD_CEILING_SOMPI).changeIndex).toBe(-1)
    expect(() => withExtra(extra.value + wide.fee + FOLD_CEILING_SOMPI + 500_000n)).toThrow(MassCeilingError)
  })

  it('refuses a change script that is not hex as a TxError', () => {
    expect(() =>
      assemble(base(), {
        funding: [coin(10_000_000_000n)],
        changeScriptPublicKey: 'zz',
        feerate: 1,
        requiredFunding: 0n,
      })
    ).toThrow(TxError)
  })

  it('refuses a change script that is not text, by the field name', () => {
    expect(() =>
      assemble(base(), {
        funding: [coin(10_000_000_000n)],
        changeScriptPublicKey: null as unknown as string,
        feerate: 1,
        requiredFunding: 0n,
      })
    ).toThrow(/changeScriptPublicKey must be a hex string/)
  })

  /**
   * Beside another small output, change at the floor itself overruns the storage cap, where the
   * same change beside the bare continuation does not. The fold reads the measurement, so it
   * folds this one and keeps that one.
   */
  it('folds change above the floor where keeping it would overrun storage mass', () => {
    const extra = { value: 50_000_000n, scriptPublicKey: c.changeSpk, scriptVersion: 0 }
    const withExtra = (amount: bigint) =>
      assemble(
        { ...base(), outputs: [...base().outputs, extra] },
        { funding: [coin(amount)], changeScriptPublicKey: c.changeSpk, feerate: 1, requiredFunding: 0n }
      )
    const wide = withExtra(10_000_000_000n)
    // The coin funds the extra output too, so the leftover is the change.
    const folded = withExtra(extra.value + wide.fee + DUST_SOMPI)
    expect(folded.changeIndex).toBe(-1)
    expect(folded.fee).toBe(leftover(folded))
    expect(folded.tx.outputs).toHaveLength(base().outputs.length + 1)
    // The same change beside the bare continuation clears the cap and stays.
    const plain = at(at(10_000_000_000n).fee + DUST_SOMPI)
    expect(plain.changeIndex).toBeGreaterThanOrEqual(0)
    expect(plain.tx.outputs[plain.changeIndex]!.value).toBe(DUST_SOMPI)
  })

  it('refuses a change script that is not hex', () => {
    expect(() =>
      assemble(base(), {
        funding: [coin(10_000_000_000n)],
        changeScriptPublicKey: 'xyz',
        feerate: 1,
        requiredFunding: 0n,
      })
    ).toThrow(/change script/)
  })
})

describe('what assembly refuses', () => {
  const case0 = vectors.transferAssembly[0]!
  const deed = deedOf(case0.name, case0.ownerType, case0.owner, case0.deedOutpoint[0], case0.deedOutpoint[1])
  const plan0 = () => transferIntent(registry, registry.deedAbi, deed, case0.newOwnerType, case0.newOwner)
  const plan = plan0
  const buildAtFee = (base: Parameters<typeof assemble>[0], fee: bigint) =>
    assemble(base, {
      funding: [coin(100_000_000_000n)],
      changeScriptPublicKey: case0.changeSpk,
      feerate: Number(fee) / 16435,
      requiredFunding: 0n,
    })
  const coin = (value: bigint): SpendableUtxo => ({
    outpoint: { transactionId: 'bb'.repeat(32), index: 1 },
    amount: value,
    scriptPublicKey: case0.fundingSpk,
    scriptVersion: 0,
    blockDaaScore: 0n,
    isCoinbase: false,
  })

  it('names a shortfall rather than building something unpayable', () => {
    expect(() =>
      assemble(plan().base, {
        funding: [coin(1000n)],
        changeScriptPublicKey: case0.changeSpk,
        feerate: 1,
        requiredFunding: 0n,
      })
    ).toThrow(InsufficientFundingError)
  })

  it('will not build past the fee ceiling', () => {
    expect(() =>
      assemble(plan().base, {
        funding: [coin(100_000_000_000n)],
        changeScriptPublicKey: case0.changeSpk,
        feerate: 1e9,
        requiredFunding: 0n,
      })
    ).toThrow(FeeCeilingError)
    expect(MAX_FEE_SOMPI).toBe(500_000_000n)
  })

  it('refuses a change output that no input would sign', () => {
    // Through `assemble` this is unreachable: selection refuses an empty funding set first,
    // and `InsufficientFundingError` extends `TxError`, so asserting through it would pass on
    // that refusal and leave the rule untested. The rule lives in `build`, and it is a backstop
    // for an intent that frees value, which this version does not build.
    const base = plan0().base
    const freeing = { ...base, outputs: [{ ...base.outputs[0]!, value: 1n }] }
    expect(() =>
      build(freeing, [], { funding: [], changeScriptPublicKey: case0.changeSpk, feerate: 1, requiredFunding: 0n }, 0n)
    ).toThrow(/no input signs/)
    expect(() =>
      assemble(base, { funding: [], changeScriptPublicKey: case0.changeSpk, feerate: 1, requiredFunding: 0n })
    ).toThrow(InsufficientFundingError)
  })

  it('drops change below dust into the fee rather than making an unspendable output', () => {
    // Fund it so the remainder after the fee lands under the dust floor. No change output is
    // built and the leftover pays the miner instead of sitting where nobody can spend it.
    const withChange = assemble(plan0().base, {
      funding: [coin(100_000_000_000n)],
      changeScriptPublicKey: case0.changeSpk,
      feerate: 1,
      requiredFunding: 0n,
    })
    const scrap = DUST_SOMPI / 4n
    const bare = assemble(plan0().base, {
      funding: [coin(withChange.fee + scrap)], // the deed already funds its own continuation
      changeScriptPublicKey: case0.changeSpk,
      feerate: 1,
      requiredFunding: 0n,
    })
    expect(bare.changeIndex).toBe(-1)
    expect(bare.tx.outputs).toHaveLength(1)
    const totalIn = bare.tx.inputs.reduce((n, i) => n + i.utxo.amount, 0n)
    const totalOut = bare.tx.outputs.reduce((n, o) => n + o.value, 0n)
    // The scrap is part of what leaves, so it is part of what the caller is told the fee is.
    expect(bare.fee).toBe(totalIn - totalOut)
    expect(bare.fee - withChange.fee).toBeLessThan(DUST_SOMPI)
  })

  /**
   * There is no exact fee anywhere in this band: adding the change output raises the fee enough
   * to make the change dust, and dropping it lowers the fee enough to bring the change back.
   * A loop hunting a fixed point leaves the whole band untransferable, and says so with a
   * message about the transaction rather than about the funding.
   */
  it('settles anywhere in the band where the leftover is worth less than dust', () => {
    const at = (funding: bigint) =>
      assemble(plan0().base, {
        funding: [coin(funding)],
        changeScriptPublicKey: case0.changeSpk,
        feerate: 1000,
        requiredFunding: 0n,
      })
    const floor = at(100_000_000_000n).fee
    for (const over of [1n, 1_000n, 43_000n, DUST_SOMPI - 1n]) {
      const assembled = at(floor + over)
      expect(assembled.changeIndex).toBe(-1)
      expect(assembled.fee).toBe(floor + over)
    }
  })

  it('checks the fee ceiling on the first pass as well as on later ones', () => {
    // `build` refuses before the loop ever runs, which the loop's own check cannot cover.
    expect(() => buildAtFee(plan0().base, MAX_FEE_SOMPI + 1n)).toThrow(FeeCeilingError)
  })
})

describe('what the transfer intent refuses before a wallet sees it', () => {
  const case0 = vectors.transferAssembly[0]!
  const good = () => deedOf(case0.name, case0.ownerType, case0.owner, case0.deedOutpoint[0], case0.deedOutpoint[1])
  const build = (deed: Deed, newOwner = case0.newOwner) =>
    transferIntent(registry, registry.deedAbi, deed, case0.newOwnerType, newOwner)

  it('refuses a UTXO that does not pay to the deed this name and owner derive', () => {
    const deed = good()
    deed.utxo.scriptPublicKey = toHex(registry.deed.scriptPublicKey(stateBytes('other', case0.ownerType, case0.owner)))
    expect(() => build(deed)).toThrow(/does not pay to the deed/)
  })

  it('refuses a key that is not blake3 of the name', () => {
    const deed = good()
    deed.state = { ...deed.state, key: 'ab'.repeat(32) }
    expect(() => build(deed)).toThrow(/not blake3/)
  })

  it('refuses a UTXO carrying another covenant id, or none', () => {
    const other = good()
    other.utxo.covenantId = 'ff'.repeat(32)
    expect(() => build(other)).toThrow(/covenant id/)
    const bare = good()
    delete bare.utxo.covenantId
    expect(() => build(bare)).toThrow(/covenant id/)
  })

  it('refuses a deed holding anything but BOND', () => {
    const deed = good()
    deed.utxo.amount = BigInt(registry.params.bond) + 1n
    expect(() => build(deed)).toThrow(/holds exactly/)
  })

  it('refuses the registry’s own covenant id as the new owner', () => {
    expect(() => build(good(), registry.registryCovenantId)).toThrow(/covenant id/)
  })

  /**
   * The read client makes both of these tests, and this package refuses to build on either. A
   * caller branches on `TxError`, and the tag that names the fault rides on `cause`.
   */
  const refusedOwner = (owner: string, tag: string) => {
    expect(() => build(good(), owner)).toThrow(TxError)
    const failed = (() => {
      try {
        build(good(), owner)
      } catch (e) {
        return e as Error
      }
      return undefined
    })()
    expect(failed?.message).toMatch(/^the new owner is refused:/)
    expect(failed?.cause).toBeInstanceOf(SubnameError)
    expect((failed?.cause as SubnameError).tag).toBe(tag)
  }

  it('refuses an owner payload that is not a point on the curve', () => {
    expect(() => build(good(), 'ff'.repeat(32))).toThrow(/secp256k1/)
    refusedOwner('ff'.repeat(32), 'not-a-point')
  })

  /** The one payload every scheme refuses. No key answers for it, and no preimage hashes to it. */
  it('refuses the zero owner', () => {
    expect(() => build(good(), '00'.repeat(32))).toThrow(/32 zero bytes/)
    refusedOwner('00'.repeat(32), 'zero-payload')
  })

  it('refuses a transfer that moves no deed and touches no card', () => {
    expect(() => build(good(), case0.owner)).toThrow(`this transfer of ${dotk.display(case0.name)} mints no card`)
  })
})

/**
 * The three things a node or a wallet reads that nothing else in this suite checks: the body
 * they parse, the id it carries, and the digest a signature over each input commits to. Each
 * one is wrong silently, and each is replayed from the corpus here.
 */
describe('what the node and the wallet are handed', () => {
  const rebuild = (c: (typeof vectors.transferAssembly)[number]) => {
    const deed = deedOf(c.name, c.ownerType, c.owner, c.deedOutpoint[0], c.deedOutpoint[1])
    const plan = transferIntent(registry, registry.deedAbi, deed, c.newOwnerType, c.newOwner)
    const coins: SpendableUtxo[] = c.funding.map(([txid, index, value]) => ({
      outpoint: { transactionId: txid, index },
      amount: BigInt(value),
      scriptPublicKey: c.fundingSpk,
      scriptVersion: 0,
      blockDaaScore: 0n,
      isCoinbase: false,
    }))
    return assemble(plan.base, {
      funding: coins,
      changeScriptPublicKey: c.changeSpk,
      feerate: c.feerate,
      requiredFunding: 0n,
    })
  }

  it.each(vectors.transferAssembly)('$name serializes to the body the corpus holds', (c) => {
    expect(JSON.parse(toSafeJson(rebuild(c).tx))).toEqual(JSON.parse(c.safeJson))
  })

  it.each(vectors.transferAssembly)('$name carries the id the corpus holds', (c) => {
    expect(transactionId(rebuild(c).tx)).toBe(JSON.parse(c.safeJson).id)
  })

  it.each(vectors.transferAssembly)('$name commits to the digests the corpus holds', (c) => {
    const tx = rebuild(c).tx
    for (const { input, schnorr, ecdsa } of c.sighashes) {
      expect(toHex(schnorrSighash(tx, input))).toBe(schnorr)
      expect(toHex(ecdsaSighash(tx, input))).toBe(ecdsa)
    }
  })
})

describe('destinations this package refuses', () => {
  const case0 = vectors.transferAssembly[0]!
  const deed = () => deedOf(case0.name, case0.ownerType, case0.owner, case0.deedOutpoint[0], case0.deedOutpoint[1])
  const to = (ownerType: number, owner: string) => transferIntent(registry, registry.deedAbi, deed(), ownerType, owner)

  it('refuses a script-hash owner, which nothing here could spend again', () => {
    // The covenant allows it as owner self-harm. It is not self-harm when a sender picks it
    // for someone else, and `activate` cannot mint one, so this is the only door to it.
    expect(() => to(OwnerType.ScriptHash, '44'.repeat(32))).toThrow(/cannot be moved again/)
  })

  it('refuses a covenant-id owner for the same reason', () => {
    expect(() => to(OwnerType.CovenantId, '55'.repeat(32))).toThrow(/cannot be moved again/)
  })

  it('still accepts the key-owned schemes', () => {
    expect(() => to(case0.newOwnerType, case0.newOwner)).not.toThrow()
  })
})

describe('a feerate no node would report', () => {
  const tx = emptyTx()

  it('reads a negative or non-finite rate as zero and lets the relay minimum decide', () => {
    const floor = requiredFee(tx, 0)
    expect(requiredFee(tx, -5)).toBe(floor)
    expect(requiredFee(tx, Number.NaN)).toBe(floor)
    expect(requiredFee(tx, Number.POSITIVE_INFINITY)).toBe(floor)
  })

  it('refuses by the ceiling when the rate is large enough to overflow a double', () => {
    // Not a RangeError out of `BigInt`: the fee is what is wrong, and the ceiling says so.
    expect(() => requiredFee(tx, 1e308)).not.toThrow()
    expect(requiredFee(tx, 1e308)).toBeGreaterThan(MAX_FEE_SOMPI)
  })
})

describe('what a wallet is told when it cannot afford the transfer', () => {
  const case0 = vectors.transferAssembly[0]!
  const deed = deedOf(case0.name, case0.ownerType, case0.owner, case0.deedOutpoint[0], case0.deedOutpoint[1])
  const at = (funding: SpendableUtxo[]) =>
    assemble(transferIntent(registry, registry.deedAbi, deed, case0.newOwnerType, case0.newOwner).base, {
      funding,
      changeScriptPublicKey: case0.changeSpk,
      feerate: 1,
      requiredFunding: 0n,
    })

  /**
   * The figure has to be the cost, not the dust threshold the first selection once targeted.
   * A wallet renders it as "top up by this much", and the user comes back and fails again.
   */
  it('names what the transfer costs, not the threshold selection starts from', () => {
    const affordable = at([
      {
        outpoint: { transactionId: 'bb'.repeat(32), index: 1 },
        amount: 100_000_000_000n,
        scriptPublicKey: case0.fundingSpk,
        scriptVersion: 0,
        blockDaaScore: 0n,
        isCoinbase: false,
      },
    ])
    let named: bigint | undefined
    try {
      at([])
    } catch (e) {
      named = (e as InsufficientFundingError).need
    }
    // A floor rather than the exact cost: the seed measures one funding input and no change
    // output, so it lands just under. What matters is that it is the cost and not the dust
    // threshold.
    expect(named).toBeGreaterThan((affordable.fee * 9n) / 10n)
    expect(named).not.toBe(DUST_SOMPI)
  })
})
