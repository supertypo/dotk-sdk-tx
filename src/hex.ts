// Hex a caller or the API gave, decoded as this package's own refusal. `@dotk/sdk`'s decoders
// throw a `TypeError`, and everything this package throws is a `DotkError`.

import { fromHex, hex32 } from '@dotk/sdk'
import { TxError } from './errors.js'

/** The bytes of a hex string, or a `TxError` naming `what`. */
export function bytesOf(hex: unknown, what: string): Uint8Array {
  if (typeof hex !== 'string') throw new TxError(`${what} must be a hex string`)
  try {
    return fromHex(hex, what)
  } catch (e) {
    throw new TxError(e instanceof Error ? e.message : String(e), { cause: e })
  }
}

/** The 32 bytes of a hex string, or a `TxError` naming `what`. */
export function bytes32Of(hex: unknown, what: string): Uint8Array {
  if (typeof hex !== 'string') throw new TxError(`${what} must be a hex string`)
  try {
    return hex32(hex, what)
  } catch (e) {
    throw new TxError(e instanceof Error ? e.message : String(e), { cause: e })
  }
}
