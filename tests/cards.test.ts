import {
  CARD_VALUE,
  Dotk,
  OwnerType,
  type RecordValue,
  type Records,
  decodeRecords,
  encodeActiveDeedState,
  fromHex,
  hex32,
  toHex,
} from '@dotk/sdk'
import { mergeRecords } from '../src/records.js'
import { describe, expect, it } from 'vitest'
import { assemble, DUST_SOMPI, MIN_OUTPUT_VALUE } from '../src/assemble.js'
import { toRpcTransaction } from '../src/adapters.js'
import { assembleSweep, cardMint, withCards, type CardPlan, type CardSweep } from '../src/cards.js'
import { FeeCeilingError, InsufficientFundingError, MassCeilingError, TxError } from '../src/errors.js'
import type { SpendableUtxo } from '../src/ports.js'
import { ecdsaSighash, schnorrSighash, transactionId } from '../src/sighash.js'
import { transferIntent, type Deed } from '../src/transfer.js'
import { emptyTx, toSafeJson } from '../src/tx.js'
import { encodeRequest } from '../src/wrpc.js'
import { vectors } from './vectors.js'

const dotk = new Dotk({ api: null, network: 'testnet-10' })
const registry = dotk.protocol

function stateBytes(name: string, ownerType: number, owner: string): Uint8Array {
  const padded = new Uint8Array(32)
  padded.set(new TextEncoder().encode(name))
  return encodeActiveDeedState(fromHex(dotk.keyOf(name)), ownerType, hex32(owner, 'owner'), padded)
}

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

type Case = (typeof vectors.cardAssembly)[number]

/** The plan the vector describes, its mint for the vector's key and its sweeps as the node holds them. */
function planOf(c: Case): CardPlan {
  const key = fromHex(dotk.keyOf(c.name))
  const plan: CardPlan = {
    sweep: c.cards.sweep.map((s): CardSweep => ({
      outpoint: { transactionId: s.outpoint[0], index: s.outpoint[1] },
      value: BigInt(s.value),
      state: {
        key,
        records: hex32(s.recordsHash, 'records'),
        spenderType: s.spenderType,
        spender: hex32(s.spender, 'spender'),
      },
    })),
  }
  const m = c.cards.mint
  if (m) plan.mint = cardMint(key, m.records, m.spenderType, hex32(m.spender, 'spender'))
  return plan
}

function rebuild(c: Case) {
  const deed = deedOf(c.name, c.ownerType, c.owner, c.deedOutpoint[0], c.deedOutpoint[1])
  const plan = transferIntent(registry, registry.deedAbi, deed, c.newOwnerType, c.newOwner, planOf(c))
  const coins: SpendableUtxo[] = c.funding.map(([txid, index, value]) => ({
    outpoint: { transactionId: txid, index },
    amount: BigInt(value),
    scriptPublicKey: c.fundingSpk,
    scriptVersion: 0,
    blockDaaScore: 0n,
    isCoinbase: false,
  }))
  return {
    plan,
    assembled: assemble(plan.base, {
      funding: coins,
      changeScriptPublicKey: c.changeSpk,
      feerate: c.feerate,
      requiredFunding: 0n,
      signedInputs: plan.cardInputs,
    }),
  }
}

/**
 * A transfer carrying cards, replayed from the corpus: the seats it adds, the payload it
 * announces the mint in, and the fee the lot costs.
 */
