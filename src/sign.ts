// Where a signing oracle's answer becomes our transaction. This module compares what came back
// against what went out, and adopts only the bytes it asked for.

import { OwnerType, toHex, isSpenderType } from '@dotk/sdk'
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js'
import { SigningError } from './errors.js'
import { bytes32Of, bytesOf } from './hex.js'
import { FUNDING_SIG_SCRIPT_LEN } from './assemble.js'
import { SIG_LEN } from './transfer.js'
import { ecdsaSighash, schnorrSighash } from './sighash.js'
import { keyOfScript, pushesOf } from './script.js'
import { parseSignedBody, scriptHex, type Tx } from './tx.js'

/** The only sighash type this package ever builds under. */
export const SIGHASH_ALL = 0x01

/** The opcode that pushes 65 bytes, which is the shape a signature always arrives in. */
const PUSH_65 = 0x41

/**
 * The first 65-byte push in a script, found by walking pushes instead of scanning bytes.
 *
 * A covenant seat's script pushes the new owner's 32-byte key before the signature, and about one
 * key in eight contains the byte that begins a 65-byte push. Scanning for that byte finds the
 * key's interior first and reads 65 bytes from the wrong offset, which fails an honest wallet's
 * signature and rarely accepts the wrong bytes as one.
 */
export function firstSigPush(script: Uint8Array): Uint8Array | undefined {
  const at = pushOffsets(script)[0]
  return at === undefined ? undefined : script.slice(at, at + SIG_LEN)
}

/** Where each 65-byte push's payload begins, in script order. */
function pushOffsets(script: Uint8Array): number[] {
  return pushesOf(script)
    .filter((p) => p.len === SIG_LEN)
    .map((p) => p.at)
}

/**
 * The signature out of a wallet's answer for one covenant seat.
 *
 * This function refuses the placeholder. A wallet that declined to sign returns the bytes it was
 * given, and 65 zeros are well-formed and spend nothing.
 *
 * It refuses any sighash type but SIGHASH_ALL too, and this is the last place that refusal can
 * happen. A type that leaves an output unsigned makes the change output rewritable by anyone.
 */
export function acceptWalletSig(signatureScript: Uint8Array): Uint8Array {
  const sig = firstSigPush(signatureScript)
  if (!sig) throw new SigningError('the wallet returned no 65-byte signature for a seat it was asked to sign')
  if (sig.every((b) => b === 0)) throw new SigningError('the wallet returned the unsigned placeholder')
  if (sig[SIG_LEN - 1] !== SIGHASH_ALL) {
    throw new SigningError(`the wallet signed under sighash type ${sig[SIG_LEN - 1]}, and only SIGHASH_ALL is built`)
  }
  return sig
}

/**
 * A funding input's script, which this package adopts whole instead of patching.
 *
 * It must be the canonical single push. 66 bytes is the length the fee converged against, and a
 * longer one broadcasts a transaction heavier than what the fee paid for.
 */
export function acceptFundingSigScript(signatureScript: Uint8Array): Uint8Array {
  if (signatureScript.length !== FUNDING_SIG_SCRIPT_LEN || signatureScript[0] !== PUSH_65) {
    throw new SigningError(
      `a funding input's signature script must be ${FUNDING_SIG_SCRIPT_LEN} bytes pushing one signature, got ${signatureScript.length}`
    )
  }
  acceptWalletSig(signatureScript)
  return signatureScript
}

/**
 * Verify a signature against what it must commit to.
 *
 * Every other refusal here is about shape, and a signature of the right shape over the wrong
 * transaction passes all of them, as does one of the wrong flavor. Without this the first thing
 * to notice is a node refusing the transaction after the user approved it.
 *
 * The flavor follows the owner's scheme byte and never the script, exactly as the covenant
 * chooses between `checkSig` and `checkSigEcdsa`.
 */
export function verifySignature(tx: Tx, inputIndex: number, ownerType: number, owner: string, sig: Uint8Array): void {
  // A co-present input approves a co-present owner, so there is no key here to verify against
  // and building one would be inventing it.
  if (!isSpenderType(ownerType)) {
    throw new SigningError(
      `owner scheme ${ownerType} is approved by co-presence rather than by a signature, so there is no key to test one against`
    )
  }
  const raw = sig.slice(0, 64)
  const key = bytes32Of(owner, 'owner')
  const ok =
    ownerType === OwnerType.Pubkey
      ? schnorr.verify(raw, schnorrSighash(tx, inputIndex), key)
      : secp256k1.verify(raw, ecdsaSighash(tx, inputIndex), compressed(ownerType, key), {
          format: 'compact',
          prehash: false,
        })
  if (!ok) {
    throw new SigningError(
      `the signature for input ${inputIndex} is not valid for this transaction under owner scheme ` +
        `${ownerType}. A signature of the wrong flavor is well formed and satisfies nothing`
    )
  }
}

/**
 * Verify a funding input's signature against the key its own UTXO pays to. Its locking script
 * names that key outright, so nothing excuses adopting a signature over it unverified.
 *
 * This package verifies an owner seat against the account's record instead, because a deed pays
 * to a script and the key appears nowhere in it.
 */
