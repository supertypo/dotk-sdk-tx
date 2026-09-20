// The three things this package does end to end: move a name to another owner, save a name's
// records, and reclaim the cards a wallet left behind.

import {
  fromHex,
  CARD_VALUE,
  type Card,
  DEFAULT_TIMEOUT_MS,
  DotkError,
  type Dotk,
  type NodeCallOptions,
  OwnerType,
  type Records,
  cardScriptPublicKey,
  encodeAddress,
  parseAddress,
  ownerOfParsed,
  toHex,
  withDeadline,
  verifyCard,
  cardState,
  ConfigError,
  encodeGapState,
  encodePendingDeedState,
  feeForName,
  names,
} from '@dotk/sdk'
import { assemble, type Assembled } from './assemble.js'
import {
  type DroppedSubname,
  type PlannedSubname,
  endingSubnames,
  mergeRecords,
  refuseUnreachableSubnames,
} from './records.js'
import { assembleSweep, cardMint, type CardPlan, type CardSweep } from './cards.js'
import { COINBASE_MATURITY } from './mass.js'
import { transactionId } from './sighash.js'

import { NodeError, SubmitError, TxError, UndecodableCardError } from './errors.js'
import { bytes32Of, bytesOf } from './hex.js'
import type { Account, Signer, SignRequest, SpendableUtxo, TxNode } from './ports.js'
import { classify } from './reject.js'
import { ecdsaScript, p2shScript, schnorrScript } from './script.js'
import { applySignatures } from './sign.js'
import { activateIntent, splitIntent, type Pending } from './register.js'
import { releaseIntent, type Gap } from './release.js'
import { deedAddressOfState, transferIntent, type Deed, type DeedState } from './transfer.js'
import { toSafeJson, type Outpoint, type Tx } from './tx.js'

/** Headroom over the exact posting. It is ten times the storage floor a change output must clear. */
const DEFAULT_REGISTRATION_BUFFER = 20_000_000n

export interface RegistrarOptions {
  /** The read client, which supplies the deployment and its templates. */
  dotk: Dotk
  node: TxNode
  signer: Signer
  /** The account that owns what a plan moves, and that pays the fee. */
  account: Account
  /**
   * How long any one call can take, in milliseconds. It defaults to `DEFAULT_TIMEOUT_MS`, and a
   * `null` waits for ever. A `TxNode` can ignore the signal this package hands it, so this
   * package applies the deadline itself instead of leaving it to the adapter.
   */
  timeoutMs?: number | null | undefined
}

/** What a transfer can carry besides the name. */
export interface TransferOptions extends NodeCallOptions {
  /**
   * Records for the name's new owner. This package mints them as a card that owner can sweep.
   * Without records it mints no card.
   */
  records?: Records | undefined
  /**
   * Whether the same transaction sweeps the account's cards on this name. It does by default,
   * because a transfer retires them: a card is pinned to the deed's outpoint. The sweep brings
   * their value back with the
   * change. `false` leaves them for a later {@link Registrar.sweep}.
   */
  sweep?: boolean | undefined
  /**
   * The subnames this save removes, each named by the label the live card stores. Every other
   * `sub:` entry of the live card is carried.
   *
   * A drop rewrites the set the mint writes back, so it needs `records` and a live card this
   * package read. A label the live card does not carry is refused, and so is one `records` also
   * names.
   */
  dropSubnames?: string[] | undefined
}

/** What a caller can tell a records save, beyond the node calls every plan takes. */
export interface RecordsOptions extends NodeCallOptions {
  /** The subnames this save removes. {@link TransferOptions.dropSubnames} holds the rule. */
  dropSubnames?: string[] | undefined
}

/** A plan this registrar built, whatever it does. This is what {@link Registrar.submit} takes. */
export interface Planned {
  request: SignRequest
  readonly assembled: Assembled
  readonly ownerSigInputs: number[]
}

/** What a caller can tell a registration. */
export interface RegisterOptions extends NodeCallOptions {
  /**
   * The gap covering the name's key. Without an `api` you must give it, for the reason you must
   * give `neighbours`.
   */
  gap?: Gap | undefined
  /**
   * Headroom over the exact posting, in sompi. The commit's change funds the reveal, and KIP-9
   * refuses a change output too small to relay, so the target clears that floor instead of being
   * exact. It defaults to 0.2 KAS, which is ten times the floor.
   */
  buffer?: bigint | undefined
}

/** Cost and shape of a registration, both halves judged together. */
export interface RegistrationPlanned {
  name: string
  /** Where the deed will sit once the reveal confirms. */
  deed: string
  /** The tier this name pays the devfund, in sompi. */
  tier: bigint
  /** Both network fees, which is what the registration costs beyond the tier. */
  fee: bigint
  /** What stays locked in the name: the bond and the gap value, both refunded by a release. */
  locked: bigint
  /** The commit, and the reveal built on its change. Submit them in this order and no other. */
  commit: Planned
  reveal: Planned
}

/** Cost and shape of the reveal on its own, for a registration whose commit already landed. */
export interface ActivationPlanned extends Planned {
  name: string
  /** Where the deed sits once this confirms. */
  deed: string
  /** The tier this name pays the devfund, in sompi. */
  tier: bigint
  /** The network fee, in sompi. */
  fee: bigint
}

/** What a caller can tell a release, beyond the node calls every plan takes. */
export interface ReleaseOptions extends NodeCallOptions {
  /**
   * The two gaps flanking the name, when the caller has them. Without an `api` the caller must
   * pass them, because only its bounds find a gap and nothing in the name yields them.
   */
  neighbours?: { pred: Gap; succ: Gap } | undefined
}

