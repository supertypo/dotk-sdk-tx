// Funding, change and the fee, on top of a transaction that already holds its protocol seats.
//
// The covenant enforces the order. Protocol inputs and outputs occupy the low indices, and
// funding and change come strictly after. Never reorder them.

import { fromHex } from '@dotk/sdk'
import { FeeCeilingError, InsufficientFundingError, MassCeilingError, TxError } from './errors.js'
import { bytesOf } from './hex.js'
import { massOverrun, massesOf, requiredFee, type Masses } from './mass.js'
import type { SpendableUtxo } from './ports.js'
import { hasPlaceholder } from './script.js'
import { type Tx, type TxInput, utxoEntryOf } from './tx.js'

/**
 * The most this package will build a transaction to pay, in sompi. A constant, never a setting.
 *
 * The feerate estimate is unvalidated and arrives from a node the user did not choose. A
 * SIGHASH_ALL signature commits to the fee. Coin selection takes the largest coin first. Without
 * a ceiling the exposure is that coin, not a fee budget.
 */
export const MAX_FEE_SOMPI = 500_000_000n

/**
 * Below this, a change output is not worth its own existence, and the remainder goes to fee.
 *
 * KIP-9 prices an output at 10^12 / value in storage mass against a cap of 500 000, less a term
 * for the inputs, so an output under 2 000 000 sompi overruns the cap on its own and one a little
 * above it can pass beside a large input. The floor is the output's own figure. Folding the band
 * just above it costs the wallet under 0.02 KAS, where keeping it would need the input term.
 */
export const DUST_SOMPI = 2_000_000n

/**
 * The most change the storage fold below turns into fee. Beside another small output, change
 * above the floor can still overrun the cap, and folding it mends that up to here. Past it the
 * transaction is refused, and another coin is the remedy, because a fold of that size is a fee
 * nobody asked to pay.
 */
export const FOLD_CEILING_SOMPI = 2n * DUST_SOMPI

/** The floor every standalone protocol output must clear, 0.2 KAS. A sweep's one output clears it too. */
export const MIN_OUTPUT_VALUE = 20_000_000n

/** The compute budget a plain schnorr funding spend declares. */
export const FUNDING_COMPUTE_BUDGET = 20

/** A funding signature script: one canonical push of a 65-byte signature. */
export const FUNDING_SIG_SCRIPT_LEN = 66

/** How many passes the fee can take before this module calls the loop broken. */
const FEE_PASSES = 5

export interface AssembleOptions {
  /** Coins to draw on. Selection takes the largest first, which is what bounds the count of inputs. */
  funding: SpendableUtxo[]
  /** Where the remainder goes. Must be an address the wallet can sign for. */
  changeScriptPublicKey: string
  changeScriptVersion?: number | undefined
  /** Sompi per gram, from the node. */
  feerate: number
  /** What the protocol outputs need beyond what the protocol inputs already hold. */
  requiredFunding: bigint
  /**
   * Inputs of `base` whose script carries the placeholder that the wallet's `SIGHASH_ALL`
   * signature fills, beside the protocol seats. The cards a transfer sweeps are these. One
   * commits to every output as a funding input does, so a transaction they alone fund keeps its
   * change. An input with no placeholder is refused, a written signature included.
   */
  signedInputs?: number[] | undefined
}

export interface Assembled {
  tx: Tx
  /** What the miner keeps: the inputs less the outputs, which is what leaves the wallet. */
  fee: bigint
  /**
   * The masses that set the fee, measured on a clone whose unsigned funding inputs carry a
   * placeholder of the length their signature will be. The transaction itself goes to the wallet
   * with those scripts empty, so measuring it directly under-counts.
   */
  mass: Masses
  /** Indices of the inputs the wallet must sign as ordinary coins. */
  fundingInputs: number[]
  /** The change output's index, or -1 when the remainder was too small to keep. */
  changeIndex: number
}

/** Largest first until the picks cover the target. This module sizes the fee for that selection. */
export function selectFunding(utxos: SpendableUtxo[], needed: bigint): SpendableUtxo[] {
  const sorted = [...utxos].sort((a, b) => (a.amount === b.amount ? 0 : a.amount > b.amount ? -1 : 1))
  const picked: SpendableUtxo[] = []
  let total = 0n
  for (const utxo of sorted) {
    if (total >= needed) break
    picked.push(utxo)
    total += utxo.amount
  }
  if (total < needed) throw new InsufficientFundingError(total, needed)
  return picked
}

