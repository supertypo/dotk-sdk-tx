// The places this package restates something the reference implementation decides. Each is a second copy of a
// rule, and each is held to the first by the corpus rather than by a reading of it.

import { Dotk, encodeGapState, fromHex, hex32, ownerAddress, prefixFor, toHex } from '@dotk/sdk'
import { describe, expect, it } from 'vitest'
import { MassCeilingError } from '../src/errors.js'
import { classify } from '../src/reject.js'
import { scriptPublicKeyOf } from '../src/registrar.js'
import { deedAddressOfState, stateBytes } from '../src/transfer.js'
import {
  COINBASE_MATURITY,
  MASS_LIMITS,
  massesOf,
  massOverrun,
  STORAGE_MASS_PARAMETER,
  storageMassOf,
  TRANSIENT_COFACTOR,
} from '../src/mass.js'
import { emptyTx } from '../src/tx.js'
import { vectors } from './vectors.js'

const dotk = new Dotk({ api: null, network: 'testnet-10' })

describe('the registration fee', () => {
  it.each(vectors.feeForName)('$name costs $fee', ({ name, fee }) => {
    expect(dotk.quote(name).fee).toBe(fee)
  })

  it('prices the whole registration from the deployment', () => {
    const p = dotk.protocol.params
    const quote = dotk.quote('kaspa')
    expect(quote).toEqual({
      name: 'kaspa',
      fee: p.fee_5plus,
      bond: p.bond,
      deposit: p.deposit,
      gapValue: p.gap_value,
      lockedValue: p.bond + p.gap_value,
      totalToFund: p.bond + p.gap_value + Math.max(p.fee_5plus, p.deposit),
    })
  })
})

describe('reading a refusal', () => {
  it.each(vectors.rejection)('$verdict: $message', ({ message, verdict }) => {
    expect(classify(message)).toBe(verdict ?? 'unknown')
  })

  it('reads the two that mention a UTXO entry apart', () => {
    // One is the mempool saying it has not seen the parent yet, the other is consensus saying
    // it never can. Retrying the second for ever is exactly what this distinction prevents.
    expect(classify('transaction 6f0a is lacking a matching UTXO entry')).toBe('transient')
    expect(classify('it is impossible to have a matching UTXO entry')).toBe('fatal')
  })
})

describe('where change is paid', () => {
  it.each(vectors.changeScript)('$address', ({ address, spk }) => {
    expect(toHex(scriptPublicKeyOf(address, dotk))).toBe(spk)
  })
})

/**
 * The reference implementation reads the transient cofactor from the consensus params, and this package has none to
 * read and states the result as a constant. Nothing else can tell if that constant drifts: every
 * transfer this package builds is compute-dominated, so `max()` returns the same either way, and
 * a transaction only 15% larger would take the other branch.
 */
describe('the constants consensus owns', () => {
  it('are the ones consensus derives, on every network the fee model runs on', () => {
    expect(vectors.consensus.length).toBeGreaterThan(0)
    for (const c of vectors.consensus) {
      expect(TRANSIENT_COFACTOR).toBe(c.transientCofactor)
      expect(COINBASE_MATURITY).toBe(BigInt(c.coinbaseMaturity))
      // The three ceilings and KIP-9's `C`. This package has no pin to read and writes them out,
      // so without these two lines a consensus bump moves the limits and nothing here notices,
      // silently, and in the loose direction if they rise.
      expect(MASS_LIMITS.compute).toBe(BigInt(c.massLimits.compute))
      expect(MASS_LIMITS.storage).toBe(BigInt(c.massLimits.storage))
      expect(MASS_LIMITS.transient).toBe(BigInt(c.massLimits.transient))
      expect(STORAGE_MASS_PARAMETER).toBe(BigInt(c.storageMassParameter))
    }
  })

  it('decides the fee when a transaction is transient-dominated', () => {
    // Compute grows with the script bytes, transient with the whole body, so a large payload
    // puts the fee on the branch the constant governs.
    const tx = { ...emptyTx(), payload: 'ab'.repeat(4000) }
    const masses = massesOf(tx)
    expect(masses.transient).toBeGreaterThan(masses.compute)
    expect(masses.fee).toBe(BigInt(Math.ceil(Number(masses.transient) * TRANSIENT_COFACTOR)))
  })
})

/**
 * KIP-9 storage mass, replayed against the answers kaspa's own `MassCalculator` gives.
 *
 * This package ships no wasm, so the formula is restated here and this is the only thing holding
 * the restatement to the pin. The rows are cells rather than transactions on purpose: no assembly
 * either builder makes crosses a 100-byte storage unit, so the plurality edge and the relaxed
 * branch are only reachable from rows written for them.
 */
describe('KIP-9 storage mass', () => {
  const cellsToTx = (c: (typeof vectors.storageMass)[number]) => ({
    ...emptyTx(),
    inputs: c.ins.map((cell, i) => ({
      previousOutpoint: { transactionId: '00'.repeat(32), index: i },
      signatureScript: '',
      sequence: 0n,
      computeBudget: 0,
      utxo: {
        amount: BigInt(cell.amount),
        scriptPublicKey: cell.spk,
        scriptVersion: 0,
        blockDaaScore: 0n,
        isCoinbase: false,
        ...(cell.covenant ? { covenantId: 'aa'.repeat(32) } : {}),
      },
    })),
    outputs: c.outs.map((cell) => ({
      value: BigInt(cell.amount),
      scriptPublicKey: cell.spk,
      scriptVersion: 0,
      ...(cell.covenant ? { covenant: { authorizingInput: 0, covenantId: 'aa'.repeat(32) } } : {}),
    })),
  })

  it('has rows for the shapes an assembly never reaches', () => {
    expect(vectors.storageMass.length).toBeGreaterThan(0)
  })

  it.each(vectors.storageMass.map((c) => [c.why, c] as const))('%s', (_why, c) => {
    const got = storageMassOf(cellsToTx(c))
    expect(got).toBe(c.mass === null ? null : BigInt(c.mass))
  })
})