/** Cost and shape of ending a registration. */
export interface ReleasePlanned extends Planned {
  name: string
  /** Where the deed sits, until this confirms and it stops existing. */
  fromDeed: string
  /** The network fee, in sompi. */
  fee: bigint
  /**
   * What comes back: the name bond and the gap value the merge frees, less the fee. Show this
   * figure to a person, because it is what their balance changes by.
   */
  returned: bigint
}

/** A transfer, costed and ready to sign. This package asks the wallet for nothing yet. */
export interface TransferPlanned extends Planned {
  name: string
  /**
   * The address this transfer hands the name to, as the caller gave it.
   *
   * Show this one to a person before they approve. The two below are script addresses where the
   * deed itself sits, and a reader cannot check one against anything they know.
   */
  recipient: string
  /** Where the deed sits now. */
  fromDeed: string
  /** Where it will sit once this confirms. */
  toDeed: string
  /** The network fee, in sompi. */
  fee: bigint
  /**
   * The cards this transfer carries. `minted` says whether it mints the name's one card, and
   * `swept` counts the ones it sweeps. `value` is what they move beyond the fee. It is what the
   * mint holds, less what the sweeps bring back, so it is negative when more comes back than goes
   * out. Whatever a mint holds is the new owner's to sweep later.
   */
  cards: {
    minted: boolean
    swept: number
    value: bigint
    /**
     * `carried` holds the keys of the live card's opaque values the mint carries forward, under
     * keys the given set did not name. `dropped` holds the keys of those it drops for a value the
     * set did name. A signing surface lists both, because a payee list built from recognized
     * values can never include an opaque one. Both are empty when the transfer mints nothing, and
     * a `sub:` entry is in neither, because the two listings below name it.
     */
    carried: string[]
    dropped: string[]
    /**
     * Every `sub:` entry the minted card carries, in the order a card lists them. A save judges
     * each one against the live card's entries. A transfer to another owner retires that card,
     * so there every entry is `added`.
     *
     * Show this before the wallet signs. An added, a changed and a refused entry each show in
     * full, and the unchanged payees fold into a count. A refused entry never folds, because a
     * later reader can turn one into a payee.
     */
    subnames: PlannedSubname[]
    /**
     * Every `sub:` entry this transfer retires, with the payee it paid. `dropSubnames` fills it
     * on a save. A transfer that mints no card ends every subname the live card holds, and
     * fills it with all of them.
     */
    subnamesDropped: DroppedSubname[]
    /**
     * Whether this registrar read the name's live card. Every transfer reads it.
     *
     * It is true where an API that knows the name lists no card, and where the node proves the
     * card the API lists. A proven card whose blob is not a record set counts as read, because
     * such a blob names nothing.
     *
     * It is false in four cases:
     *
     * - no API is configured
     * - the API does not know the name
     * - the node refutes the card
     * - this package cannot read the listing, or the node cannot answer for the card
     *
     * The last case reaches a plan only where that plan mints no card. A records save throws on
     * it, because a save writes the card back.
     *
     * A false here means `carried`, `subnames` and `subnamesDropped` are silent and not empty. A
     * transfer that merges no set still plans, because it writes no card back.
     */
    cardRead: boolean
    /**
     * Whether the set the caller gave was merged over a card this package read. It means
     * something only when the caller gave `records`, and it is `true` on a transfer that merges
     * no set. A false here with a mint means the new card can drop values the live one holds that
     * nobody can read, which a signing surface says.
     */
    complete: boolean
  }
  request: SignRequest
  /** The caller hands this to `submit`. It holds the transaction this package will send. */
  readonly assembled: Assembled
  readonly ownerSigInputs: number[]
}

/** A sweep of the account's leftover cards, costed and ready to sign. */
export interface SweepPlanned extends Planned {
  /** How many cards it reclaims. */
  cards: number
  /** What comes back to the account, in sompi. It is what the cards hold, less the fee. */
  value: bigint
  fee: bigint
  request: SignRequest
  readonly assembled: Assembled
  readonly ownerSigInputs: number[]
}

/** One outpoint as a set key. */
function outpointKey(o: Outpoint): string {
  return `${o.transactionId}:${o.index}`
}

/**
 * Register operations against one account. Every method is build, sign, submit in that order, and
 * each step is reachable on its own, so a caller can show a cost before a wallet opens.
 */
export class Registrar {
  private readonly dotk: Dotk
  private readonly node: TxNode
  private readonly signer: Signer
  private readonly timeoutMs: number | null
  readonly account: Account
  /**
   * The coins of transactions the node took. The UTXO index lists them until the transaction
   * confirms, so a second plan built moments after the first would select one again and
   * double-spend it, which the node refuses as `stale` after a second wallet approval.
   */
  private readonly spent = new Set<string>()
  /** The coins of submissions whose outcome is unknown, which a resync forgets. */
  private readonly doubtful = new Set<string>()

  /**
   * Forget the coins of submissions whose outcome was unknown, a socket that dropped, a call that
   * timed out, a cancel mid-flight, so the next plan reads the wallet as the node reports it.
   * The coins of a transaction the node took stay struck, because the node lists them until the
   * transaction confirms. Call this once the node's view has settled, which this package cannot
   * observe: a coin the node still lists may be spent by a transaction it holds.
   */
  resync(): void {
    this.doubtful.clear()
  }

  /**
   * A seat one of this registrar's own submissions spends. The node lists it until that
   * transaction confirms, so a plan built on it would take a wallet's approval for a transaction
   * the node refuses as stale. A seat of unknown outcome passes, because the reveal that a failed
   * activation leaves is retried through one.
   */
  private confirmed<T extends { outpoint: Outpoint }>(seat: T, what: string): T {
    if (this.spent.has(outpointKey(seat.outpoint))) {
      throw new TxError(
        `${what} is spent by a transaction this registrar submitted and the node has not confirmed, so wait for it to confirm`
      )
    }
    return seat
  }

