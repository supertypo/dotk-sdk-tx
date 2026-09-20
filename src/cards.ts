// Cards as a transaction carries them: the card minted at output 1 beside a transfer's
// continuation, and the inputs that sweep older cards back. Both sit in the tail the covenants
// never read, after the protocol seats and before funding and change, so nothing here can move a
// deed or a gap.

import {
  CARD_VALUE,
  type CardMint,
  type CardState,
  type Records,
  cardScriptPublicKey,
  cardState,
  encodeCardPayload,
  encodeRecords,
  recordsOf,
  sweepSigScript,
  toHex,
} from '@dotk/sdk'
import { FUNDING_COMPUTE_BUDGET, MAX_FEE_SOMPI, MIN_OUTPUT_VALUE, type Assembled } from './assemble.js'
import { FeeCeilingError, InsufficientFundingError, MassCeilingError, TxError } from './errors.js'
import { bytesOf } from './hex.js'
import { massOverrun, massesOf, requiredFee } from './mass.js'
import { emptyTx, type Outpoint, type Tx, type TxInput } from './tx.js'

/** A card the node holds, ready to be swept. */
export interface CardSweep {
  outpoint: Outpoint
  /** In sompi. `CARD_VALUE` for a card any shipped builder minted. */
  value: bigint
  state: CardState
}

/** The cards a transfer carries: the card to mint at output 1, and the inputs to sweep. */
export interface CardPlan {
  mint?: CardMint | undefined
  sweep: CardSweep[]
  /**
   * Whether this transfer retires a live card that it does not sweep. A card is pinned to the
   * deed's outpoint, so moving the deed ends the card whoever seated it. Such a transfer does
   * something even where it mints and sweeps nothing.
   */
  retires?: boolean | undefined
}

/** The card a transfer mints for a name's next owner, with these records. */
export function cardMint(key: Uint8Array, records: Records, spenderType: number, spender: Uint8Array): CardMint {
  const blob = encodeRecords(records)
  return { state: cardState(key, recordsOf(blob), spenderType, spender), blob }
}

/** The input a swept card becomes: its signature script carries the placeholder the spender signs into. */
export function cardInput(card: CardSweep): TxInput {
  return {
    previousOutpoint: card.outpoint,
    signatureScript: toHex(sweepSigScript(card.state)),
    sequence: 0n,
    computeBudget: FUNDING_COMPUTE_BUDGET,
    utxo: {
      amount: card.value,
      scriptPublicKey: toHex(cardScriptPublicKey(card.state)),
      scriptVersion: 0,
      blockDaaScore: 0n,
      isCoinbase: false,
    },
  }
}

/**
 * A transfer's protocol seats plus its cards, in the one order the protocol fixes. Sweep inputs
 * come after the deed, the mint after the continuation, and the payload announces the mint.
 * `assemble` appends funding and change after these and never reorders them.
 *
 * A card is pinned to output 1 of the deed's transaction, so the base transaction must leave
 * that index free. A transfer's single continuation leaves it free, and no other entrypoint's
 * outputs do.
 */
export function withCards(base: Tx, plan: CardPlan): { tx: Tx; cardInputs: number[] } {
  const mint = plan.mint
  if (mint) {
    // A transfer is the one entrypoint that spends one input and pins one output. A release
    // spends three, and a split or an activate pins more than one output, so each of those
    // seats a card that rule 2 can never authenticate.
    if (base.inputs.length !== 1) {
      throw new TxError(
        `a card is minted in a transfer, which spends one input, and this transaction spends ${base.inputs.length}`
      )
    }
    if (base.outputs.length !== 1) {
      throw new TxError(`a card is output 1, and this transaction pins ${base.outputs.length} outputs of its own`)
    }
  }
  const cardInputs = plan.sweep.map((_, at) => base.inputs.length + at)
  const tx: Tx = {
    ...base,
    inputs: [...base.inputs, ...plan.sweep.map(cardInput)],
    outputs: mint
      ? [
          ...base.outputs,
          { value: BigInt(CARD_VALUE), scriptPublicKey: toHex(cardScriptPublicKey(mint.state)), scriptVersion: 0 },
        ]
      : [...base.outputs],
    payload: toHex(encodeCardPayload(mint ?? null)),
  }
  return { tx, cardInputs }
}

/**
 * A standalone sweep: the cards alone, which pay `destScriptPublicKey` what they hold less the
 * fee. No covenant takes part, and the cards' own signatures commit to the one output.
 *
 * One pass settles the fee, because every input already carries a script of its final length and
 * the one output is the same size whatever it holds.
 */
export function assembleSweep(sweep: CardSweep[], destScriptPublicKey: string, feerate: number): Assembled {
  if (sweep.length === 0) throw new TxError('a sweep needs a card to sweep')
  bytesOf(destScriptPublicKey, 'destination script')
  const total = sweep.reduce((n, c) => n + c.value, 0n)
  const shape: Tx = {
    ...emptyTx(),
    inputs: sweep.map(cardInput),
    outputs: [{ value: total, scriptPublicKey: destScriptPublicKey, scriptVersion: 0 }],
  }
  const fee = requiredFee(shape, feerate)
  if (fee > MAX_FEE_SOMPI) throw new FeeCeilingError(fee, MAX_FEE_SOMPI)
  // The one output clears the same floor every protocol output clears.
  if (total < fee + MIN_OUTPUT_VALUE) throw new InsufficientFundingError(total, fee + MIN_OUTPUT_VALUE)
  const tx: Tx = { ...shape, outputs: [{ ...shape.outputs[0]!, value: total - fee }] }
  // The same rail `assemble` applies: a sweep of many cards is many inputs, and the compute cap
  // is what bounds them.
  const overrun = massOverrun(tx)
  if (overrun) throw new MassCeilingError(overrun.dimension, overrun.mass, overrun.cap)
  // No change output: the one output is the destination, so nothing here is change.
  return { tx, fee, mass: massesOf(tx), fundingInputs: [], changeIndex: -1 }
}
