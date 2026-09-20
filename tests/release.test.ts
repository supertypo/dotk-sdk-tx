import { Dotk, encodeActiveDeedState, fromHex, names, toHex } from '@dotk/sdk'
import { describe, expect, it } from 'vitest'
import { assemble } from '../src/assemble.js'
import { InsufficientFundingError, TxError } from '../src/errors.js'
import { releaseIntent, type Gap } from '../src/release.js'
import { ecdsaSighash, schnorrSighash } from '../src/sighash.js'
import type { Deed } from '../src/transfer.js'
import { toSafeJson } from '../src/tx.js'
import { vectors } from './vectors.js'

const registry = new Dotk({ api: null, network: 'testnet-10' }).protocol

/**
 * The exit merge, replayed against the transaction the corpus holds for the same inputs.
 *
 * Three seats, three signature scripts and one widened gap, none of which has an error signal
 * short of a node rejection: a wrong entrypoint tag, a wrong compute budget or a gap whose bounds
 * hash to the wrong script all produce a well-formed transaction that consensus refuses. So the
 * corpus is the only thing that can say this package builds the same release the reference
 * implementation does.
 */
describe('the exit merge agrees with the corpus', () => {
  const gapOf = (
    c: { lo: string; hi: string; outpoint: [string, number]; spk: string },
    amount: bigint,
    covenantId: string
  ): Gap => ({
    lo: c.lo,
    hi: c.hi,
    outpoint: { transactionId: c.outpoint[0], index: c.outpoint[1] },
    amount,
    scriptPublicKey: c.spk,
    scriptVersion: 0,
    blockDaaScore: 0n,
    isCoinbase: false,
    covenantId,
  })

  it.each(vectors.releaseAssembly.map((c) => [c.name, c] as const))('releases %s', (_name, c) => {
    const gapValue = BigInt(registry.params.gap_value)
    const deed: Deed = {
      state: { key: toHexKey(c.name), ownerType: c.ownerType, owner: c.owner, name: c.name },
      utxo: {
        outpoint: { transactionId: c.deedOutpoint[0], index: c.deedOutpoint[1] },
        amount: BigInt(registry.params.bond),
        scriptPublicKey: '',
        scriptVersion: 0,
        blockDaaScore: 0n,
        isCoinbase: false,
        covenantId: registry.registryCovenantId,
      },
    }
    // The deed's script is what its own state derives; filling it from the corpus would let a
    // wrong derivation here agree with itself.
    deed.utxo.scriptPublicKey = deedSpk(deed)

    const pred = gapOf(c.pred, gapValue, registry.registryCovenantId)
    const succ = gapOf(c.succ, gapValue, registry.registryCovenantId)
    const plan = releaseIntent(registry, deed, pred, succ)

    expect(plan.base.inputs.map((i) => i.signatureScript)).toEqual(c.sigScripts)
    expect(plan.base.outputs[0]!.scriptPublicKey).toBe(c.mergedSpk)
    expect(plan.released).toBe(BigInt(c.released))
    expect(plan.ownerSigInputs).toEqual([1])

    const assembled = assemble(plan.base, {
      funding: c.funding.map(([transactionId, index, amount]) => ({
        outpoint: { transactionId, index },
        amount: BigInt(amount),
        scriptPublicKey: c.fundingSpk,
        scriptVersion: 0,
        blockDaaScore: 0n,
        isCoinbase: false,
      })),
      changeScriptPublicKey: c.changeSpk,
      feerate: c.feerate,
      requiredFunding: 0n,
    })
    expect(assembled.mass.compute).toBe(BigInt(c.computeMass))
    expect(assembled.mass.transient).toBe(BigInt(c.transientMass))
    expect(assembled.mass.fee).toBe(BigInt(c.feeMass))
    expect(assembled.fee).toBe(BigInt(c.fee))
    expect(JSON.parse(toSafeJson(assembled.tx))).toEqual(JSON.parse(c.safeJson))

    // The digest the owner's seat commits to, in both flavours. A wrong one is a well-formed
    // signature that satisfies nothing, and the node's refusal is the first sign of it.
    for (const { input, schnorr, ecdsa } of c.sighashes) {
      expect(toHex(schnorrSighash(assembled.tx, input))).toBe(schnorr)
      expect(toHex(ecdsaSighash(assembled.tx, input))).toBe(ecdsa)
    }
  })
})

/**
 * A release frees more than its fee, and still needs one signed funding input, because the
 * change output is bound by nothing else this package counts. That input can be any size.
 */
