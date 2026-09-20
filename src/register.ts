// A registration: the commit and the reveal, where the first one's change funds the second.
//
// A `split` spends the gap covering the name's key and writes two narrower gaps and a PENDING
// deed holding BOND + DEPOSIT. An `activate` spends that deed, reveals the name, pays the tier
// fee to the devfund and leaves an ACTIVE deed at BOND. Between the two the PENDING deed reserves
// the name, and one nobody activates is evicted after `t_evict` with the deposit going to the
// evictor.
//
// The pair is therefore judged together and never one at a time. A funding amount can leave the
// split perfectly relayable and the reveal over KIP-9's storage floor, which is visible only once
// the second transaction stands on the first's change. In submit order the split is on chain by
// then.
//
// The reveal carries no signature, because knowing the claim's preimage is its whole
// authorization. Anyone holding `(name, ownerType, ownerKey)` can rebuild and fund it, which
// makes a half-landed registration recoverable.

import {
  encodeActiveDeedState,
  encodeGapState,
  encodePendingDeedState,
  feeForName,
  names,
  toHex,
  type Registry,
} from '@dotk/sdk'
import { entrySigScript } from './abi.js'
import { TxError } from './errors.js'
import { bytes32Of } from './hex.js'
import { validateOwner } from './transfer.js'
import type { Gap } from './release.js'
import { emptyTx, type Tx, utxoEntryOf } from './tx.js'

/** The compute budgets the two entrypoints declare. */
const SPLIT_COMPUTE_BUDGET = 150
const ACTIVATE_COMPUTE_BUDGET = 100

/** A commit, ready for funding. */
export interface SplitPlan {
  base: Tx
  /** What the registrant must add beyond the gap's own value. */
  requiredFunding: bigint
  /** The PENDING deed this split writes, and where it writes it. */
  newborn: { key: string; claim: string; outputIndex: number; value: bigint }
}

/** A reveal, ready for funding. Nothing here is signed: the preimage is the authorization. */
export interface ActivatePlan {
  base: Tx
  /** `fee - DEPOSIT`: what the reveal needs beyond what the deed releases. */
  requiredFunding: bigint
  /** The tier fee this name pays the devfund. */
  fee: bigint
}

/** A PENDING deed the node holds, as the reveal needs to read it. */
export interface Pending {
  key: string
  claim: string
  outpoint: { transactionId: string; index: number }
  amount: bigint
  scriptPublicKey: string
  scriptVersion: number
  blockDaaScore: bigint
  isCoinbase: boolean
  covenantId?: string | undefined
}

/**
 * The commit: spend the gap that covers this key, and write the two narrower gaps and the
 * newborn.
 *
 * The client must make sure that the gap covers the key. The covenant enforces it too, but that
 * refusal arrives after a wallet approved a posting of `BOND + DEPOSIT + GAP_VALUE`.
 */
export function splitIntent(registry: Registry, gap: Gap, name: string, ownerType: number, owner: string): SplitPlan {
  const bare = names.normalize(name)
  // The gap covenant never sees the name, so a name the deed covenant refuses lands as a commit
  // that no reveal satisfies. The reference validates it first, before anything is posted.
  names.validate(bare)
  // The claim binds this owner for good, and a deed under a refused owner holds the posting
  // where no spend can reach it. The reference refuses the same owners here.
  validateOwner(ownerType, owner, registry.registryCovenantId)
  const key = names.keyBytesOf(bare)
  const keyHex = toHex(key)
  const gapValue = BigInt(registry.params.gap_value)
  const newbornValue = BigInt(registry.params.bond) + BigInt(registry.params.deposit)

  if (gap.covenantId?.toLowerCase() !== registry.registryCovenantId) {
    throw new TxError("that gap does not carry this registry's covenant id, so it belongs to another lineage")
  }
  if (gap.amount !== gapValue) {
    throw new TxError(`a gap holds ${gapValue} sompi, this one holds ${gap.amount}`)
  }
  const lo = bytes32Of(gap.lo, 'gap lo')
  const hi = bytes32Of(gap.hi, 'gap hi')
  // Strictly inside at both ends. A key equal to either bound is already the boundary of an
  // existing registration, and the covenant refuses it.
  if (!(toHex(lo) < keyHex && keyHex < toHex(hi))) {
    throw new TxError(`${bare} does not fall strictly inside the gap given, so a node refuses this split`)
  }
  const state = encodeGapState(lo, hi)
  if (gap.scriptPublicKey.toLowerCase() !== toHex(registry.gap.scriptPublicKey(state))) {
    throw new TxError('that UTXO does not pay to the gap those bounds derive')
  }

  const claim = names.claimOf(bare, ownerType, bytes32Of(owner, 'owner'))
  const lower = encodeGapState(lo, key)
  const upper = encodeGapState(key, hi)
  const newborn = encodePendingDeedState(key, claim)
  const covenant = { authorizingInput: 0, covenantId: gap.covenantId.toLowerCase() }

  const tx = emptyTx()
  tx.inputs.push({
    previousOutpoint: gap.outpoint,
    signatureScript: toHex(
      entrySigScript(
        registry.gapAbi,
        'split',
        [key, claim, registry.deed.prefix(), registry.deed.suffix()],
        registry.gap.redeem(state)
      )
    ),
    sequence: 0n,
    computeBudget: SPLIT_COMPUTE_BUDGET,
    utxo: utxoEntryOf(gap),
  })
  tx.outputs.push({
    value: gapValue,
    scriptPublicKey: toHex(registry.gap.scriptPublicKey(lower)),
    scriptVersion: 0,
    covenant,
  })
  tx.outputs.push({
    value: gapValue,
    scriptPublicKey: toHex(registry.gap.scriptPublicKey(upper)),
    scriptVersion: 0,
    covenant,
  })
  tx.outputs.push({
    value: newbornValue,
    scriptPublicKey: toHex(registry.deed.scriptPublicKey(newborn)),
    scriptVersion: 0,
    covenant,
  })

  return {
    base: tx,
    requiredFunding: newbornValue + gapValue + gapValue - gap.amount,
    newborn: { key: keyHex, claim: toHex(claim), outputIndex: 2, value: newbornValue },
  }
}