describe('a transfer carrying cards', () => {
  it.each(vectors.cardAssembly)(
    '$name: deed $deedOutpoint.0, sweeping $cards.sweep.length, costs what the corpus charged',
    (c) => {
      const { assembled } = rebuild(c)
      expect(assembled.mass.size).toBe(BigInt(c.size))
      expect(assembled.mass.compute).toBe(BigInt(c.computeMass))
      expect(assembled.mass.transient).toBe(BigInt(c.transientMass))
      expect(assembled.mass.fee).toBe(BigInt(c.feeMass))
      expect(assembled.fee).toBe(BigInt(c.fee))
      expect(assembled.tx.outputs[assembled.changeIndex]!.value).toBe(BigInt(c.changeValue))
    }
  )

  it.each(vectors.cardAssembly)('$name serializes to the body the corpus holds', (c) => {
    expect(JSON.parse(toSafeJson(rebuild(c).assembled.tx))).toEqual(JSON.parse(c.safeJson))
  })

  /** The only vectors with a payload, so the only place the rpc shape's `payload` is pinned. */
  it.each(vectors.cardAssembly)('$name serializes as the corpus holds it for the rpc', (c) => {
    const sent = JSON.parse(encodeRequest(1, 'submitTransaction', toRpcTransaction(rebuild(c).assembled.tx))).params
    expect(sent).toEqual(JSON.parse(c.rpcJson))
  })

  it.each(vectors.cardAssembly)('$name carries the id the corpus holds', (c) => {
    expect(transactionId(rebuild(c).assembled.tx)).toBe(JSON.parse(c.safeJson).id)
  })

  it.each(vectors.cardAssembly)('$name commits to the digests the corpus holds', (c) => {
    const tx = rebuild(c).assembled.tx
    for (const { input, schnorr, ecdsa } of c.sighashes) {
      expect(toHex(schnorrSighash(tx, input))).toBe(schnorr)
      expect(toHex(ecdsaSighash(tx, input))).toBe(ecdsa)
    }
  })

  it('seats the sweeps after the deed and the mint at output 1', () => {
    const c = vectors.cardAssembly.find((v) => v.cards.mint && v.cards.sweep.length > 0)!
    const { plan, assembled } = rebuild(c)
    expect(plan.cardInputs).toEqual([1])
    expect(assembled.fundingInputs).toEqual([2])
    expect(assembled.tx.outputs.map((o) => o.value)).toEqual([
      BigInt(registry.params.bond),
      BigInt(CARD_VALUE),
      BigInt(c.changeValue),
    ])
    expect(assembled.tx.outputs[1]!.covenant).toBeUndefined()
    // Rule 2 is an outpoint comparison, so the index the mint lands at is the whole claim.
    expect(plan.base.outputs).toHaveLength(2)
    expect(plan.base.outputs[1]!.value).toBe(BigInt(CARD_VALUE))
  })

  it('carries an opaque value through a mint byte for byte', () => {
    // {x: 42, url: "http://a/"} in the encoder's own form: the integer is a value this reader does
    // not recognise, and a mint built from the decoded set writes the same blob back.
    const blob = fromHex('a26178182a6375726c69687474703a2f2f612f')
    const mint = cardMint(fromHex('11'.repeat(32)), decodeRecords(blob), OwnerType.Pubkey, fromHex('22'.repeat(32)))
    expect(toHex(mint.blob)).toBe(toHex(blob))
  })

  it('carries no payload when it mints nothing', () => {
    const c = vectors.cardAssembly.find((v) => !v.cards.mint)!
    expect(rebuild(c).assembled.tx.payload).toBe('')
  })
})

describe('what a card refuses', () => {
  const c = vectors.cardAssembly[0]!
  const deed = () => deedOf(c.name, c.ownerType, c.owner, c.deedOutpoint[0], c.deedOutpoint[1])
  const mint = (name: string) =>
    cardMint(fromHex(dotk.keyOf(name)), { url: 'x' }, c.newOwnerType, hex32(c.newOwner, 'spender'))

  it('a transfer to the same owner, when it carries no card', () => {
    // Held by the vector's recipient, whose key is on the curve, so the owner check is reached.
    const held = () => deedOf(c.name, c.newOwnerType, c.newOwner, c.deedOutpoint[0], c.deedOutpoint[1])
    expect(() => transferIntent(registry, registry.deedAbi, held(), c.newOwnerType, c.newOwner)).toThrow(
      `this transfer of ${dotk.display(c.name)} mints no card`
    )
    const plan = transferIntent(registry, registry.deedAbi, held(), c.newOwnerType, c.newOwner, {
      mint: mint(c.name),
      sweep: [],
    })
    expect(plan.base.outputs).toHaveLength(2)
    expect(plan.next).toEqual(held().state)
  })

  it('a mint for another name', () => {
    expect(() =>
      transferIntent(registry, registry.deedAbi, deed(), c.newOwnerType, c.newOwner, {
        mint: mint('other'),
        sweep: [],
      })
    ).toThrow(/for this name/)
  })

  it('a mint outside a transfer', () => {
    expect(() => withCards(emptyTx(), { mint: mint(c.name), sweep: [] })).toThrow(/transfer/)
  })

  /** Output 1 has to be free, and only a transfer's single continuation leaves it so. */
  it('a mint on a transaction that pins an output of its own beside the continuation', () => {
    const base = transferIntent(registry, registry.deedAbi, deed(), c.newOwnerType, c.newOwner).base
    const two = { ...base, outputs: [...base.outputs, base.outputs[0]!] }
    expect(() => withCards(two, { mint: mint(c.name), sweep: [] })).toThrow(/output 1/)
  })

  /** A release spends three inputs and pins one output, so it passes an output count alone. */
  it('a mint on a transaction that spends more than the one deed input', () => {
    const base = transferIntent(registry, registry.deedAbi, deed(), c.newOwnerType, c.newOwner).base
    const three = { ...base, inputs: [base.inputs[0]!, base.inputs[0]!, base.inputs[0]!] }
    expect(() => withCards(three, { mint: mint(c.name), sweep: [] })).toThrow(/spends one input/)
  })

  it('a mint for a covenant-id owner', () => {
    expect(() => cardMint(fromHex(dotk.keyOf(c.name)), {}, 4, hex32(c.newOwner, 'spender'))).toThrow()
  })
})