export function verifyFundingSignature(tx: Tx, inputIndex: number, sig: Uint8Array): void {
  const input = tx.inputs[inputIndex]!
  if (input.utxo.scriptVersion !== 0) {
    throw new SigningError(
      `input ${inputIndex} pays to a version ${input.utxo.scriptVersion} script, and only version 0 is standard`
    )
  }
  const paysTo = keyOfScript(bytesOf(input.utxo.scriptPublicKey, 'script public key'))
  if (!paysTo) {
    throw new SigningError(`input ${inputIndex} does not pay to an address this package can test a signature against`)
  }
  const raw = sig.slice(0, 64)
  const ok =
    paysTo.kind === 'schnorr'
      ? schnorr.verify(raw, schnorrSighash(tx, inputIndex), paysTo.key)
      : secp256k1.verify(raw, ecdsaSighash(tx, inputIndex), paysTo.key, { format: 'compact', prehash: false })
  if (!ok) {
    throw new SigningError(`the signature for funding input ${inputIndex} is not valid for this transaction`)
  }
}

/** The key the covenant rebuilds for an ECDSA owner. It is the parity from the scheme, then the x. */
function compressed(ownerType: number, owner: Uint8Array): Uint8Array {
  const out = new Uint8Array(33)
  out[0] = 0x02 | (ownerType & 0x01)
  out.set(owner, 1)
  return out
}

/** Write a signature over the placeholder in our own script. Its length does not change. */
export function patchPlaceholder(script: Uint8Array, sig: Uint8Array): Uint8Array {
  const at = pushOffsets(script).find((offset) => {
    for (let i = 0; i < SIG_LEN; i++) if (script[offset + i] !== 0) return false
    return true
  })
  if (at === undefined) throw new SigningError('this transaction carries no placeholder to sign into')
  const patched = script.slice()
  patched.set(sig, at)
  return patched
}

/** The owner an account's deeds are held under, as the pair a deed stores. */
export interface OwnerRecord {
  ownerType: number
  owner: string
}

/**
 * Merge a wallet's answer into our transaction. Ours is what goes out, and the wallet's body is
 * read for signatures and nothing else, so an altered value, output or covenant seat earns a
 * refusal and changes nothing.
 */
export function applySignatures(
  tx: Tx,
  signedJson: string,
  fundingInputs: number[],
  ownerSigInputs: number[],
  /**
   * The account whose seats the wallet signs. It is required, because this package verifies a
   * signature against it.
   */
  owner: OwnerRecord
): Tx {
  const body = parseSignedBody(signedJson)
  if (body.inputs.length !== tx.inputs.length) {
    throw new SigningError(
      `the wallet returned ${body.inputs.length} inputs for a transaction with ${tx.inputs.length}`
    )
  }

  // A signature commits to the whole transaction, so one signed over a body that is not ours
  // does not verify against the one we send. A refusal here names the wallet, where consensus
  // names nothing and arrives after the user approved.
  body.inputs.forEach((returned, at) => {
    const ours = tx.inputs[at]!.previousOutpoint
    const moved =
      (returned.transactionId !== undefined && returned.transactionId !== ours.transactionId) ||
      (returned.index !== undefined && returned.index !== ours.index)
    if (moved) throw new SigningError(`the wallet returned a different outpoint at input ${at}`)
  })
  if (body.outputs) {
    if (body.outputs.length !== tx.outputs.length) {
      throw new SigningError(
        `the wallet returned ${body.outputs.length} outputs for a transaction with ${tx.outputs.length}`
      )
    }
    body.outputs.forEach((returned, at) => {
      const ours = tx.outputs[at]!
      if (returned.value !== undefined && returned.value !== ours.value.toString()) {
        throw new SigningError(`the wallet altered the value of output ${at}`)
      }
      const script = returned.scriptPublicKey
      if (
        script !== undefined &&
        script.toLowerCase() !== scriptHex(ours.scriptVersion, ours.scriptPublicKey).toLowerCase()
      ) {
        throw new SigningError(`the wallet altered the script of output ${at}`)
      }
    })
  }

  const funding = new Set(fundingInputs)
  const owners = new Set(ownerSigInputs)

  const inputs = tx.inputs.map((input, at) => {
    const returned = bytesOf(body.inputs[at]!.signatureScript, `input ${at} signature script`)
    if (owners.has(at)) {
      const sig = acceptWalletSig(returned)
      verifySignature(tx, at, owner.ownerType, owner.owner, sig)
      return {
        ...input,
        signatureScript: toHex(patchPlaceholder(bytesOf(input.signatureScript, 'signature script'), sig)),
      }
    }
    if (funding.has(at)) {
      const script = acceptFundingSigScript(returned)
      verifyFundingSignature(tx, at, script.slice(1))
      return { ...input, signatureScript: toHex(script) }
    }
    if (toHex(returned) !== input.signatureScript) {
      throw new SigningError(`the wallet altered the signature script of input ${at}, which it was not asked to sign`)
    }
    return input
  })
  return { ...tx, inputs }
}