/**
 * The reveal: spend the PENDING deed, publish the name, pay the tier and leave an ACTIVE deed.
 *
 * The covenant repeats every test here. The claim binds this owner permanently, so a reveal the
 * covenant refuses is a posting nobody can spend and that ends as somebody's evict bounty.
 */
export function activateIntent(
  registry: Registry,
  pending: Pending,
  name: string,
  ownerType: number,
  owner: string
): ActivatePlan {
  const bare = names.normalize(name)
  names.validate(bare)
  validateOwner(ownerType, owner, registry.registryCovenantId)
  const key = names.keyBytesOf(bare)
  const ownerBytes = bytes32Of(owner, 'owner')
  const bond = BigInt(registry.params.bond)
  const deposit = BigInt(registry.params.deposit)
  const fee = BigInt(feeForName(registry.params, bare))

  if (pending.covenantId?.toLowerCase() !== registry.registryCovenantId) {
    throw new TxError("that deed does not carry this registry's covenant id, so it belongs to another lineage")
  }
  const pendingKey = bytes32Of(pending.key, 'pending key')
  const pendingClaim = bytes32Of(pending.claim, 'pending claim')
  if (toHex(key) !== toHex(pendingKey)) {
    throw new TxError(`${bare} does not hash to that deed's key`)
  }
  // A PENDING deed holds exactly the posting. A node that understates it would turn the surplus
  // into fee, because the funding is computed from this figure.
  if (pending.amount !== bond + deposit) {
    throw new TxError(`a PENDING deed holds exactly ${bond + deposit} sompi, this one holds ${pending.amount}`)
  }
  if (toHex(names.claimOf(bare, ownerType, ownerBytes)) !== toHex(pendingClaim)) {
    throw new TxError('the claim does not match: a different name, owner or scheme was committed')
  }
  const current = encodePendingDeedState(pendingKey, pendingClaim)
  if (pending.scriptPublicKey.toLowerCase() !== toHex(registry.deed.scriptPublicKey(current))) {
    throw new TxError('that UTXO does not pay to the pending deed this key and claim derive')
  }

  const next = registry.deed.scriptPublicKey(encodeActiveDeedState(key, ownerType, ownerBytes, names.paddedName(bare)))
  const tx = emptyTx()
  tx.inputs.push({
    previousOutpoint: pending.outpoint,
    signatureScript: toHex(
      entrySigScript(
        registry.deedAbi,
        'activate',
        [new TextEncoder().encode(bare), ownerType, ownerBytes],
        registry.deed.redeem(current)
      )
    ),
    sequence: 0n,
    computeBudget: ACTIVATE_COMPUTE_BUDGET,
    utxo: utxoEntryOf(pending),
  })
  tx.outputs.push({
    value: bond,
    scriptPublicKey: toHex(next),
    scriptVersion: 0,
    covenant: { authorizingInput: 0, covenantId: pending.covenantId.toLowerCase() },
  })
  tx.outputs.push({ value: fee, scriptPublicKey: registry.params.devfund_spk.toLowerCase(), scriptVersion: 0 })

  const outputs = bond + fee
  return { base: tx, requiredFunding: outputs > pending.amount ? outputs - pending.amount : 0n, fee }
}
