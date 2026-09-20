import { DotkError, NodeError } from '@dotk/sdk'

/** Anything this package refuses to build, sign or send. */
export class TxError extends DotkError {
  override name = 'TxError'
}

/** The wallet holds too little to cover what the transaction moves plus its fee. */
export class InsufficientFundingError extends TxError {
  override name = 'InsufficientFundingError'
  constructor(
    readonly have: bigint,
    readonly need: bigint,
    remedy?: string
  ) {
    super(`insufficient funding: ${have} sompi available, ${need} needed${remedy ? `. ${remedy}` : ''}`)
  }
}

/**
 * This package did not reach the node, or the node refused the call before it had an opinion on
 * the transaction. A transport failure otherwise arrives as whatever the socket threw, which a
 * caller branching on these errors reads as a bug here.
 *
 * The class is the read client's own, so a wallet that catches `NodeError` from `@dotk/sdk`
 * catches the write half's node failures with it.
 */
export { NodeError }

/**
 * A transaction over one of the three per-transaction mass limits a node applies.
 *
 * This is not a price refusal, unlike {@link FeeCeilingError}. The remedy is a different funding
 * set, usually one more coin. Change too small to relay folds into the fee before this is raised,
 * up to `FOLD_CEILING_SOMPI`, so the cause is a shape the fold cannot mend: many inputs, several
 * small outputs at once, or change past that ceiling.
 */
export class MassCeilingError extends TxError {
  override name = 'MassCeilingError'
  constructor(
    readonly dimension: string,
    /** What the transaction measures, or `null` where the formula declines to price it. */
    readonly mass: bigint | null,
    readonly cap: bigint
  ) {
    super(
      mass === null
        ? `its ${dimension} mass cannot be measured, so nothing here can show it under the ${cap} a node carries`
        : `its ${dimension} mass is ${mass}, over the ${cap} a node carries`
    )
  }
}

/** The fee came out above `MAX_FEE_SOMPI`. That constant carries the reason for the rail. */
export class FeeCeilingError extends TxError {
  override name = 'FeeCeilingError'
  constructor(
    readonly fee: bigint,
    readonly ceiling: bigint
  ) {
    super(`the network fee is ${fee} sompi, above the ${ceiling} ceiling this package will build to`)
  }
}

/** The wallet's answer is not the transaction it was given, or is not signed as asked. */
export class SigningError extends TxError {
  override name = 'SigningError'
}

/**
 * The name's live card carries values this version cannot read, so a records save from here mints
 * a set that drops everything the card holds. `planRecords(name, null)` clears the records on
 * purpose.
 */
export class UndecodableCardError extends TxError {
  override name = 'UndecodableCardError'
  constructor(readonly nameOf: string) {
    super(`${nameOf}.k's card carries values this version cannot read. A save of records drops them`)
  }
}

/** The node refused the transaction. `verdict` says whether anything is worth retrying. */
export class SubmitError extends TxError {
  override name = 'SubmitError'
  constructor(
    message: string,
    readonly verdict: Verdict,
    options?: { cause?: unknown }
  ) {
    super(message, options)
  }
}

/**
 * What a refusal means for the caller.
 *
 * A caller can retry only `transient`, and only with the same bytes. `stale` needs a fresh
 * funding selection and therefore a fresh signature, which is a new approval and never
 * automatic. The node refuses a `fatal` again for the same reason.
 */
export type Verdict = 'transient' | 'stale' | 'fatal' | 'unknown'