  private struck(outpoint: Outpoint): boolean {
    const key = outpointKey(outpoint)
    return this.spent.has(key) || this.doubtful.has(key)
  }

  constructor(options: RegistrarOptions) {
    this.dotk = options.dotk
    this.node = options.node
    this.signer = options.signer
    this.account = options.account
    this.timeoutMs = options.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : options.timeoutMs
  }

  /**
   * Every node call this package makes, each under one deadline, with a transport failure named
   * as a {@link NodeError}. A socket throws whatever it likes, and a caller branching on these
   * errors otherwise reads a dropped connection as a bug here.
   *
   * A cancellation is the exception. The reason the caller aborted with comes back as they gave
   * it, whether that is an `AbortError` from the argument-less `abort()` or an object of their
   * own. A wallet cannot recognize its own cancel button once it reads as a node failure.
   */
  private async asked<T>(
    what: string,
    options: NodeCallOptions | undefined,
    work: (signal?: AbortSignal) => Promise<T>
  ): Promise<T> {
    try {
      return await withDeadline(what, this.timeoutMs, options?.signal, (signal) => work(signal))
    } catch (e) {
      if (options?.signal?.aborted) throw options.signal.reason
      if (e instanceof DotkError || (e instanceof Error && e.name === 'AbortError')) throw e
      throw new NodeError(`this package failed to ask the node: ${e instanceof Error ? e.message : String(e)}`, {
        cause: e,
      })
    }
  }

  /**
   * Find the account's deed for a name at the node. It derives the deed from the name and the
   * owner record, then confirms it against the chain. The outpoint and the value come from the
   * node and never from the API.
   */
  async deedOf(name: string, options?: NodeCallOptions): Promise<Deed> {
    const registry = this.dotk.protocol
    const bare = this.dotk.normalize(name)
    const state: DeedState = {
      key: this.dotk.keyOf(bare),
      ownerType: this.account.ownerType,
      owner: this.account.owner,
      name: bare,
    }
    const address = deedAddressOfState(registry, state)
    const utxos = await this.asked('node', options, (signal) =>
      this.node.utxosOf(address, signal ? { signal } : undefined)
    )
    const held = utxos.find((u) => u.covenantId?.toLowerCase() === registry.registryCovenantId)
    if (!held) {
      // A client that reports no covenant id on anything cannot tell a deed from a payment, so
      // "you do not own this" would be its silence and not the chain's answer.
      if (utxos.length > 0 && utxos.every((u) => u.covenantId === undefined || u.covenantId === null)) {
        throw new TxError(
          'the node client reports no covenant id on any UTXO at that address, so ownership cannot be read ' +
            'through it. Covenant ids arrived with KIP-20 in the Toccata hard fork.'
        )
      }
      throw new TxError(`${this.dotk.display(bare)} is not held by ${this.account.address}`)
    }
    return { state, utxo: this.confirmed(held, `the deed of ${this.dotk.display(bare)}`) }
  }

  /**
   * The coins at the account this package is willing to select from.
   *
   * An output carrying a covenant id is not a coin. A coinbase output younger than
   * {@link COINBASE_MATURITY} cannot be spent yet. An outpoint that one of this registrar's own
   * submissions already spends is gone, confirmed or not. Each exclusion otherwise buys a wallet
   * approval for a transaction the node then refuses.
   */
  private async spendable(options?: NodeCallOptions): Promise<SpendableUtxo[]> {
    const all = await this.asked('node', options, (signal) =>
      this.node.utxosOf(this.account.address, signal ? { signal } : undefined)
    )
    // Absent and not fatal. Without it a coinbase output cannot be aged, and refusing to transfer
    // at all is worse than offering a coin the node can still turn down.
    const daa = this.node.daaScore
      ? await this.asked('node', options, (signal) => this.node.daaScore!(signal ? { signal } : undefined))
      : undefined
    return all.filter((u) => {
      if (u.covenantId !== undefined && u.covenantId !== null) return false
      if (this.struck(u.outpoint)) return false
      if (u.isCoinbase && daa !== undefined && daa - u.blockDaaScore < COINBASE_MATURITY) return false
      return true
    })
  }

  /**
   * The account's cards the node still holds, as sweep inputs, for one name or for every name.
   *
   * The API lists what this key can sweep (`Dotk.cardsOf`), and the node says which of those are
   * still unspent and what they hold. This package never spends from a listing alone. Without an
   * API nothing is listed, so a client built with `api: null` leaves its old cards where they
   * are.
   */
  private async cardsHeld(key: string | undefined, options?: NodeCallOptions): Promise<CardSweep[]> {
    if (!this.dotk.api) return []
    const listed = await this.dotk.cardsOf(this.account.address, options)
    // The account's own pair and never the address alone. The signature's flavor follows the
    // scheme byte, so signing a card listed under another scheme signs for a script that card is
    // not spendable by.
    const mine = listed.filter(
      (c) =>
        (key === undefined || c.key === key.toLowerCase()) &&
        c.spenderType === this.account.ownerType &&
        c.spender.toLowerCase() === this.account.owner.toLowerCase()
    )
    const held: CardSweep[] = []
    for (const card of mine) {
      const sweep = await this.sweepOf(card, options)
      if (sweep && !this.struck(sweep.outpoint)) held.push(sweep)
    }
    return held
  }