describe('a release from a wallet that cannot cover the fee', () => {
  const c = vectors.releaseAssembly[0]!
  const gapValue = BigInt(registry.params.gap_value)
  const gapOf = (g: { lo: string; hi: string; outpoint: [string, number]; spk: string }): Gap => ({
    lo: g.lo,
    hi: g.hi,
    outpoint: { transactionId: g.outpoint[0], index: g.outpoint[1] },
    amount: gapValue,
    scriptPublicKey: g.spk,
    scriptVersion: 0,
    blockDaaScore: 0n,
    isCoinbase: false,
    covenantId: registry.registryCovenantId,
  })
  const deed: Deed = {
    state: { key: toHexKey(c.name), ownerType: c.ownerType, owner: c.owner, name: c.name },
    utxo: {
      outpoint: { transactionId: c.deedOutpoint[0], index: c.deedOutpoint[1] },
      amount: BigInt(registry.params.bond),
      scriptPublicKey: '',
      scriptVersion: 0,
      blockDaaScore: 0n,
      isCoinbase: false,
      covenantId: registry.registryCovenantId,
    },
  }
  deed.utxo.scriptPublicKey = deedSpk(deed)
  const plan = releaseIntent(registry, deed, gapOf(c.pred), gapOf(c.succ))
  const tiny = {
    outpoint: { transactionId: 'bb'.repeat(32), index: 1 },
    amount: 1_000n,
    scriptPublicKey: c.fundingSpk,
    scriptVersion: 0,
    blockDaaScore: 0n,
    isCoinbase: false,
  }
  const options = { changeScriptPublicKey: c.changeSpk, feerate: c.feerate, requiredFunding: 0n }

  it('refuses an empty wallet, and says that any coin will do', () => {
    const e = (() => {
      try {
        assemble(plan.base, { ...options, funding: [] })
      } catch (e) {
        return e
      }
      return undefined
    })()
    expect(e).toBeInstanceOf(InsufficientFundingError)
    expect((e as InsufficientFundingError).have).toBe(0n)
    expect((e as Error).message).toMatch(/one signed funding input of any size/)
  })

  it('takes a coin smaller than the fee, since the value freed pays it', () => {
    const assembled = assemble(plan.base, { ...options, funding: [tiny] })
    expect(assembled.fundingInputs).toEqual([3])
    const totalIn = assembled.tx.inputs.reduce((n, i) => n + i.utxo.amount, 0n)
    const totalOut = assembled.tx.outputs.reduce((n, o) => n + o.value, 0n)
    expect(totalIn - totalOut).toBe(assembled.fee)
    expect(assembled.fee).toBeGreaterThan(tiny.amount)
    expect(assembled.tx.outputs[assembled.changeIndex]!.value).toBe(plan.released + tiny.amount - assembled.fee)
  })

  /** The seats pay the fee, so the wallet's part is one coin, whatever else it holds. */
  it.each([
    ['400 coins of 30 000 sompi', 400, 30_000n],
    ['2000 coins of 6 000 sompi', 2000, 6_000n],
    ['30 coins of 400 000 sompi', 30, 400_000n],
    ['20 coins of 900 000 sompi', 20, 900_000n],
    ['50 coins of 500 000 sompi', 50, 500_000n],
    ['3 coins of 10 KAS', 3, 1_000_000_000n],
  ])('pays the one-coin fee from a wallet of %s', (_what, count, amount) => {
    const funding = Array.from({ length: count }, (_, i) => ({
      ...tiny,
      outpoint: { transactionId: 'bb'.repeat(32), index: i },
      amount,
    }))
    const assembled = assemble(plan.base, { ...options, funding })
    expect(assembled.fundingInputs).toEqual([3])
    expect(assembled.fee).toBe(BigInt(c.fee))
    expect(assembled.tx.outputs[assembled.changeIndex]!.value).toBe(plan.released + amount - assembled.fee)
  })

  it('refuses a signed input that carries no signature placeholder, rather than counting it', () => {
    const unsigned = { ...plan.base, inputs: [...plan.base.inputs, { ...plan.base.inputs[0]!, signatureScript: '' }] }
    // Seat 0 is a gap that consents by presence and carries no placeholder. Seat 1 is the owner's.
    for (const signedInputs of [[0], [3], [1, 9], [-1], [1.5]]) {
      expect(() => assemble(unsigned, { ...options, funding: [], signedInputs })).toThrow(/signedInputs names input/)
    }
    expect(assemble(unsigned, { ...options, funding: [], signedInputs: [1] }).fundingInputs).toEqual([])
    // A script that is not hex is refused as this package's own error, never as a bare TypeError.
    const odd = { ...plan.base, inputs: [...plan.base.inputs, { ...plan.base.inputs[0]!, signatureScript: 'zz' }] }
    const e = (() => {
      try {
        assemble(odd, { ...options, funding: [], signedInputs: [3] })
      } catch (e) {
        return e
      }
      return undefined
    })()
    expect(e).toBeInstanceOf(TxError)
    expect((e as Error).message).toMatch(/signature script/)
  })

  it('needs no coin at all when an input the wallet signs is already there', () => {
    const assembled = assemble(plan.base, { ...options, funding: [], signedInputs: plan.ownerSigInputs })
    expect(assembled.fundingInputs).toEqual([])
    expect(assembled.tx.outputs[assembled.changeIndex]!.value).toBe(plan.released - assembled.fee)
  })
})

function toHexKey(name: string): string {
  return toHex(names.keyBytesOf(name))
}

/** The script a deed's own state derives, so a wrong derivation here cannot agree with itself. */
function deedSpk(deed: Deed): string {
  const state = encodeActiveDeedState(
    fromHex(deed.state.key),
    deed.state.ownerType,
    fromHex(deed.state.owner),
    names.paddedName(deed.state.name)
  )
  return toHex(registry.deed.scriptPublicKey(state))
}
