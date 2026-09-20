// The signature script of a covenant spend, encoded as silverscript's ABI codec writes it. The
// codec writes one push per declared parameter, in declared order. Then comes the entrypoint's
// four-byte dispatch tag, and then the redeem script. Parameter names, types and the tag all
// come from the manifest, so this file reads the deployment rather than restates it.

import { type AbiContract, type AbiType, concat } from '@dotk/sdk'
import { Script } from './script.js'
import { TxError } from './errors.js'

/** An argument as a caller supplies it. `push` matches it against the declared type. */
export type Arg = number | Uint8Array | Uint8Array[]

const FIXED_WIDTH: Record<string, number> = { pubkey: 32, sig: 65, datasig: 64 }

/** How wide one element of an array is, or undefined when the type has no fixed width. */
function widthOf(type: AbiType): number | undefined {
  if (type.kind === 'fixed_bytes') return type.len
  if (type.kind === 'int' || type.kind === 'temporal') return 8
  if (type.kind === 'bool' || type.kind === 'byte') return 1
  return FIXED_WIDTH[type.kind]
}

function requireBytes(name: string, value: Arg, width: number | undefined): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new TxError(`${name} must be bytes`)
  if (width !== undefined && value.length !== width) {
    throw new TxError(`${name} must be ${width} bytes, got ${value.length}`)
  }
  return value
}

/**
 * One argument, pushed as its declared type demands. An array is a single push of its elements
 * concatenated and not one push per element, so `sigs` costs one push whether it holds a
 * signature or nothing.
 */
function push(script: Script, name: string, type: AbiType, value: Arg): void {
  switch (type.kind) {
    case 'int':
    case 'temporal':
      if (typeof value !== 'number') throw new TxError(`${name} must be a number`)
      script.addI64(value)
      return
    case 'bool':
      if (typeof value !== 'number') throw new TxError(`${name} must be 0 or 1`)
      script.addI64(value)
      return
    case 'byte':
      if (typeof value !== 'number') throw new TxError(`${name} must be a byte`)
      if (!Number.isInteger(value) || value < 0 || value > 0xff) throw new TxError(`${name} is not a byte: ${value}`)
      script.addData(Uint8Array.of(value))
      return
    case 'bytes':
    case 'text':
      script.addData(requireBytes(name, value, undefined))
      return
    case 'pubkey':
    case 'sig':
    case 'datasig':
    case 'fixed_bytes':
      script.addData(requireBytes(name, value, widthOf(type)))
      return
    case 'fixed_array':
    case 'dynamic_array': {
      if (!Array.isArray(value)) throw new TxError(`${name} must be an array`)
      if (type.kind === 'fixed_array' && value.length !== type.len) {
        throw new TxError(`${name} must hold ${type.len} items, got ${value.length}`)
      }
      const width = widthOf(type.item)
      if (width === undefined) throw new TxError(`${name} holds ${type.item.kind}, which has no fixed width`)
      script.addData(concat(...value.map((item, at) => requireBytes(`${name}[${at}]`, item, width))))
      return
    }
    default:
      throw new TxError(`${name} has type ${(type as { kind: string }).kind}, which this package cannot encode`)
  }
}

/**
 * The entrypoint arguments and dispatch tag, without the redeem script.
 *
 * The tag is `blake3("name(argtypes)")[0:4]` and the deployment freezes it, so it is read from
 * the manifest and never recomputed. A tag derived any other way spends nothing and says so only
 * at consensus.
 */
export function encodeEntryArgs(contract: AbiContract, entryName: string, args: Arg[]): Uint8Array {
  const entry = contract.entries[entryName]
  if (!entry) throw new TxError(`the deployment declares no entrypoint ${entryName}`)
  if (entry.params.length !== args.length) {
    throw new TxError(`${entryName} takes ${entry.params.length} arguments, got ${args.length}`)
  }
  const script = new Script()
  entry.params.forEach((param, at) => push(script, param.name, param.type, args[at]!))

  const tag = entry.dispatch_tag
  if (!/^[0-9a-f]{8}$/.test(tag)) throw new TxError(`${entryName} has no four-byte dispatch tag`)
  script.addData(Uint8Array.from(tag.match(/../g)!.map((b) => parseInt(b, 16))))
  return script.bytes()
}

/** The whole signature script: the entrypoint's arguments and tag, then the redeem script. */
export function entrySigScript(contract: AbiContract, entryName: string, args: Arg[], redeem: Uint8Array): Uint8Array {
  const redeemPush = new Script().addData(redeem).bytes()
  return concat(encodeEntryArgs(contract, entryName, args), redeemPush)
}