  /**
   * The name's live card, or null, and whether that is an answer.
   *
   * The API lists the card, and the node proves it against `deed`: a live UTXO at the address the
   * card's own state derives, pinned to output 1 of the transaction that created the deed's
   * current UTXO, over a blob that hashes to what the card commits to. With no API nothing is
   * listed, an API that does not know the name did not reach it, and a listing the node refutes is
   * a hint and no more. Only an API that knows the name and lists no card, or one whose listed
   * card proves, is complete.
   *
   * With `optional`, a card this package cannot read answers no card rather than throwing. That
   * covers the API's listing and the node's answer for it alike. A transfer that writes no card
   * back reads one to say what it retires, so neither fault can block the transfer itself.
   */
  private async liveCardOf(
    name: string,
    deed: Deed,
    options: NodeCallOptions | undefined,
    need: 'required' | 'optional'
  ): Promise<{ card: Card | null; complete: boolean }> {
    const optional = need === 'optional'
    if (!this.dotk.api) return { card: null, complete: false }
    let resolved
    try {
      resolved = await this.dotk.resolveName(name, options)
    } catch (e) {
      // The caller's own cancellation is theirs to get back, as every node call here hands it
      // back.
      if (options?.signal?.aborted) throw options.signal.reason
      if (optional) return { card: null, complete: false }
      // A malformed listing is the API's fault and blocks the save, which is the safer direction.
      // The error names the API, so it does not read as a defect of this package.
      throw new TxError(`the API's listing for ${this.dotk.normalize(name)}.k is unreadable: ${String(e)}`, {
        cause: e,
      })
    }
    if (!resolved) return { card: null, complete: false }
    const card = resolved.card
    if (!card) return { card: null, complete: true }
    let utxos: SpendableUtxo[]
    try {
      utxos = await this.asked('node', options, (signal) =>
        this.node.utxosOf(card.address, signal ? { signal } : undefined)
      )
    } catch (e) {
      // The caller's own cancellation is theirs to get back. A node that cannot answer for the
      // card costs the listing and no more.
      if (!optional || options?.signal?.aborted) throw e
      return { card: null, complete: false }
    }
    const held = utxos.find(
      (u) => u.outpoint.transactionId.toLowerCase() === card.outpointTxid && u.outpoint.index === card.outpointIndex
    )
    try {
      verifyCard(
        { key: bytes32Of(deed.state.key, 'deed key'), outpointTxid: deed.utxo.outpoint.transactionId },
        cardState(
          bytes32Of(card.key, 'card key'),
          bytes32Of(card.recordsHash, 'card records hash'),
          card.spenderType,
          bytes32Of(card.spender, 'card spender')
        ),
        held ? { transactionId: held.outpoint.transactionId, index: held.outpoint.index } : undefined,
        bytesOf(card.blob, 'card blob')
      )
    } catch {
      return { card: null, complete: false }
    }
    return { card, complete: true }
  }

  /** The card as the node holds it, or undefined once it is spent. */
  private async sweepOf(card: Card, options?: NodeCallOptions): Promise<CardSweep | undefined> {
    const state = {
      key: bytes32Of(card.key, 'card key'),
      records: bytes32Of(card.recordsHash, 'card records hash'),
      spenderType: card.spenderType,
      spender: bytes32Of(card.spender, 'card spender'),
    }
    const utxos = await this.asked('node', options, (signal) =>
      this.node.utxosOf(card.address, signal ? { signal } : undefined)
    )
    const utxo = utxos.find(
      (u) => u.outpoint.transactionId.toLowerCase() === card.outpointTxid && u.outpoint.index === card.outpointIndex
    )
    if (!utxo) return undefined
    // The UTXO must pay to the script this state derives, or the signature asked for is over a
    // spend that nothing satisfies.
    if (utxo.scriptPublicKey.toLowerCase() !== toHex(cardScriptPublicKey(state))) {
      throw new TxError(`the UTXO at ${card.address} does not pay to the card's script`)
    }
    return { outpoint: utxo.outpoint, value: utxo.amount, state }
  }

  private requireSigner(): void {
    // Named here, because a plain-JavaScript signer that skips it otherwise fails with a
    // TypeError from inside this package, which reads as our defect.
    if (typeof this.signer.supportsOwnerScheme !== 'function') {
      throw new TxError('this signer implements no supportsOwnerScheme, so it cannot say which owner schemes it holds')
    }
    if (!this.signer.supportsOwnerScheme(this.account.ownerType)) {
      throw new TxError(`this wallet cannot authorize a deed held under owner scheme ${this.account.ownerType}`)
    }
  }

  private async feerate(options?: NodeCallOptions): Promise<number> {
    return this.asked('node', options, (signal) => this.node.feerate(signal ? { signal } : undefined))
  }

