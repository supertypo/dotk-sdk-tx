// `transfer`, the single-input owner swap: one lineage input, one lineage output, and nothing
// read from the API. Everything it needs is in the deed's own state, so it contends with
// nothing.

import {
  type AbiContract,
  type Registry,
  SubnameError,
  checkPayload,
  encodeActiveDeedState,
  names,
  toHex,
  isSpenderType,
} from '@dotk/sdk'
import { entrySigScript } from './abi.js'
import { type CardPlan, withCards } from './cards.js'
import { TxError } from './errors.js'
import { bytes32Of } from './hex.js'
import type { SpendableUtxo } from './ports.js'
import { emptyTx, type Tx, utxoEntryOf } from './tx.js'

/** The 65 zero bytes an owner's signature is patched into once the wallet returns it. */
import { SIG_LEN } from './script.js'
export { SIG_LEN } from './script.js'
const SIG_PLACEHOLDER = new Uint8Array(SIG_LEN)

/** The compute budget the deed's input declares for a transfer. */
const TRANSFER_COMPUTE_BUDGET = 100

/** The `witness` argument, which names a co-present input for a script-hash owner only. */
const NO_WITNESS = 0

/** The state an ACTIVE deed carries, as this package needs to read and rebuild it. */
export interface DeedState {
  /** `blake3(name)`, hex. */
  key: string
  ownerType: number
  /** The 32-byte owner payload, hex. */
  owner: string
  /** The bare on-chain name. */
  name: string
}

/** An ACTIVE deed the node holds, ready to be spent. */
export interface Deed {
  state: DeedState
  utxo: SpendableUtxo
}

/**
 * The deed's state bytes. `paddedName` comes from the read client and validates the name on the
 * way through, so a name the covenant refuses never reaches a state an address derives from.
 */
export function stateBytes(state: DeedState): Uint8Array {
  return encodeActiveDeedState(
    bytes32Of(state.key, 'key'),
    state.ownerType,
    bytes32Of(state.owner, 'owner'),
    names.paddedName(state.name)
  )
}

/**
 * Refuse an owner the covenant accepts but no one can ever spend.
 *
 * The covenant-id comparison is scheme-independent exactly as the covenant makes it, which closes
 * the case of a key-typed owner that happens to equal it. `checkPayload` makes the tests a
 * covenant cannot: the zero payload, and the curve point behind a key scheme. A deed minted over
 * either holds the bond where no spend can reach it.
 */
export function validateOwner(ownerType: number, owner: string, registryCovenantId: string): void {
  const bytes = bytes32Of(owner, 'owner')
  if (owner.toLowerCase() === registryCovenantId.toLowerCase()) {
    throw new TxError("the new owner is the registry's own covenant id, which anyone can then spend")
  }
  try {
    checkPayload(ownerType, bytes)
  } catch (e) {
    // The read client holds the one copy of these tests. A caller of this package branches on
    // `TxError`, so the refusal arrives as one, with the read client's words inside it.
    if (!(e instanceof SubnameError)) throw e
    throw new TxError(
      `the new owner is refused: ${e.message}. A deed under it holds the bond where no spend can reach it`,
      {
        cause: e,
      }
    )
  }
  if (isSpenderType(ownerType)) return
  // A co-present input approves this owner instead of a signature, and nothing here builds that
  // shape. A transfer to one leaves the recipient a deed no shipped tool can move. The covenant
  // permits it as owner self-harm, which it is not when a sender chooses it for someone else.
  throw new TxError(
    `owner scheme ${ownerType} is spent by a co-present input rather than a signature, and nothing here ` +
      'builds that shape, so a name handed to one cannot be moved again'
  )
}

export interface TransferPlan {
  /** The transaction with its protocol seats filled and nothing else. */
  base: Tx
  /** The deed's input index, which is the seat the owner signs. */
  ownerSigInput: number
  /** The swept cards' input indices, which the same key signs under each card's scheme. */
  cardInputs: number[]
  /** The deed as it will be after the transfer, which is what derives where it moved to. */
  next: DeedState
}

/**
 * The protocol half of a transfer. The deed goes in at seat 0, its continuation out at index 0,
 * then the cards it carries.
 *
 * The continuation is pinned to `BOND` and not to whatever the spent UTXO holds, because the
 * covenant demands exactly that. Using the observed value turns a client error this can name into
 * an opaque rejection at the node.
 *
 * A transfer to the owner the deed already has is refused where it touches no card. Carrying one
 * is how an owner saves records, sweeps the old cards and mints a new one while the owner stays.
 * A sweep alone counts, and so does a transfer that retires a live card it cannot sweep
 * (`CardPlan.retires`).
 */
