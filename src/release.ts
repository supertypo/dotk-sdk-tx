// The end of a registration: the exit merge, the one shape here that spends three registry UTXOs
// at once.
//
// A `release` kills the deed and merges the two gaps that flanked it into one. The transaction
// takes three seats, the predecessor gap at 0, the deed at 1 and the successor gap at 2, and
// writes a single widened gap. The covenant pins every position and the adjacency between them,
// which is why the seats here are literal and not derived from a caller's order.
//
// The owner's signature rides at seat 1 and nowhere else. Seats 0 and 2 consent by co-presence,
// which is what lets a stranger drive an eviction. A wrong neighbor builds a transaction
// consensus refuses, so this file compares each one with the deed's own key before a wallet
// signs.

import { encodeGapState, toHex, type Registry } from '@dotk/sdk'
import { entrySigScript } from './abi.js'
import { TxError } from './errors.js'
import { bytes32Of } from './hex.js'
import { SIG_LEN, stateBytes, type Deed } from './transfer.js'
import { emptyTx, type Tx, utxoEntryOf } from './tx.js'

/** The compute budgets the three seats declare, one per entrypoint the covenant runs. */
const MERGE_COMPUTE_BUDGET = 150
const RELEASE_COMPUTE_BUDGET = 100
const ABSORBED_COMPUTE_BUDGET = 50

/** The `witness` argument, which names a co-present input for a script-hash owner only. */
const NO_WITNESS = 0

const SIG_PLACEHOLDER = new Uint8Array(SIG_LEN)

/** A gap UTXO the node holds, with the bounds its address hashes from. */
export interface Gap {
  /** `lo`, the exclusive lower bound of the keyspace this gap covers, 32-byte hex. */
  lo: string
  /** `hi`, its exclusive upper bound. */
  hi: string
  outpoint: { transactionId: string; index: number }
  amount: bigint
  scriptPublicKey: string
  scriptVersion: number
  blockDaaScore: bigint
  isCoinbase: boolean
  covenantId?: string | undefined
}

/** A release, ready for funding: the transaction, and which input the owner signs. */
export interface ReleasePlan {
  base: Tx
  /** The seat the owner's signature goes in. Always the deed's, and always index 1. */
  ownerSigInputs: number[]
  /** What the exit frees: the deed's bond plus the gap value the merged gap does not need. */
  released: bigint
}

/** The gap the merge writes: everything the two neighbors covered, with the key gone from it. */
export function widenedGapState(pred: Gap, succ: Gap): Uint8Array {
  return encodeGapState(bytes32Of(pred.lo, 'predecessor lo'), bytes32Of(succ.hi, 'successor hi'))
}

/**
 * The exit merge for a deed and its two flanking gaps.
 *
 * The covenant enforces the adjacency itself, so consensus refuses a wrong neighbor. That refusal
 * arrives after a wallet approved the transaction, so every test here runs first and names what
 * it compared.
 */
export function releaseIntent(registry: Registry, deed: Deed, pred: Gap, succ: Gap): ReleasePlan {
  const bond = BigInt(registry.params.bond)
  const gapValue = BigInt(registry.params.gap_value)
  if (deed.utxo.amount !== bond) {
    throw new TxError(`an ACTIVE deed holds exactly ${bond} sompi, this one holds ${deed.utxo.amount}`)
  }
  for (const [what, utxo] of [
    ['the deed', deed.utxo],
    ['the predecessor gap', pred],
    ['the successor gap', succ],
  ] as const) {
    if (utxo.covenantId?.toLowerCase() !== registry.registryCovenantId) {
      throw new TxError(`${what} does not carry this registry's covenant id, so it belongs to another lineage`)
    }
  }
  const key = deed.state.key.toLowerCase()
  if (pred.hi.toLowerCase() !== key) {
    throw new TxError("the predecessor gap does not end at this deed's key, so it is not the neighbor that merges")
  }
  if (succ.lo.toLowerCase() !== key) {
    throw new TxError("the successor gap does not begin at this deed's key, so it is not the neighbor that merges")
  }
  for (const [what, gap] of [
    ['predecessor', pred],
    ['successor', succ],
  ] as const) {
    if (gap.amount !== gapValue) {
      throw new TxError(`the ${what} gap holds ${gap.amount} sompi where a gap carries ${gapValue}`)
    }
    const derived = toHex(
      registry.gap.scriptPublicKey(
        encodeGapState(bytes32Of(gap.lo, `${what} gap lo`), bytes32Of(gap.hi, `${what} gap hi`))
      )
    )
    if (gap.scriptPublicKey.toLowerCase() !== derived) {
      throw new TxError(`that UTXO does not pay to the ${what} gap those bounds derive`)
    }
  }

  const current = stateBytes(deed.state)
  const derivedSpk = toHex(registry.deed.scriptPublicKey(current))
  if (deed.utxo.scriptPublicKey.toLowerCase() !== derivedSpk) {
    throw new TxError('that UTXO does not pay to the deed this name and owner derive')
  }

  const gapRedeem = (gap: Gap) =>
    registry.gap.redeem(encodeGapState(bytes32Of(gap.lo, 'gap lo'), bytes32Of(gap.hi, 'gap hi')))
  const seat = (gap: Gap, entry: 'merge' | 'absorbed', budget: number) => ({
    previousOutpoint: gap.outpoint,
    signatureScript: toHex(entrySigScript(registry.gapAbi, entry, [], gapRedeem(gap))),
    sequence: 0n,
    computeBudget: budget,
    utxo: utxoEntryOf(gap),
  })

  const tx = emptyTx()
  tx.inputs.push(seat(pred, 'merge', MERGE_COMPUTE_BUDGET))
  tx.inputs.push({
    previousOutpoint: deed.utxo.outpoint,
    signatureScript: toHex(
      entrySigScript(registry.deedAbi, 'release', [[SIG_PLACEHOLDER], NO_WITNESS], registry.deed.redeem(current))
    ),
    sequence: 0n,
    computeBudget: RELEASE_COMPUTE_BUDGET,
    utxo: utxoEntryOf(deed.utxo),
  })
  tx.inputs.push(seat(succ, 'absorbed', ABSORBED_COMPUTE_BUDGET))
  tx.outputs.push({
    value: gapValue,
    scriptPublicKey: toHex(registry.gap.scriptPublicKey(widenedGapState(pred, succ))),
    scriptVersion: 0,
    covenant: { authorizingInput: 0, covenantId: pred.covenantId!.toLowerCase() },
  })

  return { base: tx, ownerSigInputs: [1], released: deed.utxo.amount + pred.amount + succ.amount - gapValue }
}