/** The merge reads whatever a JS caller hands in, and a shape that is no record value is no match rather than a crash. */
describe('the merge under a JS caller', () => {
  it('reads a value that is not a record value as a mismatch', () => {
    const live = { url: { opaque: 'ab' } } as Records
    for (const given of [null, 'ab', {}, { opaque: 5 }, [], 42]) {
      const merged = mergeRecords({ url: given as unknown as RecordValue }, live)
      expect(merged.records['url']).toBe(given)
    }
    expect(mergeRecords({ url: { opaque: 'AB' } }, live).records['url']).toEqual({ opaque: 'AB' })
  })
})

describe('a standalone sweep', () => {
  const c = vectors.cardAssembly.find((v) => v.cards.sweep.length > 0)!
  const sweep = () => planOf(c).sweep

  it('pays the cards to the destination less the fee, signed by the cards alone', () => {
    const swept = assembleSweep(sweep(), c.changeSpk, 1)
    expect(swept.tx.inputs).toHaveLength(1)
    expect(swept.tx.inputs[0]!.previousOutpoint).toEqual({ transactionId: c.cards.sweep[0]!.outpoint[0], index: 1 })
    expect(swept.tx.outputs).toHaveLength(1)
    expect(swept.tx.outputs[0]!.value + swept.fee).toBe(BigInt(CARD_VALUE))
    expect(swept.fee).toBeGreaterThan(0n)
    // The one output is the destination, so nothing in a sweep is change.
    expect(swept.fundingInputs).toEqual([])
    expect(swept.changeIndex).toBe(-1)
    expect(swept.tx.payload).toBe('')
  })

  it('refuses nothing to sweep, a fee over the ceiling, and a card that cannot pay its own fee', () => {
    expect(() => assembleSweep([], c.changeSpk, 1)).toThrow(TxError)
    // The compute cap bounds a sweep as it bounds every transaction, so many cards refuse before signing.
    const many = Array.from({ length: 300 }, () => sweep()[0]!)
    expect(() => assembleSweep(many, c.changeSpk, 1)).toThrow(MassCeilingError)
    expect(() => assembleSweep(sweep(), c.changeSpk, 1e9)).toThrow(FeeCeilingError)
    expect(() => assembleSweep(sweep(), c.changeSpk, 1e5)).toThrow(InsufficientFundingError)
  })

  /** The floor is the protocol's: a fee that leaves the output between dust and 0.2 KAS is refused. */
  it('refuses a sweep whose output would fall under the floor every protocol output clears', () => {
    // The fee is linear in the feerate once it clears the relay minimum: one sompi per gram per unit.
    const perUnit = assembleSweep(sweep(), c.changeSpk, 1000).fee / 1000n
    const feerate = Math.ceil(Number(BigInt(CARD_VALUE) - MIN_OUTPUT_VALUE + DUST_SOMPI) / Number(perUnit))
    const fee = perUnit * BigInt(feerate)
    expect(fee).toBeGreaterThan(BigInt(CARD_VALUE) - MIN_OUTPUT_VALUE)
    expect(fee).toBeLessThan(BigInt(CARD_VALUE) - DUST_SOMPI)
    expect(() => assembleSweep(sweep(), c.changeSpk, feerate)).toThrow(InsufficientFundingError)
  })
})