function fundingInput(utxo: SpendableUtxo, signatureScript: string): TxInput {
  return {
    previousOutpoint: utxo.outpoint,
    signatureScript,
    sequence: 0n,
    computeBudget: FUNDING_COMPUTE_BUDGET,
    utxo: utxoEntryOf(utxo),
  }
}

/**
 * What this shape costs with one funding input, before selection chooses any. Selection is
 * largest-first, so one input is the floor and a transfer the wallet can afford needs at least
 * this much. The loop raises it from there.
 */
function seedFee(base: Tx, options: AssembleOptions): bigint {
  const stand: SpendableUtxo = options.funding[0] ?? {
    outpoint: { transactionId: '00'.repeat(32), index: 0 },
    amount: 0n,
    scriptPublicKey: options.changeScriptPublicKey,
    scriptVersion: options.changeScriptVersion ?? 0,
    blockDaaScore: 0n,
    isCoinbase: false,
  }
  const probe: Tx = { ...base, inputs: [...base.inputs, fundingInput(stand, '')] }
  return requiredFee(measuredClone(probe, [base.inputs.length]), options.feerate)
}

/**
 * The transaction as it will be once signed, for measurement only. A funding input's signature
 * will be a canonical 66-byte push, and standing one in before the wallet signs is what makes
 * the mass, and therefore the fee, the final one.
 */
export function measuredClone(tx: Tx, fundingInputs: number[]): Tx {
  const placeholder = '00'.repeat(FUNDING_SIG_SCRIPT_LEN)
  const funding = new Set(fundingInputs)
  return { ...tx, inputs: tx.inputs.map((i, at) => (funding.has(at) ? { ...i, signatureScript: placeholder } : i)) }
}

/**
 * One pass: the protocol seats plus this funding set, this fee, and whatever change is left.
 *
 * This module exports it and the package does not, so a test can reach the rules below.
 * Selection refuses an empty funding set before `assemble` ever attempts a build. A test that
 * went through `assemble` would pass on that refusal instead.
 */
export function build(base: Tx, picked: SpendableUtxo[], options: AssembleOptions, fee: bigint): Assembled {
  if (fee > MAX_FEE_SOMPI) throw new FeeCeilingError(fee, MAX_FEE_SOMPI)
  // The change script's length is what the mass and so the fee are measured on.
  const changeScript: unknown = options.changeScriptPublicKey
  if (typeof changeScript !== 'string') throw new TxError('changeScriptPublicKey must be a hex string')
  try {
    fromHex(changeScript, 'change script')
  } catch (e) {
    throw new TxError(e instanceof Error ? e.message : String(e), { cause: e })
  }

  const tx: Tx = {
    ...base,
    inputs: [...base.inputs, ...picked.map((u) => fundingInput(u, ''))],
    outputs: [...base.outputs],
  }
  const fundingInputs = picked.map((_, at) => base.inputs.length + at)

  const totalIn = tx.inputs.reduce((n, i) => n + i.utxo.amount, 0n)
  const totalOut = tx.outputs.reduce((n, o) => n + o.value, 0n)
  if (totalIn < totalOut + fee) throw new InsufficientFundingError(totalIn, totalOut + fee)

  // Change below the dust threshold cannot be paid to anyone, so it stays with the miner as part
  // of the fee. Reporting the converged number instead understates what leaves the wallet by up
  // to a threshold's worth.
  const change = totalIn - totalOut - fee
  let paid = change < DUST_SOMPI ? totalIn - totalOut : fee
  let changeIndex = -1
  if (change >= DUST_SOMPI) {
    changeIndex = tx.outputs.length
    tx.outputs.push({
      value: change,
      scriptPublicKey: options.changeScriptPublicKey,
      scriptVersion: options.changeScriptVersion ?? 0,
    })
    // Above the floor, the other outputs can still leave too little of the storage cap for
    // this one. Change that overruns it goes to fee, as change under the floor does, rather
    // than refusing the transaction.
    const overrun = massOverrun(measuredClone(tx, fundingInputs))
    if (overrun?.dimension === 'storage' && change <= FOLD_CEILING_SOMPI) {
      const without = { ...tx, outputs: tx.outputs.slice(0, -1) }
      if (massOverrun(measuredClone(without, fundingInputs))?.dimension !== 'storage') {
        tx.outputs.pop()
        changeIndex = -1
        paid = totalIn - totalOut
      }
    }
  }
  if (paid > MAX_FEE_SOMPI) throw new FeeCeilingError(paid, MAX_FEE_SOMPI)

  // A change output no input signs is a bearer value. Signature scripts are outside the sighash,
  // so anyone who can win the resulting txid conflict rewrites it. One signed funding input fixes
  // every output in place.
  if (changeIndex >= 0 && fundingInputs.length === 0 && (options.signedInputs?.length ?? 0) === 0) {
    throw new TxError('refusing to build a change output that no input signs')
  }
  return { tx, fee: paid, mass: massesOf(measuredClone(tx, fundingInputs)), fundingInputs, changeIndex }
}

