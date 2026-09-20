// The record merge: the writer's rule over a card's records and its `sub:` entries, which is
// what a save carries, refuses, or drops. Nothing here touches a node or a registrar.

import {
  type Records,
  SUBNAME_PREFIX,
  SubnameError,
  ownerAddress,
  subnamePair,
  utf8,
  putRecord,
  type RecordValue,
  names,
} from '@dotk/sdk'
import { TxError } from './errors.js'

/** The hex of an opaque value, or undefined for anything else, including a shape a JS caller hands in. */
function opaqueOf(value: unknown): string | undefined {
  const hex: unknown = (value as { opaque?: unknown } | null | undefined)?.opaque
  return typeof hex === 'string' ? hex : undefined
}

/** Two opaque values with the same bytes, whatever the case of their hex. */
function sameOpaque(a: RecordValue | undefined, b: RecordValue): boolean {
  const left = opaqueOf(a)
  const right = opaqueOf(b)
  if (left === undefined || right === undefined) return false
  return left.toLowerCase() === right.toLowerCase()
}

/**
 * Two record values that name the same value. An opaque value is compared under one case of its
 * hex, which answers for the bytes it holds.
 */
function sameValue(a: RecordValue | undefined, b: RecordValue): boolean {
  if (typeof a === 'string' || typeof a === 'boolean') return a === b
  return sameOpaque(a, b)
}

/** Whether a record set holds this key at all, including one it holds with a falsy value. */
function holds(records: Records, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(records, key)
}

/**
 * Plain byte order over two record keys, which is the order `subnames` in `@dotk/sdk` lists a
 * card's entries in, so a plan and a listing name them alike.
 */
function byteOrder(a: string, b: string): number {
  const x = utf8.encode(a)
  const y = utf8.encode(b)
  for (let at = 0; at < Math.min(x.length, y.length); at++) {
    if (x[at] !== y[at]) return x[at]! - y[at]!
  }
  return x.length - y.length
}

/** Every `sub:` key of a record set, in the order a listing shows them. */
function subnameKeysOf(records: Records): string[] {
  return Object.keys(records)
    .filter((key) => key.startsWith(SUBNAME_PREFIX))
    .sort(byteOrder)
}

/**
 * One entry's payee, or the fault that names why it has none. `prefix` is the registry's
 * network prefix, which renders the pair as an address. `subnamePair` refuses the one scheme
 * that has no address, so the null below is out of reach through it.
 */
function payeeOf(key: string, value: RecordValue, prefix: string): { address: string | null; fault?: string } {
  const { ownerType, owner } = subnamePair(key, value)
  return { address: ownerAddress(prefix, ownerType, owner) ?? null }
}

/** One `sub:` entry as a drop reports it: the label the card stores, and the payee it paid. */
function droppedSubname(key: string, value: RecordValue, prefix: string): DroppedSubname {
  const label = key.slice(SUBNAME_PREFIX.length)
  try {
    return { label, ...payeeOf(key, value, prefix) }
  } catch (e) {
    if (!(e instanceof SubnameError)) throw e
    return { label, address: null, fault: e.tag }
  }
}

/** Every subname a card ends, in the shape a drop reports, for a transfer that mints no card. */
export function endingSubnames(live: Records, prefix: string): DroppedSubname[] {
  return subnameKeysOf(live).map((key) => droppedSubname(key, live[key]!, prefix))
}

/**
 * One `sub:` entry of a merged set: its payee or its fault, and how the save changes it. A row
 * that carries a `fault` carries a null address with it.
 */
export interface PlannedSubname {
  /** The label as the card stores it, which the label rule can refuse. */
  label: string
  /** The payee this entry names, or null where it names none. */
  address: string | null
  /** Why the entry names no payee, as `SubnameError.tag` spells it. */
  fault?: string | undefined
  /**
   * The entry against the live card's: `added`, `changed`, or the same value back. A transfer
   * to another owner retires that card, so there every entry is `added`.
   */
  change: 'added' | 'changed' | 'unchanged'
}