  /**
   * Cost and shape a transfer without asking the wallet for anything.
   *
   * With `records`, the transfer mints a card for the new owner beside the moved deed. By default
   * it also sweeps the cards this account minted on the name. Their value comes back with the
   * change.
   *
   * With an API this reads the name's live card either way, at one API call and one node probe. A
   * transfer that mints no card ends every subname the card holds, and `cards.subnamesDropped`
   * lists them for the seller to read before they sign.
   *
   * A transfer to another owner ends them too, `records` or not. That card is retired, so the
   * new owner's card seats the `sub:` entries `records` names and no other.
   */
  async planTransfer(name: string, to: string, options?: TransferOptions): Promise<TransferPlanned> {
    const registry = this.dotk.protocol
    const recipient = parseAddress(to, this.dotk.prefix)
    const target = ownerOfParsed(recipient)
    this.requireSigner()
    const drops = options?.dropSubnames ?? []
    if (drops.length > 0 && options?.records === undefined) {
      throw new TxError(
        'this plan mints no card, so it ends every subname already. Pass the `records` it writes back, or ' +
          'drop `dropSubnames`'
      )
    }

    const deed = await this.deedOf(name, options)
    // The same pair the covenant reads, so a save and a sale are told apart on the deed's own
    // state. A sale retires the card, so no `sub:` entry of it reaches the buyer's card.
    const sameOwner =
      target.ownerType === deed.state.ownerType && toHex(target.owner) === deed.state.owner.toLowerCase()
    if (drops.length > 0 && !sameOwner) {
      throw new TxError(
        'a transfer to another owner ends every subname on the card, so `dropSubnames` names nothing that stays'
      )
    }
    const cards: CardPlan = {
      sweep: options?.sweep === false ? [] : await this.cardsHeld(deed.state.key, options),
    }
    // Only a card the node proves against the deed just found, so a stale or planted listing
    // cannot inject values into the owner's next card or block a save. Every transfer reads it,
    // because a transfer retires the card and every subname on it, and the seller's signing
    // surface names what ends.
    const found = await this.liveCardOf(name, deed, options, options?.records === undefined ? 'optional' : 'required')
    const live = found.card
    // A card is pinned to the deed's outpoint, so this transfer retires the live card whoever
    // seated it, and a plan that retires one does something whatever it mints and sweeps. Only a
    // card the node proved counts, because a listing alone is a hint.
    if (live !== null) cards.retires = true
    let carried: string[] = []
    let dropped: string[] = []
    let subnames: PlannedSubname[] = []
    let subnamesDropped: DroppedSubname[] = []
    let complete = true
    if (options?.records !== undefined) {
      // A save replaces text and flags whole and keeps only what this version cannot show, so
      // the merge carries the live card's opaque values under keys the given set does not name.
      // A live card whose blob does not decode at all is refused, because a save from that state
      // mints a set that drops everything the card holds. `planRecords(name, null)` drops it on
      // purpose. Both need the live card, which only an API lists.
      complete = found.complete
      if (drops.length > 0 && !complete) {
        throw new TxError(
          `nobody can say what ${this.dotk.display(deed.state.name)}'s card carries, and a subname save writes ` +
            'back what it read. Wait for the API, or save the whole set with no `dropSubnames`'
        )
      }
      if (live !== null && live.records === null) throw new UndecodableCardError(this.dotk.normalize(name))
      const merged = mergeRecords(options.records, live?.records ?? {}, {
        prefix: this.dotk.prefix,
        dropSubnames: drops,
        sameOwner,
        name: this.dotk.display(deed.state.name),
      })
      carried = merged.carried
      dropped = merged.dropped
      subnames = merged.subnames
      subnamesDropped = merged.subnamesDropped
      refuseUnreachableSubnames(deed.state.name, subnames)
      // A card holding the empty map pays CARD_VALUE for nothing, so the last record to leave
      // takes the card with it.
      if (Object.keys(merged.records).length > 0) {
        cards.mint = cardMint(bytes32Of(deed.state.key, 'deed key'), merged.records, target.ownerType, target.owner)
      }
    } else if (live?.records) {
      // A transfer that mints no card ends every subname the live card holds.
      subnamesDropped = endingSubnames(live.records, this.dotk.prefix)
    }
    const plan = transferIntent(registry, registry.deedAbi, deed, target.ownerType, toHex(target.owner), cards)

    const funding = await this.spendable(options)
    const feerate = await this.feerate(options)
    const assembled = assemble(plan.base, {
      funding,
      changeScriptPublicKey: toHex(scriptPublicKeyOf(this.account.address, this.dotk)),
      feerate,
      requiredFunding: 0n,
      signedInputs: plan.cardInputs,
    })

    // The wallet signs every card input under the account's key, because `cardsHeld` lists only
    // cards naming this account's own (scheme, key) pair as spender.
    const ownerSigInputs = [plan.ownerSigInput, ...plan.cardInputs]
    const swept = cards.sweep.reduce((n, c) => n + c.value, 0n)
    return {
      name: deed.state.name,
      recipient: encodeAddress(recipient.prefix, recipient.version, recipient.payload),
      fromDeed: deedAddressOfState(registry, deed.state),
      toDeed: deedAddressOfState(registry, plan.next),
      fee: assembled.fee,
      cards: {
        minted: cards.mint !== undefined,
        swept: cards.sweep.length,
        value: (cards.mint ? BigInt(CARD_VALUE) : 0n) - swept,
        carried,
        dropped,
        subnames,
        subnamesDropped,
        cardRead: found.complete,
        complete,
      },
      request: {
        txJson: toSafeJson(assembled.tx),
        fundingInputs: assembled.fundingInputs,
        ownerSigInputs,
      },
      assembled,
      ownerSigInputs,
    }
  }