/**
 * Assemble with the fee the node's feerate implies.
 *
 * It iterates because the fee decides the change output, that output's value decides the mass,
 * and the mass decides the fee. Near the dust threshold the output's existence decides the mass.
 *
 * It settles on the first pass that pays at least what its own shape requires. Near the threshold
 * there is no fixed point to settle on: adding a change output raises the fee enough to make the
 * change dust, and dropping one lowers the fee enough to bring the change back.
 */
export function assemble(base: Tx, options: AssembleOptions): Assembled {
  const protocolIn = base.inputs.reduce((n, i) => n + i.utxo.amount, 0n)
  const protocolOut = base.outputs.reduce((n, o) => n + o.value, 0n)
  const shortfall = protocolOut > protocolIn ? protocolOut - protocolIn : 0n
  const target = shortfall > options.requiredFunding ? shortfall : options.requiredFunding

  // What the first selection must cover. A target of the dust threshold would name that as the
  // shortfall, which is a fraction of the real cost, so the user tops up to it and fails again.
  // A signed input is one of `base` whose script carries the placeholder the wallet's signature
  // is patched into, which a swept card does. The index is what lets a build keep change with no
  // funding input, so an index that names no such input is refused here rather than counted.
  const signed = options.signedInputs ?? []
  for (const at of signed) {
    const input = Number.isInteger(at) ? base.inputs[at] : undefined
    const script = input && bytesOf(input.signatureScript, 'signature script')
    if (!script || !hasPlaceholder(script)) {
      throw new TxError(`signedInputs names input ${at}, which is not an input that carries a signature placeholder`)
    }
  }
  const seed = seedFee(base, options)
  // Before the selection runs against it, as the loop refuses below. A fee over the ceiling is a
  // refusal about the fee, and a selection reaching it first calls it a shortfall.
  if (seed > MAX_FEE_SOMPI) throw new FeeCeilingError(seed, MAX_FEE_SOMPI)

  const settle = (funding: (fee: bigint) => SpendableUtxo[]): Assembled => {
    let fee = 0n
    let assembled = build(base, funding(seed), options, fee)
    for (let pass = 0; pass < FEE_PASSES; pass++) {
      const next = requiredFee(measuredClone(assembled.tx, assembled.fundingInputs), options.feerate)
      if (assembled.fee >= next) {
        // Measured on the settled transaction and never on a pass inside the loop. The first pass
        // carries the whole funding as change, so refusing on one refuses fundings that converge.
        const overrun = massOverrun(measuredClone(assembled.tx, assembled.fundingInputs))
        if (overrun) throw new MassCeilingError(overrun.dimension, overrun.mass, overrun.cap)
        return assembled
      }
      // Before the selection runs against it. Reported as a shortfall, a fee over the ceiling names
      // the wallet's balance as the problem instead.
      if (next > MAX_FEE_SOMPI) throw new FeeCeilingError(next, MAX_FEE_SOMPI)
      fee = next
      assembled = build(base, funding(fee), options, fee)
    }
    throw new TxError('the fee did not settle: the transaction changed size on every pass')
  }

  // What the seats free beyond what they post, which a release does by its bond and a gap
  // value, pays before the wallet does. The wallet owes the rest, largest coin first. Where it
  // owes nothing, its part is one coin of any size, which signs the change output, or none where
  // a signed input already does. What is owed grows with the fee alone, so a set only ever grows.
  const surplus = protocolIn > protocolOut ? protocolIn - protocolOut : 0n
  const largest = options.funding.reduce<SpendableUtxo | undefined>(
    (best, u) => (best === undefined || u.amount > best.amount ? u : best),
    undefined
  )
  return settle((fee) => {
    const owed = target + fee - surplus
    if (owed > 0n) return selectFunding(options.funding, owed)
    if (largest) return [largest]
    if (signed.length > 0) return []
    throw new InsufficientFundingError(
      0n,
      1n,
      'The value this transaction frees covers its fee, but its change needs one signed funding input of any size. ' +
        'Fund the wallet with any small amount and retry'
    )
  })
}
