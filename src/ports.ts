// What this package needs from outside itself: coins, a way to send, and something that holds a
// key. A wallet already has all three, so none of these is a new capability.

import type { NodeCallOptions } from '@dotk/sdk'
import type { Outpoint, Tx } from './tx.js'

/** One spendable output at an address, as a node reports it. */
export interface SpendableUtxo {
  outpoint: Outpoint
  /** In sompi. */
  amount: bigint
  /** The locking script, hex, without its version. */
  scriptPublicKey: string
  scriptVersion: number
  blockDaaScore: bigint
  isCoinbase: boolean
  /**
   * The KIP-20 covenant id, when the output carries one. The type accepts `null` as well as
   * `undefined`, because wRPC JSON spells an absent one as `null`, so an adapter that passes the
   * node's answer through does not have to normalize it.
   */
  covenantId?: string | null | undefined
}

/**
 * The node, as a transaction needs it. Only the chain knows which UTXO a name is and what it
 * holds, so this package reads an outpoint and a value here and never from the API.
 */
export interface TxNode {
  /** Every spendable output at an address, for funding and for reading a covenant UTXO. */
  utxosOf(address: string, options?: NodeCallOptions): Promise<SpendableUtxo[]>
  /** The node's current estimate, in sompi per gram. */
  feerate(options?: NodeCallOptions): Promise<number>
  /**
   * The virtual DAA score, which dates every UTXO the node reports. Optional, and its absence is
   * not an error. Without it this package cannot age a coinbase output, so it can select an
   * immature one that the node then refuses.
   */
  daaScore?(options?: NodeCallOptions): Promise<bigint>
  /**
   * Broadcast a signed transaction and answer its id. The argument is the transaction and not a
   * serialized body, because how it goes on the wire belongs to the transport. `toSafeJson` and
   * `toRpcTransaction` are the two shapes.
   */
  submit(tx: Tx, options?: NodeCallOptions): Promise<string>
}

/** Which inputs a wallet is being asked to sign, and what for. */
export interface SignRequest {
  /** The assembled transaction, in the wasm SDK's safe-JSON form. */
  txJson: string
  /**
   * Ordinary coins at the account's own address. Their signature scripts are the wallet's
   * and are adopted whole.
   */
  fundingInputs: number[]
  /**
   * Seats the account's key signs under this package's own script: a covenant seat that consents
   * to its own spend, and a card under a sweep. The script carries a 65-byte placeholder, and
   * only those bytes are taken from the wallet's answer.
   */
  ownerSigInputs: number[]
}

/**
 * A wallet, reduced to what a covenant spend needs: a signing oracle.
 *
 * It must sign the named inputs by index and not by their scripts, under SIGHASH_ALL. It must
 * return the transaction otherwise unchanged.
 */
export interface Signer {
  sign(request: SignRequest): Promise<string>
  /**
   * Whether this wallet can authorize a deed held under an owner scheme. Ask before building a
   * transaction, because a signature of the wrong flavor is a well-formed 65 bytes that fails
   * only at consensus.
   */
  supportsOwnerScheme(ownerType: number): boolean
}

/** The account a transaction is built for: its address and the owner record it stands for. */
export interface Account {
  address: string
  ownerType: number
  owner: string
}
