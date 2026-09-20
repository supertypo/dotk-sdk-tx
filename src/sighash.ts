// What a signature over one input commits to.
//
// Every field and its order is `kaspa_consensus_core::hashing::sighash`, and the corpus in
// `tests/` replays that implementation's digests. A wrong digest here raises no error. It is a
// well-formed signature that satisfies nothing, and the first symptom is a node refusing the
// transaction.
//
// This package builds only SIGHASH_ALL, so the branches for the other types are absent and not
// dead. Each of those zeroes a different sub-hash.

import { toHex } from '@dotk/sdk'
import { SIGHASH_ALL } from './sign.js'
import { bytesOf } from './hex.js'
import {
  PayloadDigest,
  TransactionRest,
  TransactionSigningHash,
  TransactionSigningHashECDSA,
  TransactionV1Id,
  Writer,
} from './hashers.js'
import { SUBNETWORK_ID_NATIVE, type Tx, type TxOutput } from './tx.js'

const ZERO_HASH = new Uint8Array(32)

function scriptPublicKeyInto(w: Writer, version: number, script: string): void {
  w.u16(version).varBytes(bytesOf(script, 'script public key'))
}

function outputInto(w: Writer, output: TxOutput, version: number): void {
  w.u64(output.value)
  scriptPublicKeyInto(w, output.scriptVersion, output.scriptPublicKey)
  if (version >= 1) {
    w.bool(output.covenant !== undefined)
    if (output.covenant !== undefined) {
      w.u16(output.covenant.authorizingInput).bytes(bytesOf(output.covenant.covenantId, 'covenant id'))
    }
  }
}

function previousOutputsHash(tx: Tx): Uint8Array {
  const w = new Writer()
  for (const input of tx.inputs) {
    w.bytes(bytesOf(input.previousOutpoint.transactionId, 'transaction id')).u32(input.previousOutpoint.index)
  }
  return TransactionSigningHash(w.finish())
}

function sequencesHash(tx: Tx): Uint8Array {
  const w = new Writer()
  for (const input of tx.inputs) w.u64(input.sequence)
  return TransactionSigningHash(w.finish())
}

function outputsHash(tx: Tx): Uint8Array {
  const w = new Writer()
  for (const output of tx.outputs) outputInto(w, output, tx.version)
  return TransactionSigningHash(w.finish())
}

/** Zero for a native subnetwork with no payload, which is every transaction this builds. */
function payloadHash(tx: Tx): Uint8Array {
  if (tx.subnetworkId === SUBNETWORK_ID_NATIVE && tx.payload.length === 0) return ZERO_HASH
  return TransactionSigningHash(new Writer().varBytes(bytesOf(tx.payload, 'payload')).finish())
}

/** The digest a schnorr signature over `inputIndex` commits to, under SIGHASH_ALL. */
export function schnorrSighash(tx: Tx, inputIndex: number): Uint8Array {
  const input = tx.inputs[inputIndex]
  if (!input) throw new RangeError(`no input ${inputIndex}`)
  const w = new Writer()
  w.u16(tx.version).bytes(previousOutputsHash(tx)).bytes(sequencesHash(tx))
  // A version-0 transaction carries the sig-op-count hash here, and a sig-op count byte after
  // the sequence. Covenant transactions are version 1 and carry neither.
  w.bytes(bytesOf(input.previousOutpoint.transactionId, 'transaction id')).u32(input.previousOutpoint.index)
  scriptPublicKeyInto(w, input.utxo.scriptVersion, input.utxo.scriptPublicKey)
  w.u64(input.utxo.amount).u64(input.sequence)
  w.bytes(outputsHash(tx))
    .u64(tx.lockTime)
    .bytes(bytesOf(tx.subnetworkId, 'subnetwork id'))
    .u64(tx.gas)
    .bytes(payloadHash(tx))
    .u8(SIGHASH_ALL)
  return TransactionSigningHash(w.finish())
}

/** The same commitment re-hashed for ECDSA, which signs under a different hash family. */
export function ecdsaSighash(tx: Tx, inputIndex: number): Uint8Array {
  return TransactionSigningHashECDSA(schnorrSighash(tx, inputIndex))
}

/**
 * The transaction id. Signature scripts, the payload and the mass commitment are all outside it,
 * so a transaction can be identified before a wallet signs it and one can be chained on another
 * that nobody broadcast yet.
 */
export function transactionId(tx: Tx): string {
  if (tx.version < 1) throw new RangeError('only version 1 transactions are built here')
  const w = new Writer()
  w.u16(tx.version).len(tx.inputs.length)
  for (const input of tx.inputs) {
    w.bytes(bytesOf(input.previousOutpoint.transactionId, 'transaction id')).u32(input.previousOutpoint.index)
    w.varBytes(new Uint8Array(0)) // the signature script is excluded
    w.u64(input.sequence)
    // The compute budget rides with the mass commitment, which the id excludes.
  }
  w.len(tx.outputs.length)
  for (const output of tx.outputs) outputInto(w, output, tx.version)
  w.u64(tx.lockTime).bytes(bytesOf(tx.subnetworkId, 'subnetwork id')).u64(tx.gas)
  w.varBytes(new Uint8Array(0)) // the payload is excluded

  const payload = PayloadDigest(bytesOf(tx.payload, 'payload'))
  const rest = TransactionRest(w.finish())
  const both = new Uint8Array(64)
  both.set(payload)
  both.set(rest, 32)
  return toHex(TransactionV1Id(both))
}
