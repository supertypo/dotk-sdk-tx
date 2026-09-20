import { Dotk, OwnerType, encodeActiveDeedState, fromHex, hex32, toHex } from '@dotk/sdk'
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js'
import { describe, expect, it } from 'vitest'
import { assemble } from '../src/assemble.js'
import { SigningError } from '../src/errors.js'
import { ecdsaSighash, schnorrSighash } from '../src/sighash.js'
import {
  SIGHASH_ALL,
  acceptFundingSigScript,
  acceptWalletSig,
  applySignatures,
  firstSigPush,
  patchPlaceholder,
  verifyFundingSignature,
  verifySignature,
} from '../src/sign.js'
import { transferIntent } from '../src/transfer.js'
import type { Tx } from '../src/tx.js'

const dotk = new Dotk({ api: null, network: 'testnet-10' })
const registry = dotk.protocol
const PUSH_65 = 0x41

const ownerKey = schnorr.utils.randomSecretKey()
const fundingKey = schnorr.utils.randomSecretKey()
const ownerPub = toHex(schnorr.getPublicKey(ownerKey))
const strangerPub = toHex(schnorr.getPublicKey(fundingKey))

/** A recipient key whose bytes contain 0x41, which about one key in eight does. */
function keyContainingPushByte(): string {
  for (let tries = 0; tries < 500; tries++) {
    const pub = schnorr.getPublicKey(schnorr.utils.randomSecretKey())
    if (pub.includes(PUSH_65)) return toHex(pub)
  }
  throw new Error('no key with a 0x41 byte in 500 tries, which is astronomically unlikely')
}

/** A P2PK locking script, so a funding signature can be checked against the key it names. */
function p2pk(secret: Uint8Array): string {
  return toHex(Uint8Array.of(0x20, ...schnorr.getPublicKey(secret), 0xac))
}

function stateBytes(name: string, ownerType: number, owner: string): Uint8Array {
  const padded = new Uint8Array(32)
  padded.set(new TextEncoder().encode(name))
  return encodeActiveDeedState(fromHex(dotk.keyOf(name)), ownerType, hex32(owner, 'owner'), padded)
}

interface Built {
  tx: Tx
  fundingInputs: number[]
  ownerSigInputs: number[]
}

/** A real transfer: a deed the owner key holds, funded by a coin the funding key holds. */
function transferTo(newOwner: string, newOwnerType: number = OwnerType.Pubkey): Built {
  const name = 'kaspa'
  const state = stateBytes(name, OwnerType.Pubkey, ownerPub)
  const plan = transferIntent(
    registry,
    registry.deedAbi,
    {
      state: { key: dotk.keyOf(name), ownerType: OwnerType.Pubkey, owner: ownerPub, name },
      utxo: {
        outpoint: { transactionId: 'aa'.repeat(32), index: 0 },
        amount: BigInt(registry.params.bond),
        scriptPublicKey: toHex(registry.deed.scriptPublicKey(state)),
        scriptVersion: 0,
        blockDaaScore: 0n,
        isCoinbase: false,
        covenantId: registry.registryCovenantId,
      },
    },
    newOwnerType,
    newOwner
  )
  const assembled = assemble(plan.base, {
    funding: [
      {
        outpoint: { transactionId: 'bb'.repeat(32), index: 1 },
        amount: 10_000_000_000n,
        scriptPublicKey: p2pk(fundingKey),
        scriptVersion: 0,
        blockDaaScore: 0n,
        isCoinbase: false,
      },
    ],
    changeScriptPublicKey: p2pk(fundingKey),
    feerate: 1,
    requiredFunding: 0n,
  })
  return { tx: assembled.tx, fundingInputs: assembled.fundingInputs, ownerSigInputs: [plan.ownerSigInput] }
}

function signature(secret: Uint8Array, digest: Uint8Array, hashType = SIGHASH_ALL): Uint8Array {
  const sig = new Uint8Array(65)
  sig.set(schnorr.sign(digest, secret))
  sig[64] = hashType
  return sig
}