/**
 * Where a name lands and where a gap sits, against the corpus rather than against this package's
 * own derivation. A fake node that serves a deed at a drifted address makes every registrar test
 * agree with the drift, so these rows are what pins the derivation.
 */
describe('the addresses the corpus pins', () => {
  // The rows belong to the corpus's own registry. A row for another network carries that
  // network's prefix over this registry's templates, which is what the reference computed.
  const corpusDotk = new Dotk({ api: null, network: vectors.manifest.network })
  const registry = corpusDotk.protocol
  const deeds = vectors.deedAddress
  const gaps = vectors.gapAddress
  const owners = vectors.owner

  it('has rows to replay', () => {
    expect(deeds.length).toBeGreaterThan(0)
    expect(gaps.length).toBeGreaterThan(0)
    expect(owners.length).toBeGreaterThan(0)
  })

  it.each(deeds)('derives the deed address of $name under scheme $ownerType on $network', (row) => {
    const state = { key: corpusDotk.keyOf(row.name), ownerType: row.ownerType, owner: row.owner, name: row.name }
    expect(toHex(stateBytes(state))).toBe(row.state)
    expect(registry.deed.address(prefixFor(row.network), stateBytes(state)).text).toBe(row.address)
    if (row.network === vectors.manifest.network) expect(deedAddressOfState(registry, state)).toBe(row.address)
  })

  it.each(gaps)('derives the gap address for $lo..$hi on $network', (row) => {
    const state = encodeGapState(fromHex(row.lo), fromHex(row.hi))
    expect(toHex(state)).toBe(row.state)
    expect(registry.gap.address(prefixFor(row.network), state).text).toBe(row.address)
  })

  it.each(owners)('renders the owner pair of scheme $ownerType on $network as its address', (row) => {
    const address = ownerAddress(prefixFor(row.network), row.ownerType, hex32(row.owner, 'owner')) ?? null
    expect(address).toBe(row.address)
  })
})

/** A covenant is a non-empty id. A null, an empty string or anything else counts as none, whatever a caller passed. */
describe('a covenant id as a caller may spell it', () => {
  it('counts only a non-empty text as a covenant', () => {
    const base = emptyTx()
    const input = (covenantId: unknown) => ({
      previousOutpoint: { transactionId: '00'.repeat(32), index: 0 },
      signatureScript: '',
      sequence: 0n,
      computeBudget: 0,
      utxo: {
        amount: 10_000_000_000n,
        scriptPublicKey: '20' + '11'.repeat(32) + 'ac',
        scriptVersion: 0,
        blockDaaScore: 0n,
        isCoinbase: false,
        covenantId: covenantId as string | undefined,
      },
    })
    const output = { value: 9_000_000_000n, scriptPublicKey: '20' + '22'.repeat(32) + 'ac', scriptVersion: 0 }
    const without = storageMassOf({ ...base, inputs: [input(undefined)], outputs: [output] })
    for (const none of [null, '', 7]) {
      expect(storageMassOf({ ...base, inputs: [input(none)], outputs: [output] }), String(none)).toBe(without)
    }
    expect(storageMassOf({ ...base, inputs: [input('aa'.repeat(32))], outputs: [output] })).not.toBe(without)
  })
})

describe('the mass overrun', () => {
  it('names the dimension over its cap, and null under every cap', () => {
    const base = emptyTx()
    const input = (amount: bigint, index: number) => ({
      previousOutpoint: { transactionId: '00'.repeat(32), index },
      signatureScript: '',
      sequence: 0n,
      computeBudget: 0,
      utxo: {
        amount,
        scriptPublicKey: '20' + '11'.repeat(32) + 'ac',
        scriptVersion: 0,
        blockDaaScore: 0n,
        isCoinbase: false,
      },
    })
    const output = (value: bigint) => ({ value, scriptPublicKey: '20' + '22'.repeat(32) + 'ac', scriptVersion: 0 })
    expect(massOverrun({ ...base, inputs: [input(10_000_000_000n, 0)], outputs: [output(9_000_000_000n)] })).toBeNull()
    const dust = massOverrun({
      ...base,
      inputs: [input(10_000_000_000n, 0)],
      outputs: [output(1_000n), output(9_000_000_000n)],
    })
    expect(dust?.dimension).toBe('storage')
    expect(dust!.mass).not.toBeNull()
    expect(dust!.mass!).toBeGreaterThan(dust!.cap)
    // A value the formula declines to price answers null, which the error names as unmeasured.
    const unpriced = massOverrun({ ...base, inputs: [input(10_000_000_000n, 0)], outputs: [output(0n)] })
    expect(unpriced).toEqual({ dimension: 'storage', mass: null, cap: MASS_LIMITS.storage })
    expect(new MassCeilingError('storage', null, MASS_LIMITS.storage).message).toMatch(/cannot be measured/)
    const many = massOverrun({
      ...base,
      inputs: Array.from({ length: 5000 }, (_, i) => input(10_000_000n, i)),
      outputs: [output(40_000_000_000n)],
    })
    expect(many).not.toBeNull()
    expect(many!.mass).not.toBeNull()
    expect(many!.mass!).toBeGreaterThan(many!.cap)
  })
})