  /**
   * Cost and shape of registering a name: the commit, and the reveal on the commit's change.
   *
   * This method builds and measures both before it signs either. A funding amount can leave the
   * commit perfectly relayable and the reveal over KIP-9's storage floor, which shows only once
   * the second transaction stands on the first's remainder. In the other order the commit is on
   * chain by the time anyone finds out. The name is reserved, and the deposit is on its way to
   * whoever evicts it.
   *
   * The reveal carries no signature, because knowing the claim's preimage is its whole
   * authorization. Anyone holding the name and the owner key can therefore recover a registration
   * that half-lands, through {@link planActivate}.
   */
  async planRegistration(name: string, options?: RegisterOptions): Promise<RegistrationPlanned> {
    const registry = this.dotk.protocol
    this.requireSigner()
    const bare = this.dotk.normalize(name)
    const gap = this.confirmed(options?.gap ?? (await this.coveringGap(bare, options)), 'the covering gap')
    const owner = this.account
    const split = splitIntent(registry, gap, bare, owner.ownerType, owner.owner)

    const feerate = await this.feerate(options)
    const changeSpk = toHex(scriptPublicKeyOf(this.account.address, this.dotk))
    const tier = BigInt(feeForName(registry.params, bare))
    const buffer = options?.buffer ?? DEFAULT_REGISTRATION_BUFFER
    // Sized so the commit's change clears the reveal's own floor and not sized to be exact. An
    // exact target lands the remainder in the band a node refuses, and this package does not
    // widen a selection the caller handed it.
    const target =
      split.requiredFunding +
      (tier > BigInt(registry.params.deposit) ? tier - BigInt(registry.params.deposit) : 0n) +
      buffer
    const commit = assemble(split.base, {
      funding: await this.spendable(options),
      changeScriptPublicKey: changeSpk,
      feerate,
      requiredFunding: target,
    })
    const change = commit.changeIndex
    if (change < 0) {
      throw new TxError('this commit leaves no change to fund the reveal from. Fund this wallet with a larger coin')
    }

    const txid = transactionId(commit.tx)
    const pending: Pending = {
      key: split.newborn.key,
      claim: split.newborn.claim,
      outpoint: { transactionId: txid, index: split.newborn.outputIndex },
      amount: split.newborn.value,
      scriptPublicKey: split.base.outputs[split.newborn.outputIndex]!.scriptPublicKey,
      scriptVersion: 0,
      blockDaaScore: 0n,
      isCoinbase: false,
      covenantId: registry.registryCovenantId,
    }
    const activate = activateIntent(registry, pending, bare, owner.ownerType, owner.owner)
    const reveal = assemble(activate.base, {
      funding: [
        {
          outpoint: { transactionId: txid, index: change },
          amount: commit.tx.outputs[change]!.value,
          scriptPublicKey: changeSpk,
          scriptVersion: 0,
          blockDaaScore: 0n,
          isCoinbase: false,
        },
      ],
      changeScriptPublicKey: changeSpk,
      feerate,
      requiredFunding: activate.requiredFunding,
    })

    return {
      name: bare,
      deed: deedAddressOfState(registry, {
        key: split.newborn.key,
        ownerType: owner.ownerType,
        owner: owner.owner,
        name: bare,
      }),
      tier: activate.fee,
      fee: commit.fee + reveal.fee,
      locked: BigInt(registry.params.bond) + BigInt(registry.params.gap_value),
      commit: {
        request: { txJson: toSafeJson(commit.tx), fundingInputs: commit.fundingInputs, ownerSigInputs: [] },
        assembled: commit,
        ownerSigInputs: [],
      },
      reveal: {
        request: { txJson: toSafeJson(reveal.tx), fundingInputs: reveal.fundingInputs, ownerSigInputs: [] },
        assembled: reveal,
        ownerSigInputs: [],
      },
    }
  }

  /**
   * Plan a registration, take both signatures, and send both halves in order.
   *
   * This method takes the reveal's signature before it sends the commit, so a refusal at the
   * wallet costs a prompt, not a name committed to and unrevealed. If the node refuses the reveal
   * after the commit lands, the error names {@link planActivate}, which rebuilds the reveal from
   * another coin.
   */
  async register(name: string, options?: RegisterOptions): Promise<{ commit: string; reveal: string }> {
    const planned = await this.planRegistration(name, options)
    const commitTx = await this.signedTx(planned.commit)
    const revealTx = await this.signedTx(planned.reveal)
    const commit = await this.send(commitTx, options)
    try {
      return { commit, reveal: await this.send(revealTx, options) }
    } catch (cause) {
      throw new TxError(
        `${planned.name} is committed but not revealed. The commit is on chain and a node refused its reveal. ` +
          `Run planActivate('${planned.name}') to finish it from another coin, before anyone can evict it`,
        { cause }
      )
    }
  }

  /**
   * Cost and shape of the reveal for a registration whose commit landed on its own.
   *
   * The reveal carries no signature, so anyone holding the name, the owner scheme and the owner
   * key can rebuild it, and this account holds all three. Until it lands the name is reserved and
   * the deposit is at risk, so this is the way back in when {@link register} reports a reveal the
   * node refused. The PENDING deed is found as every other fact here is, by deriving its address
   * and reading the chain.
   */
  async planActivate(name: string, options?: NodeCallOptions): Promise<ActivationPlanned> {
    const registry = this.dotk.protocol
    this.requireSigner()
    const bare = this.dotk.normalize(name)
    const owner = this.account
    const key = fromHex(this.dotk.keyOf(bare))
    const claim = names.claimOf(bare, owner.ownerType, bytes32Of(owner.owner, 'owner'))
    const at = registry.deed.address(this.dotk.prefix, encodePendingDeedState(key, claim)).text
    const utxos = await this.asked('node', options, (signal) => this.node.utxosOf(at, signal ? { signal } : undefined))
    const held = utxos.find((u) => u.covenantId?.toLowerCase() === registry.registryCovenantId)
    if (!held) {
      throw new TxError(
        `the node holds no PENDING deed for ${this.dotk.display(bare)} claimed by ${this.account.address}, ` +
          'so there is no registration of it to finish'
      )
    }
    this.confirmed(held, `the PENDING deed of ${this.dotk.display(bare)}`)
    const pending: Pending = {
      key: toHex(key),
      claim: toHex(claim),
      outpoint: held.outpoint,
      amount: held.amount,
      scriptPublicKey: held.scriptPublicKey,
      scriptVersion: held.scriptVersion,
      blockDaaScore: held.blockDaaScore,
      isCoinbase: held.isCoinbase,
      covenantId: held.covenantId ?? undefined,
    }
    const activate = activateIntent(registry, pending, bare, owner.ownerType, owner.owner)
    const funding = await this.spendable(options)
    const feerate = await this.feerate(options)
    const assembled = assemble(activate.base, {
      funding,
      changeScriptPublicKey: toHex(scriptPublicKeyOf(this.account.address, this.dotk)),
      feerate,
      requiredFunding: activate.requiredFunding,
    })
    return {
      name: bare,
      deed: deedAddressOfState(registry, {
        key: toHex(key),
        ownerType: owner.ownerType,
        owner: owner.owner,
        name: bare,
      }),
      tier: activate.fee,
      fee: assembled.fee,
      request: { txJson: toSafeJson(assembled.tx), fundingInputs: assembled.fundingInputs, ownerSigInputs: [] },
      assembled,
      ownerSigInputs: [],
    }
  }