const push = (sig: Uint8Array) => Uint8Array.of(PUSH_65, ...sig)

/**
 * A wallet's answer, in the shape a real one returns: the covenant seat comes back as this package's own
 * script with the placeholder filled in, not as a bare signature. A convenient stand-in hides
 * that difference, and hides any defect that turns on it.
 */
function walletAnswer(built: Built, over: { owner?: Uint8Array; funding?: Uint8Array } = {}): string {
  const ownerSig = over.owner ?? signature(ownerKey, schnorrSighash(built.tx, 0))
  const fundingSig = over.funding ?? signature(fundingKey, schnorrSighash(built.tx, 1))
  const seat = patchPlaceholder(fromHex(built.tx.inputs[0]!.signatureScript), ownerSig)
  return JSON.stringify({
    inputs: [
      { signatureScript: toHex(seat), transactionId: 'aa'.repeat(32), index: 0 },
      { signatureScript: toHex(push(fundingSig)), transactionId: 'bb'.repeat(32), index: 1 },
    ],
  })
}

const record = { ownerType: OwnerType.Pubkey, owner: ownerPub }

describe('finding the signature in a script', () => {
  it('walks pushes rather than scanning for the push byte', () => {
    const decoy = new Uint8Array(32).fill(PUSH_65)
    const real = new Uint8Array(65).fill(0x7e)
    expect(toHex(firstSigPush(Uint8Array.of(0x20, ...decoy, PUSH_65, ...real))!)).toBe(toHex(real))
  })

  it('reads a signature behind a long push', () => {
    const long = new Uint8Array(300).fill(PUSH_65)
    const real = new Uint8Array(65).fill(0x7e)
    const script = Uint8Array.of(0x4d, 300 & 0xff, 300 >> 8, ...long, PUSH_65, ...real)
    expect(toHex(firstSigPush(script)!)).toBe(toHex(real))
  })

  /**
   * A scheme byte leads the script, and an ECDSA recipient's is a plain one-byte push, so the
   * script begins `0x01 0x85` or `0x01 0x86`; the single-opcode leads the encoder writes for a
   * small integer are covered by the unit test on the encoder itself. A reader that stops at
   * the first thing that is not a push finds no signature at all, for every such recipient.
   */
  it('reads past the scheme byte that leads a transfer to an ECDSA recipient', () => {
    const secret = secp256k1.utils.randomSecretKey()
    const pub = secp256k1.getPublicKey(secret, true)
    const ownerType = pub[0] === 0x02 ? OwnerType.P2pkEcdsaEven : OwnerType.P2pkEcdsaOdd
    const built = transferTo(toHex(pub.slice(1)), ownerType)
    expect(Array.from(fromHex(built.tx.inputs[0]!.signatureScript).slice(0, 2))).toEqual([0x01, ownerType])
    const merged = applySignatures(built.tx, walletAnswer(built), built.fundingInputs, built.ownerSigInputs, record)
    expect(merged.inputs[0]!.signatureScript).not.toBe(built.tx.inputs[0]!.signatureScript)
  })

  it('reads past OP_1NEGATE, the one-opcode form of the byte 0x81', () => {
    const real = new Uint8Array(65).fill(0x7e)
    const script = Uint8Array.of(0x4f, 0x20, ...new Uint8Array(32).fill(7), PUSH_65, ...real)
    expect(toHex(firstSigPush(script)!)).toBe(toHex(real))
  })

  it('answers nothing when there is no 65-byte push', () => {
    expect(firstSigPush(Uint8Array.of(0x20, ...new Uint8Array(32)))).toBeUndefined()
    expect(firstSigPush(Uint8Array.of(PUSH_65, 0x00))).toBeUndefined()
  })

  /**
   * About one recipient key in eight carries the push byte. Anything scanning for that byte
   * finds the key's interior before the signature: an honest wallet is refused, and once in
   * every 256 of those the wrong 65 bytes are adopted as a signature.
   */
  it('accepts an honest wallet whose recipient key contains the push byte', () => {
    const newOwner = keyContainingPushByte()
    expect(fromHex(newOwner).includes(PUSH_65)).toBe(true)
    const built = transferTo(newOwner)
    const merged = applySignatures(built.tx, walletAnswer(built), built.fundingInputs, built.ownerSigInputs, record)
    expect(merged.inputs[0]!.signatureScript).not.toBe(built.tx.inputs[0]!.signatureScript)
  })
})

