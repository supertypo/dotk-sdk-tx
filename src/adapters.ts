// The node, reached the two ways a wallet already has one. `@dotk/sdk` has the same pair for
// reading, and these are the write half, which needs more from each UTXO and two calls beyond it.
//
// Every field below is named as the client actually spells it, and the two clients agree on none
// of them. The wasm SDK hands back objects with getters, a script already split from its version,
// and amounts as BigInt. wRPC JSON hands back a flat record with the version glued to the front of
// the script, amounts as numbers, and `null` where the wasm has `undefined`.
//
// Either client must be new enough to report covenant ids, because without one a deed reads as an
// ordinary coin.

import { TxError } from './errors.js'
import {
  fromWasm as readFromWasm,
  type WasmRpcClient as ReadWasmClient,
  type WasmUtxoEntryReference as ReadWasmEntry,
  fromWrpcJson as readFromWrpcJson,
  type Node as ReadNode,
  type NodeCallOptions,
} from '@dotk/sdk'
import type { SpendableUtxo, TxNode } from './ports.js'
import { toSafeJson } from './tx.js'
import type { Tx } from './tx.js'

/**
 * `UtxoEntryReference`, as the wasm SDK returns it from `getUtxosByAddresses`.
 *
 * Declared structurally and not imported, so this package depends on no wasm build. `amount` and
 * `blockDaaScore` are getters returning `u64`, which crosses as a BigInt in the builds this
 * package has met and is read as a number too.
 * `scriptPublicKey.version` is a struct field, which crosses as a number.
 */
export interface TxWasmUtxoEntryReference extends ReadWasmEntry {
  outpoint: { transactionId: string; index: number }
  /** A `u64` crosses as a BigInt, and a build that crosses it as a number is read the same. */
  amount: bigint | number
  scriptPublicKey: { version: number; script: string }
  blockDaaScore: bigint | number
  isCoinbase: boolean
}

/** The calls a transfer makes, as the wasm SDK's `RpcClient` declares them. */
export interface TxWasmRpcClient extends ReadWasmClient {
  getUtxosByAddresses(request: { addresses: string[] }): Promise<{ entries: TxWasmUtxoEntryReference[] }>
  /** Only reached when a caller gives `txNodeOverWasm` a network to confirm. */
  getServerInfo?(): Promise<{ networkId?: string }>
  getFeeEstimate(request: Record<string, never>): Promise<{ estimate?: FeeEstimate }>
  submitTransaction(request: {
    transaction: unknown
    allowOrphan?: boolean
  }): Promise<{ transactionId?: string | undefined } | null | undefined>
}

/** `IFeeEstimate`. The priority bucket is the fallback, because a node always has one. */
interface FeeEstimate {
  normalBuckets?: { feerate: number }[] | undefined
  priorityBucket?: { feerate: number } | undefined
}

/** The bucket this package prices a transfer at, or 1 sompi per gram when the node named none. */
function feerateOf(estimate: FeeEstimate | undefined): number {
  return estimate?.normalBuckets?.[0]?.feerate ?? estimate?.priorityBucket?.feerate ?? 1
}

/**
 * A node behind the wasm SDK's `RpcClient`, already connected.
 *
 * Pass a function where the client is replaced over time, such as a wallet that tears its RPC
 * down when idle. A captured reference to the old client waits forever.
 *
 * Give `network` (`dotk.network`) and the first call confirms the node is on it.
 */