  /**
   * Cost and shape of ending a registration. The exit merge spends the deed with the two gaps
   * flanking it, and writes one widened gap.
   *
   * A gap's address hashes from its bounds and nothing in the name yields them, so the node can
   * confirm a pair but never find one. This method takes the pair from the API and proves it
   * against the node, as it proves every other fact here. A client with no API configured must
   * pass the pair itself.
   */
  async planRelease(name: string, options?: ReleaseOptions): Promise<ReleasePlanned> {
    const registry = this.dotk.protocol
    this.requireSigner()
    const deed = await this.deedOf(name, options)
    // Widened, so a pair passed from plain JavaScript under the API's own field names is refused
    // by name rather than failing inside this package.
    const given: { pred?: Gap | undefined; succ?: Gap | undefined } | undefined = options?.neighbours
    if (given && (!given.pred || !given.succ)) {
      throw new TxError('neighbours must carry `pred` and `succ`, each a gap as the node reports it')
    }
    const { pred, succ } = options?.neighbours ?? (await this.neighboursOf(deed.state.key, options))
    this.confirmed(pred, 'the predecessor gap')
    this.confirmed(succ, 'the successor gap')
    const plan = releaseIntent(registry, deed, pred, succ)

    const funding = await this.spendable(options)
    const feerate = await this.feerate(options)
    const assembled = assemble(plan.base, {
      funding,
      changeScriptPublicKey: toHex(scriptPublicKeyOf(this.account.address, this.dotk)),
      feerate,
      requiredFunding: 0n,
    })
    return {
      name: deed.state.name,
      fromDeed: deedAddressOfState(registry, deed.state),
      fee: assembled.fee,
      returned: plan.released - assembled.fee,
      request: {
        txJson: toSafeJson(assembled.tx),
        fundingInputs: assembled.fundingInputs,
        ownerSigInputs: plan.ownerSigInputs,
      },
      assembled,
      ownerSigInputs: plan.ownerSigInputs,
    }
  }

  /** Plan a release and submit it. */
  async release(name: string, options?: ReleaseOptions): Promise<string> {
    return this.submit(await this.planRelease(name, options), options)
  }

  /**
   * The gap covering a free key, taken from the API and proved against the node.
   *
   * A gap's address hashes from its bounds and nothing in the name yields them, so the API names a
   * candidate and the node says whether it is there under this registry's covenant id. A wrong
   * gap builds a commit the covenant refuses after a wallet approved it.
   */
  private async coveringGap(name: string, options?: NodeCallOptions): Promise<Gap> {
    const api = this.dotk.api
    if (!api) {
      throw new ConfigError(
        'registering needs the gap covering the name, and a gap is found by its bounds rather than by the name. ' +
          'Configure `api`, or pass `gap` yourself'
      )
    }
    const answer = await api.key(this.dotk.keyOf(name), options)
    if (answer.kind !== 'free' || !answer.covering) {
      throw new TxError(`${this.dotk.display(name)} is not free, so there is no gap to split`)
    }
    return this.provedGap(answer.covering, 'covering', options)
  }

  /**
   * The two gaps flanking a live key, taken from the API and proved against the node.
   *
   * The API names the bounds, and the node says whether a gap of those bounds is there and
   * carries this registry's covenant id. This client builds no merge from a pair that does not
   * prove. The covenant checks the same adjacency, and it refuses after a wallet already
   * approved.
   */
  private async neighboursOf(key: string, options?: NodeCallOptions): Promise<{ pred: Gap; succ: Gap }> {
    const api = this.dotk.api
    if (!api) {
      throw new ConfigError(
        'ending a registration needs the two gaps flanking the name, and a gap is found by its bounds rather than by the name. ' +
          'Configure `api`, or pass `neighbours` yourself'
      )
    }
    const answer = await api.key(key, options)
    const neighbours = answer.neighbours
    if (!neighbours) {
      throw new TxError(`the API serves no flanking gaps for ${key}, so there is no merge to build`)
    }
    return {
      pred: await this.provedGap(neighbours.predecessor, 'predecessor', options),
      succ: await this.provedGap(neighbours.successor, 'successor', options),
    }
  }

  /** One gap the API named, proved on the node under this registry's covenant id. */
  private async provedGap(bounds: { lo: string; hi: string }, what: string, options?: NodeCallOptions): Promise<Gap> {
    const state = encodeGapState(bytes32Of(bounds.lo, `${what} gap lo`), bytes32Of(bounds.hi, `${what} gap hi`))
    const spk = toHex(this.dotk.protocol.gap.scriptPublicKey(state))
    const at = this.dotk.protocol.gap.address(this.dotk.prefix, state).text
    const found = await this.asked('node', options, (signal) => this.node.utxosOf(at, signal ? { signal } : undefined))
    const utxo = found.find(
      (u) => u.scriptPublicKey.toLowerCase() === spk && u.covenantId?.toLowerCase() === this.dotk.registryCovenantId
    )
    if (!utxo) {
      throw new TxError(`the node holds no ${what} gap at the bounds the API named, so a node refuses this`)
    }
    return { ...utxo, lo: bounds.lo, hi: bounds.hi, covenantId: utxo.covenantId ?? undefined }
  }