describe('what a wallet is allowed to hand back', () => {
  const built = transferTo(strangerPub)

  it('adopts both signatures and leaves our script otherwise as it was', () => {
    const merged = applySignatures(built.tx, walletAnswer(built), built.fundingInputs, built.ownerSigInputs, record)
    const seat = fromHex(merged.inputs[0]!.signatureScript)
    const ours = fromHex(built.tx.inputs[0]!.signatureScript)
    expect(seat.length).toBe(ours.length)
    expect(toHex(seat.slice(0, 35))).toBe(toHex(ours.slice(0, 35)))
    expect(toHex(seat.slice(101))).toBe(toHex(ours.slice(101)))
    expect(fromHex(merged.inputs[1]!.signatureScript).length).toBe(66)
  })

  /** An answer that is not the shape asked for is refused by name, never as a TypeError from inside. */
  it('refuses a malformed answer as a signing error that names the part', () => {
    const merge = (answer: string) => () =>
      applySignatures(built.tx, answer, built.fundingInputs, built.ownerSigInputs, record)
    expect(merge('nope')).toThrow(SigningError)
    expect(merge('{"inputs":"x"}')).toThrow(/no inputs/)
    expect(merge('{"inputs":[1]}')).toThrow(/input 0 .* not an object/)
    expect(merge('{"inputs":[{"signatureScript":5}]}')).toThrow(/input 0 .* not hex/)
    expect(merge('{"inputs":[{"signatureScript":"zz"}]}')).toThrow(/input 0 .* not hex/)
    expect(merge('{"inputs":[{"signatureScript":"aa"}],"outputs":"x"}')).toThrow(/outputs that are not a list/)
    expect(merge('{"inputs":[{"signatureScript":"aa"}],"outputs":[{"value":1}]}')).toThrow(/output 0 .* not text/)
  })

  it('refuses the placeholder returned unsigned', () => {
    expect(() => acceptWalletSig(push(new Uint8Array(65)))).toThrow(/unsigned placeholder/)
  })

  it('refuses any sighash type but SIGHASH_ALL, the flagged one included', () => {
    // 0x81 is the one type the covenant admits and this package must not: the wallet was asked
    // for SIGHASH_ALL by name, so any other answer is a wallet that did not do what it was asked.
    for (const type of [0x02, 0x03, 0x81, 0x82, 0x83]) {
      expect(() => acceptWalletSig(push(signature(ownerKey, schnorrSighash(built.tx, 0), type)))).toThrow(/SIGHASH_ALL/)
    }
  })

  it('refuses a funding script that is not the canonical single push', () => {
    const sig = signature(fundingKey, schnorrSighash(built.tx, 1))
    expect(() => acceptFundingSigScript(Uint8Array.of(PUSH_65, ...sig, 0x00))).toThrow(SigningError)
    expect(() => acceptFundingSigScript(push(sig))).not.toThrow()
  })

  it('refuses an owner signature over another input', () => {
    const wrong = signature(ownerKey, schnorrSighash(built.tx, 1))
    expect(() =>
      applySignatures(
        built.tx,
        walletAnswer(built, { owner: wrong }),
        built.fundingInputs,
        built.ownerSigInputs,
        record
      )
    ).toThrow(/is not valid/)
  })

  it('refuses an owner signature by a key that is not the deed’s', () => {
    const stranger = signature(fundingKey, schnorrSighash(built.tx, 0))
    expect(() =>
      applySignatures(
        built.tx,
        walletAnswer(built, { owner: stranger }),
        built.fundingInputs,
        built.ownerSigInputs,
        record
      )
    ).toThrow(/is not valid/)
  })

  it('refuses a funding signature that does not verify against the key its coin pays to', () => {
    const stranger = signature(ownerKey, schnorrSighash(built.tx, 1))
    expect(() =>
      applySignatures(
        built.tx,
        walletAnswer(built, { funding: stranger }),
        built.fundingInputs,
        built.ownerSigInputs,
        record
      )
    ).toThrow(/funding input 1 is not valid/)
  })

  it('refuses a funding input paying to a script it cannot check', () => {
    const odd = structuredClone(built.tx)
    odd.inputs[1]!.utxo.scriptPublicKey = 'aa20' + '44'.repeat(32) + '87'
    expect(() => verifyFundingSignature(odd, 1, new Uint8Array(64))).toThrow(/does not pay to an address/)
  })

  it('refuses a moved outpoint', () => {
    const moved = JSON.parse(walletAnswer(built)) as { inputs: { index: number }[] }
    moved.inputs[1]!.index = 9
    expect(() =>
      applySignatures(built.tx, JSON.stringify(moved), built.fundingInputs, built.ownerSigInputs, record)
    ).toThrow(/different outpoint at input 1/)
  })

  it('refuses an answer with a different number of inputs', () => {
    const answer = JSON.stringify({ inputs: [{ signatureScript: '' }] })
    expect(() => applySignatures(built.tx, answer, built.fundingInputs, built.ownerSigInputs, record)).toThrow(
      /returned 1 inputs/
    )
  })

  it('refuses to patch a script with no placeholder in it', () => {
    expect(() => patchPlaceholder(Uint8Array.of(0x01, 0x02), new Uint8Array(65))).toThrow(/no placeholder/)
  })
})