/**
 * One `sub:` entry this transfer ends, with the payee it paid. A save ends one through
 * `dropSubnames`. A transfer that mints no card, and a transfer to another owner, end every
 * entry the live card holds. Every listing here is in key-byte order, whatever order the
 * caller named the labels in.
 */
export interface DroppedSubname {
  /** The label as the card stores it, which the label rule can refuse. */
  label: string
  /** The payee it paid, or null where the stored value names none. */
  address: string | null
  /** Why the removed value names no payee, as `SubnameError.tag` spells it. */
  fault?: string | undefined
}

/** What {@link mergeRecords} answers: the set to mint, and what a signing surface shows. */
export interface MergedRecords {
  /** The record set the new card carries. A card is minted only while it holds something. */
  records: Records
  /** The keys of the live card's opaque values the set carries forward. */
  carried: string[]
  /** The keys of the live card's opaque values the set replaces. */
  dropped: string[]
  /** Every `sub:` entry the new card carries, in the order a card lists them. */
  subnames: PlannedSubname[]
  /** Every `sub:` entry this merge ends, with the payee each one paid. */
  subnamesDropped: DroppedSubname[]
}

/** What a caller can tell {@link mergeRecords}, beyond the two record sets. */
export interface MergeOptions {
  /**
   * The registry's network prefix, which renders every payee in the two subname listings. A
   * record set that holds a `sub:` entry needs it, and a set without one needs nothing.
   */
  prefix?: string | undefined
  /** The labels this save removes, each as the live card stores it. */
  dropSubnames?: string[] | undefined
  /**
   * Whether the card this merge mints stays with the owner the live card's deed has. It
   * defaults to true, which is a save.
   *
   * A transfer to another owner passes false. That transfer retires the card and every subname
   * on it, so the merge carries no `sub:` entry of the live card. The new owner's card seats the
   * entries the given set names and no other, and `subnamesDropped` names every entry that ends
   * and nothing re-seats.
   *
   * Every given `sub:` entry counts as added there, so a seller who reads the live set and hands
   * it back whole strips the `sub:` keys first, or the refused ones throw.
   */
  sameOwner?: boolean | undefined
  /** The name this merge is for, as a reader spells it, for the refusals this function words. */
  name?: string | undefined
}

/**
 * The given set over the live card's. This function carries every opaque value under a key the
 * set does not name. It drops one under a key the set does name, for the value given. A save
 * replaces the live card's text and flags whole.
 *
 * A `sub:` entry is carried instead of replaced, which is the writer's rule `@dotk/sdk` sets. A
 * save keeps every one the given set does not name, readable or refused, and only `dropSubnames`
 * ends one. A carried subname stays out of
 * `carried`, which names the opaque values a surface shows as unreadable, and appears in the two
 * subname listings instead.
 *
 * `options.sameOwner` false is the other half. The transfer retires the card, so the merge
 * carries no `sub:` entry at all and lists every one of them as ended.
 *
 * This function refuses a `sub:` entry the given set adds or changes that no reader can pay, by
 * the subname rules `@dotk/sdk` applies, with the `SubnameError` that names the fault. The same value back is the entry
 * staying where it is, which a set read from the card and handed back whole does.
 *
 * `dropSubnames` holds the label as the card stores it, without the label rule. A counterparty
 * can seat `sub:Bob`, and a client that reads the key must be able to remove it. A drop of a
 * label the live card does not hold is refused, and so is one the given set also names.
 *
 * `options.prefix` renders every payee the two listings carry. Either set holding a `sub:` entry
 * without it is refused, because no listing can say who such an entry pays.
 */
