// The transaction as this package holds it, and the "safe JSON" body a wallet is handed.
//
// Amounts are `bigint` here and strings on the wire, which is the form the Kaspa wasm SDK
// serializes to and every wallet in scope parses.

import { SigningError } from './errors.js'
import { transactionId } from './sighash.js'

export const SUBNETWORK_ID_NATIVE = '0000000000000000000000000000000000000000'

/** Where a UTXO sits. */
export interface Outpoint {
  transactionId: string
  index: number
}

/** The UTXO an input spends, as the node reported it. */
export interface UtxoEntry {
  /** The KIP-20 covenant id the output carries, when it carries one. */
  covenantId?: string | undefined
  /** In sompi. */
  amount: bigint
  /** The locking script, hex, without its version. */
  scriptPublicKey: string
  scriptVersion: number
  blockDaaScore: bigint
  isCoinbase: boolean
  /** The address the script pays to, which is how some wallets find their own inputs. */
  address?: string | undefined
}

/** The entry a node reports for a coin, as an input carries it. `covenantId` stays absent where the node said none. */
export function utxoEntryOf(u: {
  amount: bigint
  scriptPublicKey: string
  scriptVersion: number
  blockDaaScore: bigint
  isCoinbase: boolean
  covenantId?: string | undefined | null
}): UtxoEntry {
  return {
    amount: u.amount,
    scriptPublicKey: u.scriptPublicKey,
    scriptVersion: u.scriptVersion,
    blockDaaScore: u.blockDaaScore,
    isCoinbase: u.isCoinbase,
    covenantId: u.covenantId ?? undefined,
  }
}

export interface TxInput {
  previousOutpoint: Outpoint
  /** Hex. Empty for a funding input until the wallet fills it in. */
  signatureScript: string
  sequence: bigint
  computeBudget: number
  utxo: UtxoEntry
}

/** The lineage tag an output carries, and the input that authorizes it to. */
export interface CovenantBinding {
  authorizingInput: number
  covenantId: string
}

export interface TxOutput {
  value: bigint
  scriptPublicKey: string
  scriptVersion: number
  covenant?: CovenantBinding | undefined
}

export interface Tx {
  version: number
  inputs: TxInput[]
  outputs: TxOutput[]
  lockTime: bigint
  subnetworkId: string
  gas: bigint
  payload: string
}

/** A transaction with nothing in it but the protocol seats, before funding and change. */
export function emptyTx(): Tx {
  return {
    version: 1,
    inputs: [],
    outputs: [],
    lockTime: 0n,
    subnetworkId: SUBNETWORK_ID_NATIVE,
    gas: 0n,
    payload: '',
  }
}

function hexLen(hex: string): number {
  return hex.length >> 1
}

/** A script public key on the wire: the version as big-endian hex, then the script. */
function scriptHex(version: number, script: string): string {
  return version.toString(16).padStart(4, '0') + script
}

/**
 * The body this package gives a wallet and hands the node back, in the wasm SDK's "safe JSON"
 * form.
 *
 * Amounts and scores are decimal strings, and an outpoint's two fields sit directly on the
 * input. A script public key is one hex string that carries its version. `id` is the transaction
 * id, which this package can compute before a wallet signs anything.
 */
export function toSafeJson(tx: Tx): string {
  return JSON.stringify({
    id: transactionId(tx),
    version: tx.version,
    inputs: tx.inputs.map((i) => ({
      transactionId: i.previousOutpoint.transactionId,
      index: i.previousOutpoint.index,
      sequence: i.sequence.toString(),
      sigOpCount: 0,
      computeBudget: i.computeBudget,
      signatureScript: i.signatureScript,
      utxo: {
        address: i.utxo.address ?? null,
        amount: i.utxo.amount.toString(),
        scriptPublicKey: scriptHex(i.utxo.scriptVersion, i.utxo.scriptPublicKey),
        blockDaaScore: i.utxo.blockDaaScore.toString(),
        isCoinbase: i.utxo.isCoinbase,
        covenantId: i.utxo.covenantId ?? null,
      },
    })),
    outputs: tx.outputs.map((o) => ({
      value: o.value.toString(),
      scriptPublicKey: scriptHex(o.scriptVersion, o.scriptPublicKey),
      covenant:
        o.covenant === undefined
          ? null
          : { authorizingInput: o.covenant.authorizingInput, covenantId: o.covenant.covenantId },
    })),
    subnetworkId: tx.subnetworkId,
    lockTime: tx.lockTime.toString(),
    gas: tx.gas.toString(),
    storageMass: '0',
    payload: tx.payload,
  })
}

/** A wallet's answer, read only for the parts this package compares or adopts. */
export interface SignedBody {
  inputs: { signatureScript: string; transactionId?: string | undefined; index?: number | undefined }[]
  outputs?: { value?: string | undefined; scriptPublicKey?: string | undefined }[] | undefined
}

/**
 * A wallet's answer as this package reads it. A malformed answer is a `SigningError` that names
 * the part, because a wallet that answers nonsense is the wallet's fault and not a bug here.
 */
export function parseSignedBody(json: string): SignedBody {
  let body: unknown
  try {
    body = JSON.parse(json)
  } catch (e) {
    throw new SigningError('the signed transaction is not JSON', { cause: e })
  }
  if (typeof body !== 'object' || body === null || !Array.isArray((body as { inputs?: unknown }).inputs)) {
    throw new SigningError('the signed transaction carries no inputs')
  }
  const raw = body as { inputs: unknown[]; outputs?: unknown }
  const inputs = raw.inputs.map((i, at) => {
    if (typeof i !== 'object' || i === null)
      throw new SigningError(`input ${at} of the signed transaction is not an object`)
    const { signatureScript, transactionId, index } = i as Record<string, unknown>
    if (
      signatureScript !== undefined &&
      (typeof signatureScript !== 'string' || !/^([0-9a-f]{2})*$/i.test(signatureScript))
    ) {
      throw new SigningError(`input ${at} of the signed transaction carries a signature script that is not hex`)
    }
    if (transactionId !== undefined && typeof transactionId !== 'string') {
      throw new SigningError(`input ${at} of the signed transaction carries an outpoint that is not text`)
    }
    if (index !== undefined && typeof index !== 'number') {
      throw new SigningError(`input ${at} of the signed transaction carries an outpoint index that is not a number`)
    }
    return {
      signatureScript: signatureScript ?? '',
      ...(transactionId === undefined ? {} : { transactionId }),
      ...(index === undefined ? {} : { index }),
    }
  })
  if (raw.outputs === undefined) return { inputs }
  if (!Array.isArray(raw.outputs)) throw new SigningError('the signed transaction carries outputs that are not a list')
  const outputs = raw.outputs.map((o, at) => {
    if (typeof o !== 'object' || o === null)
      throw new SigningError(`output ${at} of the signed transaction is not an object`)
    const { value, scriptPublicKey } = o as Record<string, unknown>
    if (value !== undefined && typeof value !== 'string') {
      throw new SigningError(`output ${at} of the signed transaction carries a value that is not text`)
    }
    if (scriptPublicKey !== undefined && typeof scriptPublicKey !== 'string') {
      throw new SigningError(`output ${at} of the signed transaction carries a script that is not text`)
    }
    return { ...(value === undefined ? {} : { value }), ...(scriptPublicKey === undefined ? {} : { scriptPublicKey }) }
  })
  return { inputs, outputs }
}

export { hexLen, scriptHex }
