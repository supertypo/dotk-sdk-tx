// Kaspa's domain-separated hashers, which are not interchangeable. blake2b takes the domain
// string as its key verbatim. blake3 takes the same string zero-padded into a 32-byte key. The
// ECDSA one is a plain sha256 preloaded with sha256 of its domain string. The wrong one produces
// a digest that is well formed and means nothing.

import { blake2b } from '@noble/hashes/blake2.js'
import { blake3 } from '@noble/hashes/blake3.js'
import { sha256 } from '@noble/hashes/sha2.js'

const utf8 = (s: string) => new TextEncoder().encode(s)

/** blake2b-256 keyed with the domain string as given. */
function blake2bKeyed(domain: string, data: Uint8Array): Uint8Array {
  return blake2b(data, { dkLen: 32, key: utf8(domain) })
}

/** blake3 keyed with the domain string in a 32-byte key, zero-padded on the right. */
function blake3Keyed(domain: string, data: Uint8Array): Uint8Array {
  const key = new Uint8Array(32)
  key.set(utf8(domain))
  return blake3(data, { key })
}

export const TransactionSigningHash = (data: Uint8Array) => blake2bKeyed('TransactionSigningHash', data)
export const TransactionRest = (data: Uint8Array) => blake3Keyed('TransactionRest', data)
export const TransactionV1Id = (data: Uint8Array) => blake3Keyed('TransactionV1Id', data)
export const PayloadDigest = (data: Uint8Array) => blake3Keyed('PayloadDigest', data)

/** sha256 over sha256 of the domain string, then the data. A prefix, not a key. */
export function TransactionSigningHashECDSA(data: Uint8Array): Uint8Array {
  const prefix = sha256(utf8('TransactionSigningHashECDSA'))
  const buf = new Uint8Array(prefix.length + data.length)
  buf.set(prefix)
  buf.set(data, prefix.length)
  return sha256(buf)
}

/** A growable byte writer with the field encodings this package feeds the hashers. */
export class Writer {
  private readonly parts: Uint8Array[] = []

  bytes(b: Uint8Array): this {
    this.parts.push(b)
    return this
  }

  u8(n: number): this {
    return this.bytes(Uint8Array.of(n & 0xff))
  }

  bool(b: boolean): this {
    return this.u8(b ? 1 : 0)
  }

  u16(n: number): this {
    const out = new Uint8Array(2)
    new DataView(out.buffer).setUint16(0, n, true)
    return this.bytes(out)
  }

  u32(n: number): this {
    const out = new Uint8Array(4)
    new DataView(out.buffer).setUint32(0, n, true)
    return this.bytes(out)
  }

  u64(n: bigint): this {
    const out = new Uint8Array(8)
    new DataView(out.buffer).setBigUint64(0, n, true)
    return this.bytes(out)
  }

  /** A length as a little-endian u64, which is how this file writes every count and prefix. */
  len(n: number): this {
    return this.u64(BigInt(n))
  }

  /** A length-prefixed byte string. */
  varBytes(b: Uint8Array): this {
    return this.len(b.length).bytes(b)
  }

  finish(): Uint8Array {
    const total = this.parts.reduce((n, p) => n + p.length, 0)
    const out = new Uint8Array(total)
    let at = 0
    for (const p of this.parts) {
      out.set(p, at)
      at += p.length
    }
    return out
  }
}
