// What a refused submission means, classified before anything acts on it.
//
// The fragments are the mempool's own wording, and the corpus in `tests/` holds this copy to the
// reference implementation's. A `stale` read as `transient` re-offers the same bytes forever. A
// `fatal` read as `transient` burns round trips to be told the same thing.

import type { Verdict } from './errors.js'

// Fatal first. A mass rejection also names a transaction id, and "not standard" carries a
// nested reason that can say anything.
const FATAL = [
  'is larger than max allowed size of',
  'is not standard:',
  'impossible to have a matching UTXO entry',
  // A value KIP-9 declines to price is one no node will carry, and it prices the same way next
  // time. Unreachable from anything this package builds, because every output clears a floor.
  'due to incomputable storage mass',
]

const STALE = ['already spent by transaction', 'is already in the mempool', 'already accepted by the consensus']

const TRANSIENT = [
  'is an orphan where orphan is disallowed',
  'lacking a matching UTXO entry',
  'spends an immature UTXO',
  'full with transactions with higher priority',
]

/**
 * Read a node's refusal. `unknown` means the message was never a mempool verdict at all: a
 * dropped connection, a timeout, or a wording this version does not know. The registrar hands
 * such a failure back as the error it was, and names a `SubmitError` only for a verdict.
 */
export function classify(message: string): Verdict {
  if (FATAL.some((f) => message.includes(f))) return 'fatal'
  if (STALE.some((f) => message.includes(f))) return 'stale'
  if (TRANSIENT.some((f) => message.includes(f))) return 'transient'
  return 'unknown'
}