export function mergeRecords(given: Records, live: Records, options?: MergeOptions): MergedRecords {
  const sameOwner = options?.sameOwner ?? true
  const whose = options?.name === undefined ? 'the live card' : `${options.name}'s live card`
  const prefix = options?.prefix
  if (prefix === undefined && (subnameKeysOf(given).length > 0 || subnameKeysOf(live).length > 0)) {
    throw new TxError(
      "a record set with a `sub:` entry needs the registry's network prefix to list the payees, so pass `prefix`"
    )
  }
  const records: Records = {}
  for (const [key, value] of Object.entries(given)) putRecord(records, key, value)
  const carried: string[] = []
  const dropped: string[] = []
  for (const [key, value] of Object.entries(live)) {
    if (key.startsWith(SUBNAME_PREFIX)) {
      if (sameOwner && !holds(given, key)) putRecord(records, key, value)
      continue
    }
    if (typeof value === 'string' || typeof value === 'boolean') continue
    if (!holds(given, key)) {
      putRecord(records, key, value)
      carried.push(key)
    } else if (sameOpaque(given[key], value)) {
      // The same opaque value back is the round trip `@dotk/sdk` asks of an integrator, so the
      // value is kept and listed as carried.
      carried.push(key)
    } else {
      dropped.push(key)
    }
  }

  const subnamesDropped: DroppedSubname[] = []
  for (const label of options?.dropSubnames ?? []) {
    const key = SUBNAME_PREFIX + label
    if (!holds(live, key)) throw new TxError(`${whose} carries no ${key} to drop`)
    if (holds(given, key)) throw new TxError(`${key} is both given a value and dropped, so nothing can say which wins`)
    const value = records[key]
    if (value === undefined) continue
    // A record set is a plain map under the card's own keys, and a drop removes one of them.
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- the key is the drop
    delete records[key]
    // The refusal above proves a prefix wherever a `sub:` entry is, and this loop reaches one
    // only through a key the live card holds.
    subnamesDropped.push(droppedSubname(key, value, prefix!))
  }
  // A transfer to another owner ends every subname the live card holds, whatever the new card
  // seats. The seller reads all of them in one list before they sign.
  if (!sameOwner) {
    // One mark per label. An entry the given set re-seats is listed as added and never as ended.
    for (const key of subnameKeysOf(live)) {
      if (!holds(given, key)) subnamesDropped.push(droppedSubname(key, live[key]!, prefix!))
    }
  }

  // Every listing this function answers is in key-byte order, and a drop list is a caller's
  // argument order until here.
  subnamesDropped.sort((a, b) => byteOrder(SUBNAME_PREFIX + a.label, SUBNAME_PREFIX + b.label))

  const subnames: PlannedSubname[] = []
  for (const key of subnameKeysOf(records)) {
    const value = records[key]!
    const change = !sameOwner || !holds(live, key) ? 'added' : sameValue(live[key], value) ? 'unchanged' : 'changed'
    try {
      subnames.push({ label: key.slice(SUBNAME_PREFIX.length), ...payeeOf(key, value, prefix!), change })
    } catch (e) {
      if (!(e instanceof SubnameError)) throw e
      // A writer refuses to write an entry no reader can pay, and carries one the card already
      // holds. Nobody pays for an entry no lookup reaches, and nobody destroys one a later reader
      // can pay. The fault rides on `cause`, where the tag is.
      if (change !== 'unchanged') {
        throw new TxError(`this transfer cannot write ${key}: ${e.message}`, { cause: e })
      }
      subnames.push({ label: key.slice(SUBNAME_PREFIX.length), address: null, fault: e.tag, change })
    }
  }
  return { records, carried, dropped, subnames, subnamesDropped }
}

/** The display suffix without its dot: the one name whose subnames no reader reaches. */
function suffixName(): string {
  return names.DISPLAY_SUFFIX.startsWith('.') ? names.DISPLAY_SUFFIX.slice(1) : names.DISPLAY_SUFFIX
}

/**
 * A new or changed subname under the one name no reader reaches, refused before a wallet signs.
 *
 * A reader strips one display suffix, so `bob.k.k` splits as the name `bob.k` and never as a
 * label under `k`, and nobody pays for an entry no lookup reaches. A card that already carries
 * one is another matter, because a counterparty builds the transaction an owner signs. That
 * holder can still save, carry and drop what their card holds.
 */
export function refuseUnreachableSubnames(name: string, subnames: PlannedSubname[]): void {
  if (name !== suffixName()) return
  for (const entry of subnames) {
    if (entry.change === 'unchanged') continue
    throw new TxError(
      `no reader reaches ${SUBNAME_PREFIX}${entry.label} under ${name}${names.DISPLAY_SUFFIX}, ` +
        `because a reader strips one ${names.DISPLAY_SUFFIX} suffix`
    )
  }
}