  /**
   * Cost and shape of saving a name's records, which is a transfer to the owner the name already
   * has. It sweeps the account's old cards on the name and mints one card carrying `records`. A
   * `null` clears the records and mints nothing, and so does a set that merges to nothing.
   *
   * The merge carries every `sub:` entry of the live card `records` does not name, and
   * `options.dropSubnames` is the one way to end one.
   */
  async planRecords(name: string, records: Records | null, options?: RecordsOptions): Promise<TransferPlanned> {
    const opts: TransferOptions = { ...options, sweep: true }
    if (records !== null) opts.records = records
    return this.planTransfer(name, this.account.address, opts)
  }

  /**
   * Cost and shape of a sweep of the cards this account left behind. It takes every card the API
   * lists for its key that the node still holds, or only one name's. The cards pay their own fee,
   * so this sweep touches no coin of the account's.
   */
  async planSweep(name?: string, options?: NodeCallOptions): Promise<SweepPlanned> {
    this.requireSigner()
    const key = name === undefined ? undefined : this.dotk.keyOf(this.dotk.normalize(name))
    const cards = await this.cardsHeld(key, options)
    if (cards.length === 0) {
      throw new TxError(
        'no card of this account is left at the node to sweep. Without an api none is listed, and one this registrar already swept is not offered again'
      )
    }
    const assembled = assembleSweep(
      cards,
      toHex(scriptPublicKeyOf(this.account.address, this.dotk)),
      await this.feerate(options)
    )
    const ownerSigInputs = cards.map((_, at) => at)
    return {
      cards: cards.length,
      value: assembled.tx.outputs[0]!.value,
      fee: assembled.fee,
      request: { txJson: toSafeJson(assembled.tx), fundingInputs: [], ownerSigInputs },
      assembled,
      ownerSigInputs,
    }
  }

  /** Sign a plan with the configured wallet and submit it. Answers the transaction id. */
  async submit(planned: Planned, options?: NodeCallOptions): Promise<string> {
    return this.send(await this.signedTx(planned), options)
  }

  /**
   * A plan the wallet signed, not yet broadcast. Apart from {@link submit}, this is what lets a
   * registration take both approvals before this package sends either half.
   */
  private async signedTx(planned: Planned): Promise<Tx> {
    const signed = await this.signer.sign(planned.request)
    return applySignatures(planned.assembled.tx, signed, planned.assembled.fundingInputs, planned.ownerSigInputs, {
      ownerType: this.account.ownerType,
      owner: this.account.owner,
    })
  }

  /**
   * Broadcast a signed transaction and answer its id.
   *
   * A refusal the mempool worded is a `SubmitError` with its verdict. Everything else comes back
   * as itself: the caller's own cancel, and a `NodeError` for a socket that dropped or a call
   * that timed out. Whether the node took the transaction before such a failure is unknown, so
   * its coins count as spent until a resync says otherwise. Offering them again would buy the
   * user a second prompt for a transaction that cannot go through.
   */
  private async send(tx: Tx, options?: NodeCallOptions): Promise<string> {
    const strike = (into: Set<string>) => {
      for (const input of tx.inputs) into.add(outpointKey(input.previousOutpoint))
    }
    let txid: string
    try {
      txid = await this.asked('node', options, (signal) => this.node.submit(tx, signal ? { signal } : undefined))
    } catch (e) {
      if (options?.signal?.aborted) {
        strike(this.doubtful)
        throw options.signal.reason
      }
      // `asked` wraps what the socket threw, and the node's own refusal arrives the same way. The
      // verdict tells them apart: a mempool refusal classifies, and a transport failure does not.
      const cause = e instanceof Error && e.cause instanceof Error ? e.cause : e
      const message = cause instanceof Error ? cause.message : String(cause)
      const verdict = classify(message)
      if (verdict === 'unknown') {
        strike(this.doubtful)
        throw e
      }
      throw new SubmitError(`the node refused the transaction: ${message}`, verdict, { cause })
    }
    strike(this.spent)
    return txid
  }

  /** Move a name to another address: plan, sign and send. */
  async transfer(name: string, to: string, options?: TransferOptions): Promise<string> {
    return this.submit(await this.planTransfer(name, to, options), options)
  }

  /** Save a name's records, or clear them with `null`: plan, sign and send. */
  async saveRecords(name: string, records: Records | null, options?: RecordsOptions): Promise<string> {
    return this.submit(await this.planRecords(name, records, options), options)
  }

  /** Reclaim the cards this account left behind: plan, sign and send. */
  async sweep(name?: string, options?: NodeCallOptions): Promise<string> {
    return this.submit(await this.planSweep(name, options), options)
  }
}

/** The locking script an ordinary address pays to, for the change output. */
function scriptPublicKeyOf(address: string, dotk: Dotk): Uint8Array {
  const parsed = parseAddress(address, dotk.prefix)
  const { ownerType } = ownerOfParsed(parsed)
  if (ownerType === OwnerType.Pubkey) return schnorrScript(parsed.payload)
  if (ownerType === OwnerType.P2pkEcdsaEven || ownerType === OwnerType.P2pkEcdsaOdd) return ecdsaScript(parsed.payload)
  if (ownerType === OwnerType.ScriptHash) return p2shScript(parsed.payload)
  throw new TxError(`change cannot be paid to an address of kind ${ownerType}`)
}

export { scriptPublicKeyOf }