export function txNodeOverWasm(client: TxWasmRpcClient | (() => TxWasmRpcClient), network?: string): TxNode {
  const rpc = typeof client === 'function' ? client : () => client
  const guard = networkGuard(network, async () => {
    const live = rpc()
    if (!live.getServerInfo) throw new TxError('this client cannot report its network, so it cannot be confirmed')
    return (await live.getServerInfo()).networkId
  })
  return {
    async utxosOf(address, options) {
      await guard(options)
      const { entries } = await rpc().getUtxosByAddresses({ addresses: [address] })
      return entries.map((e): SpendableUtxo => {
        const covenantId = e.entry?.covenantId
        return {
          outpoint: { transactionId: e.outpoint.transactionId, index: e.outpoint.index },
          amount: BigInt(e.amount),
          // Already without its version here, unlike wRPC JSON, which carries the two glued.
          scriptPublicKey: e.scriptPublicKey.script,
          scriptVersion: e.scriptPublicKey.version,
          blockDaaScore: BigInt(e.blockDaaScore),
          isCoinbase: e.isCoinbase,
          ...(covenantId ? { covenantId: covenantId.toString() } : {}),
        }
      })
    },

    async feerate(options) {
      await guard(options)
      return feerateOf((await rpc().getFeeEstimate({})).estimate)
    },

    async submit(tx, options) {
      await guard(options)
      // The wasm SDK builds a `Transaction` from any object of this shape, which is the same
      // body the wallet was handed to sign.
      const answer = await rpc().submitTransaction({ transaction: JSON.parse(toSafeJson(tx)), allowOrphan: false })
      // A node that names nothing, or answers nothing at all, is a node that did not accept.
      if (!answer?.transactionId) throw new TxError('the node accepted the transaction without naming it')
      return answer.transactionId
    },
  }
}

/** A node behind a wRPC JSON transport: `call(method, params)` answers the parsed result. */
export type WrpcCall = (method: string, params: unknown, options?: NodeCallOptions) => Promise<unknown>

/**
 * Both halves of one client: what `@dotk/sdk` reads through and what this package writes through.
 * They are different interfaces because they need different things, and a wallet has one client.
 */
export interface Nodes {
  read: ReadNode
  tx: TxNode
}

/** Both halves over one wasm `RpcClient`. */
export function nodesOver(client: TxWasmRpcClient | (() => TxWasmRpcClient), network?: string): Nodes {
  return { read: readFromWasm(client), tx: txNodeOverWasm(client, network) }
}

/** Both halves over one wRPC JSON transport. */
export function nodesOverWrpc(call: WrpcCall, network?: string): Nodes {
  return { read: readFromWrpcJson(call), tx: txNodeOverWrpc(call, network) }
}

/** One `RpcUtxosByAddressesEntry` as wRPC JSON spells it. */
interface WrpcUtxoEntry {
  outpoint: { transactionId: string; index: number }
  utxoEntry: {
    amount: number
    scriptPublicKey: string
    blockDaaScore: number
    isCoinbase: boolean
    covenantId?: string | null | undefined
  }
}

/**
 * A node behind a wRPC JSON transport you already have. {@link WrpcJson} is one, and `nodeOver`
 * wraps it.
 *
 * Amounts cross as JSON numbers, which is the node's choice. {@link encodeRequest} keeps the
 * amounts this package sends exact.
 *
 * Give `network` (`dotk.network`) and the first call confirms the node is on it.
 */
export function txNodeOverWrpc(call: WrpcCall, network?: string): TxNode {
  const guard = networkGuard(
    network,
    async (options) => ((await call('getServerInfo', {}, options)) as { networkId?: string }).networkId
  )
  return {
    async utxosOf(address, options) {
      await guard(options)
      const answer = (await call('getUtxosByAddresses', { addresses: [address] }, options)) as {
        entries: WrpcUtxoEntry[]
      }
      return answer.entries.map((e): SpendableUtxo => {
        const entry = e.utxoEntry
        return {
          outpoint: e.outpoint,
          amount: BigInt(entry.amount),
          // The version rides on the front of the script here, and the rest of this package
          // wants the two apart.
          scriptVersion: parseInt(entry.scriptPublicKey.slice(0, 4), 16),
          scriptPublicKey: entry.scriptPublicKey.slice(4),
          blockDaaScore: BigInt(entry.blockDaaScore),
          isCoinbase: entry.isCoinbase,
          ...(entry.covenantId ? { covenantId: entry.covenantId } : {}),
        }
      })
    },

    async feerate(options) {
      await guard(options)
      const answer = (await call('getFeeEstimate', {}, options)) as { estimate?: FeeEstimate }
      return feerateOf(answer.estimate)
    },

    async submit(tx, options) {
      await guard(options)
      const answer = (await call(
        'submitTransaction',
        { transaction: toRpcTransaction(tx), allowOrphan: false },
        options
      )) as { transactionId?: string | undefined } | null | undefined
      if (!answer?.transactionId) throw new TxError('the node accepted the transaction without naming it')
      return answer.transactionId
    },
  }
}