describe('verifying a signature against what it committed to', () => {
  const built = transferTo(strangerPub)

  it('accepts an ECDSA signature under the parity its scheme names', () => {
    const secret = secp256k1.utils.randomSecretKey()
    const pub = secp256k1.getPublicKey(secret, true)
    const ownerType = pub[0] === 0x02 ? OwnerType.P2pkEcdsaEven : OwnerType.P2pkEcdsaOdd
    const owner = toHex(pub.slice(1))
    const sig = new Uint8Array(65)
    sig.set(secp256k1.sign(ecdsaSighash(built.tx, 0), secret, { format: 'compact', prehash: false }))
    sig[64] = SIGHASH_ALL
    expect(() => verifySignature(built.tx, 0, ownerType, owner, sig)).not.toThrow()
    const flipped = ownerType === OwnerType.P2pkEcdsaEven ? OwnerType.P2pkEcdsaOdd : OwnerType.P2pkEcdsaEven
    expect(() => verifySignature(built.tx, 0, flipped, owner, sig)).toThrow(/is not valid/)
  })

  it('refuses a schnorr signature over an ECDSA-owned deed', () => {
    const sig = signature(ownerKey, schnorrSighash(built.tx, 0))
    expect(() => verifySignature(built.tx, 0, OwnerType.P2pkEcdsaEven, ownerPub, sig)).toThrow(/is not valid/)
  })

  it('refuses an owner scheme approved by co-presence rather than by a signature', () => {
    const sig = signature(ownerKey, schnorrSighash(built.tx, 0))
    expect(() => verifySignature(built.tx, 0, OwnerType.ScriptHash, ownerPub, sig)).toThrow(/co-presence/)
    expect(() => verifySignature(built.tx, 0, OwnerType.CovenantId, ownerPub, sig)).toThrow(/co-presence/)
  })
})
