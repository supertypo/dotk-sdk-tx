// Kaspa's canonical script pushes, as `kaspa_txscript::ScriptBuilder` writes them. A covenant
// spend's signature script is a sequence of these, and a push that differs by one byte is a
// different script, a different sighash and a rejected transaction.

const OP_0 = 0x00
const OP_1_NEGATE = 0x4f
const OP_1 = 0x51
const OP_16 = 0x60
const OP_PUSHDATA1 = 0x4c
const OP_PUSHDATA2 = 0x4d
const OP_PUSHDATA4 = 0x4e
const OP_DATA_MAX = 75
const SMALL_INT_MIN = 1
const SMALL_INT_MAX = 16
/** The single byte that encodes -1 in a script number, which pushes as `OP_1NEGATE`. */
const ONE_NEGATE_VALUE = 0x81

/** A script under construction. Bytes only: nothing here executes a script or makes sure that one is valid. */
export class Script {
  private readonly parts: number[] = []

  /**
   * Push data the way the builder does, which is not always a data push. A single byte that
   * holds 1 to 16, or the byte 0x81, has a one-opcode canonical form and takes it.
   */
  addData(data: Uint8Array): this {
    if (data.length === 1 && data[0] === ONE_NEGATE_VALUE) return this.op(OP_1_NEGATE)
    if (data.length === 1 && data[0]! >= SMALL_INT_MIN && data[0]! <= SMALL_INT_MAX) {
      return this.op(OP_1 - 1 + data[0]!)
    }
    return this.rawData(data)
  }

  /** Push a script number. Small values take their own opcode. The rest go through `addData`. */
  addI64(value: number): this {
    if (!Number.isSafeInteger(value)) throw new TypeError(`script number out of range: ${value}`)
    if (value === 0) return this.op(OP_0)
    if (value === -1 || (value >= 1 && value <= 16)) return this.op(OP_1 - 1 + value)
    return this.rawData(scriptNumber(value))
  }

  bytes(): Uint8Array {
    return Uint8Array.from(this.parts)
  }

  private op(code: number): this {
    this.parts.push(code)
    return this
  }

  private rawData(data: Uint8Array): this {
    const n = data.length
    if (n === 0) return this.op(OP_0)
    if (n <= OP_DATA_MAX) this.parts.push(n)
    else if (n <= 0xff) this.parts.push(OP_PUSHDATA1, n)
    else if (n <= 0xffff) this.parts.push(OP_PUSHDATA2, n & 0xff, (n >> 8) & 0xff)
    else this.parts.push(OP_PUSHDATA4, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff)
    for (const b of data) this.parts.push(b)
    return this
  }
}

// The opcodes of the three standard locking scripts an address stands for, built and read here.
const OP_CHECKSIG = 0xac
const OP_CHECKSIG_ECDSA = 0xab
const OP_BLAKE2B = 0xaa
const OP_EQUAL = 0x87

/** The locking script of a schnorr key: a 32-byte push, then OP_CHECKSIG. */
export function schnorrScript(key: Uint8Array): Uint8Array {
  return Uint8Array.of(0x20, ...key, OP_CHECKSIG)
}

/** The locking script of an ECDSA key: a 33-byte push, then OP_CHECKSIGECDSA. */
export function ecdsaScript(key: Uint8Array): Uint8Array {
  return Uint8Array.of(0x21, ...key, OP_CHECKSIG_ECDSA)
}

/** The locking script of a script hash: OP_BLAKE2B, a 32-byte push, then OP_EQUAL. */
export function p2shScript(hash: Uint8Array): Uint8Array {
  return Uint8Array.of(OP_BLAKE2B, 0x20, ...hash, OP_EQUAL)
}

/** Which key a standard locking script pays to, or null for a script that is neither key shape. */
export function keyOfScript(spk: Uint8Array): { kind: 'schnorr' | 'ecdsa'; key: Uint8Array } | null {
  if (spk.length === 34 && spk[0] === 0x20 && spk[33] === OP_CHECKSIG) return { kind: 'schnorr', key: spk.slice(1, 33) }
  if (spk.length === 35 && spk[0] === 0x21 && spk[34] === OP_CHECKSIG_ECDSA)
    return { kind: 'ecdsa', key: spk.slice(1, 34) }
  return null
}

/**
 * A script number: little-endian magnitude with the sign in the top bit of the last byte. An
 * extra byte follows when the magnitude already takes that bit.
 */
export function scriptNumber(value: number): Uint8Array {
  if (value === 0) return new Uint8Array(0)
  const negative = value < 0
  let n = Math.abs(value)
  const out: number[] = []
  while (n > 0) {
    out.push(n & 0xff)
    n = Math.floor(n / 256)
  }
  if (out[out.length - 1]! & 0x80) out.push(negative ? 0x80 : 0x00)
  else if (negative) out[out.length - 1]! |= 0x80
  return Uint8Array.from(out)
}

/** A signature push is 65 bytes: the 64 of the signature and one of the sighash type. */
export const SIG_LEN = 65

/** Every data push of a script, where its payload begins and how long it is, in script order. */
export function pushesOf(script: Uint8Array): { at: number; len: number }[] {
  const found: { at: number; len: number }[] = []
  let at = 0
  while (at < script.length) {
    const op = script[at]!
    let len: number
    let data: number
    if (op >= 0x01 && op <= 0x4b) {
      len = op
      data = at + 1
    } else if (op === 0x4c && at + 1 < script.length) {
      len = script[at + 1]!
      data = at + 2
    } else if (op === 0x4d && at + 2 < script.length) {
      len = script[at + 1]! | (script[at + 2]! << 8)
      data = at + 3
    } else if (op === OP_0 || op === OP_1_NEGATE || (op >= OP_1 && op <= OP_16)) {
      // A single-byte opcode that carries its own value. The encoder emits these for the bytes
      // 1..=16 and 0x81, so a transfer to a p2sh or covenant-id owner leads with one (`OP_3`,
      // `OP_4` for the scheme byte) and stopping here would find no signature at all. Every other
      // scheme byte is a plain one-byte push.
      at += 1
      continue
    } else {
      break // not a value, so nothing after this is a signature either
    }
    if (data + len > script.length) break
    found.push({ at: data, len })
    at = data + len
  }
  return found
}

/**
 * Whether the script carries the placeholder a wallet's signature is patched into, a push of
 * `SIG_LEN` zero bytes. A swept card and an owner seat under a key scheme carry one, and a seat
 * that consents by presence alone does not.
 */
export function hasPlaceholder(script: Uint8Array): boolean {
  return pushesOf(script).some((p) => {
    if (p.len !== SIG_LEN) return false
    for (let i = 0; i < SIG_LEN; i++) if (script[p.at + i] !== 0) return false
    return true
  })
}