/**
 * Confirm once, before the first read, that the node is on the chain this registry lives on. A
 * node on another chain reports no deed at the address, so the name reads as unheld, and the
 * coins it does report belong to another ledger.
 */
function networkGuard(network: string | undefined, ask: (options?: NodeCallOptions) => Promise<string | undefined>) {
  let confirmed: Promise<void> | undefined
  return async (options?: NodeCallOptions) => {
    if (network === undefined) return
    // Only a success is remembered. Memoizing the promise itself would remember a rejection too,
    // so one blocked socket or one canceled call would make every later call replay that failure
    // and never ask the node again.
    confirmed ??= (async () => {
      const actual = await ask(options)
      if (actual !== network) {
        throw new TxError(`this node is on ${actual ?? 'an unnamed network'}, the registry is on ${network}`)
      }
    })().catch((reason: unknown) => {
      confirmed = undefined
      throw reason
    })
    await confirmed
  }
}

/** The transaction as `submitTransaction` takes it over wRPC, field for field. */
export interface RpcTransaction {
  version: number
  inputs: {
    previousOutpoint: { transactionId: string; index: number }
    signatureScript: string
    sequence: bigint
    sigOpCount: number
    computeBudget: number
    verboseData: null
  }[]
  outputs: {
    value: bigint
    scriptPublicKey: string
    verboseData: null
    covenant: { authorizingInput: number; covenantId: string } | null
  }[]
  lockTime: bigint
  subnetworkId: string
  gas: bigint
  payload: string
  storageMass: number
  mass: number
  verboseData: null
}

/**
 * The transaction as `submitTransaction` takes it over wRPC, which is not the body this package
 * hands a wallet. The RPC shape carries `verboseData` slots, amounts as numbers, and the storage
 * mass under two names.
 */
export function toRpcTransaction(tx: Tx): RpcTransaction {
  return {
    version: tx.version,
    inputs: tx.inputs.map((i) => ({
      previousOutpoint: { transactionId: i.previousOutpoint.transactionId, index: i.previousOutpoint.index },
      signatureScript: i.signatureScript,
      sequence: i.sequence,
      sigOpCount: 0,
      computeBudget: i.computeBudget,
      verboseData: null,
    })),
    outputs: tx.outputs.map((o) => ({
      // A number here rounds above 2^53, and the signature commits to the exact amount, so the
      // node refuses the transaction as a bad signature and names nothing. `WrpcJson` writes a
      // bigint out as a JSON number, so the digits survive.
      value: o.value,
      scriptPublicKey: o.scriptVersion.toString(16).padStart(4, '0') + o.scriptPublicKey,
      verboseData: null,
      covenant:
        o.covenant === undefined
          ? null
          : { authorizingInput: o.covenant.authorizingInput, covenantId: o.covenant.covenantId },
    })),
    lockTime: tx.lockTime,
    subnetworkId: tx.subnetworkId,
    gas: tx.gas,
    payload: tx.payload,
    // Both spellings, as the node's own serialization emits them. The node accepts either one
    // and refuses the pair when they disagree. Storage mass is contextual, so nothing here
    // sets it.
    storageMass: 0,
    mass: 0,
    verboseData: null,
  }
}