export function transferIntent(
  registry: Registry,
  deedAbi: AbiContract,
  deed: Deed,
  newOwnerType: number,
  newOwner: string,
  cards: CardPlan = { sweep: [] }
): TransferPlan {
  const bond = BigInt(registry.params.bond)
  if (deed.utxo.amount !== bond) {
    throw new TxError(`an ACTIVE deed holds exactly ${bond} sompi, this one holds ${deed.utxo.amount}`)
  }
  if (deed.utxo.covenantId?.toLowerCase() !== registry.registryCovenantId) {
    throw new TxError("that UTXO does not carry this registry's covenant id")
  }
  if (typeof newOwner !== 'string') throw new TxError('newOwner must be a hex string')
  // Before this function validates the owner. Someone who transfers a name to the address that
  // already holds it must hear that, not something about a curve.
  const sameOwner = newOwnerType === deed.state.ownerType && newOwner.toLowerCase() === deed.state.owner.toLowerCase()
  if (sameOwner && !cards.mint && cards.sweep.length === 0 && !cards.retires) {
    throw new TxError(
      `this transfer of ${names.display(deed.state.name)} mints no card and sweeps none, ` + 'so there is nothing to do'
    )
  }
  validateOwner(newOwnerType, newOwner, registry.registryCovenantId)

  // The placeholder rides where the owner's signature will. A deed nobody signs for was refused above.
  if (!isSpenderType(deed.state.ownerType)) {
    throw new TxError(
      `a deed held under owner scheme ${deed.state.ownerType} is approved by a co-present input, ` +
        'which this version does not build'
    )
  }

  // The key is `blake3(name)` and the two travel together in the state the covenant reads. A
  // caller that paired them wrongly would derive a redeem script for a deed that does not exist,
  // so this function makes sure of the pair before a wallet signs.
  const expectedKey = toHex(names.keyBytesOf(deed.state.name))
  if (deed.state.key.toLowerCase() !== expectedKey) {
    throw new TxError(`the deed's key is not blake3(${deed.state.name})`)
  }

  const current = stateBytes(deed.state)

  // The UTXO the node reported must be the one this state locks. Otherwise the redeem script is
  // built from a state that deed does not carry, and the spend fails at consensus naming
  // nothing.
  const derivedSpk = toHex(registry.deed.scriptPublicKey(current))
  if (deed.utxo.scriptPublicKey.toLowerCase() !== derivedSpk) {
    throw new TxError('that UTXO does not pay to the deed this name and owner derive')
  }
  const next: DeedState = { ...deed.state, ownerType: newOwnerType, owner: newOwner.toLowerCase() }
  const redeem = registry.deed.redeem(current)

  const sigScript = entrySigScript(
    deedAbi,
    'transfer',
    [newOwnerType, bytes32Of(newOwner, 'newOwner'), [SIG_PLACEHOLDER], NO_WITNESS],
    redeem
  )

  const tx = emptyTx()
  tx.inputs.push({
    previousOutpoint: deed.utxo.outpoint,
    signatureScript: toHex(sigScript),
    sequence: 0n,
    computeBudget: TRANSFER_COMPUTE_BUDGET,
    utxo: utxoEntryOf(deed.utxo),
  })
  tx.outputs.push({
    value: bond,
    scriptPublicKey: toHex(registry.deed.scriptPublicKey(stateBytes(next))),
    scriptVersion: 0,
    covenant: { authorizingInput: 0, covenantId: registry.registryCovenantId },
  })
  // A card in this transfer is minted for the deed's next key. One that commits to another name
  // is inert the moment it confirms, because a card is pinned to its own deed, and its value is
  // sunk.
  if (cards.mint && toHex(cards.mint.state.key) !== expectedKey) {
    throw new TxError('a card minted in this transfer must be for this name')
  }
  const carried = withCards(tx, cards)
  return { base: carried.tx, ownerSigInput: 0, cardInputs: carried.cardInputs, next }
}

/** Where the deed sits once this transfer confirms. */
export function deedAddressOfState(registry: Registry, state: DeedState): string {
  return registry.deed.address(registry.prefix, stateBytes(state)).text
}
