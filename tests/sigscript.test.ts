import { Dotk, encodeActiveDeedState, fromHex, hex32, toHex } from '@dotk/sdk'
import { describe, expect, it } from 'vitest'
import { entrySigScript } from '../src/abi.js'
import { Script, scriptNumber } from '../src/script.js'
import { vectors } from './vectors.js'

const dotk = new Dotk({ api: null, network: 'testnet-10' })
const registry = dotk.protocol
const deedAbi = registry.deedAbi

function stateOf(name: string, ownerType: number, owner: string): Uint8Array {
  const padded = new Uint8Array(32)
  padded.set(new TextEncoder().encode(name))
  return encodeActiveDeedState(fromHex(dotk.keyOf(name)), ownerType, hex32(owner, 'owner'), padded)
}

/**
 * The whole reason this package can exist without a wasm engine: the signature script it builds
 * is the one the corpus holds, byte for byte, or these fail.
 */
describe('the transfer signature script', () => {
  it.each(vectors.transferSigScript)(
    '$name $ownerType -> $newOwnerType witness $witness sig $sig',
    ({ name, ownerType, owner, newOwnerType, newOwner, witness, sig, sigScript }) => {
      const redeem = registry.deed.redeem(stateOf(name, ownerType, owner))
      const sigs = sig === null ? [] : [fromHex(sig, 'sig')]
      const built = entrySigScript(
        deedAbi,
        'transfer',
        [newOwnerType, hex32(newOwner, 'newOwner'), sigs, witness],
        redeem
      )
      expect(toHex(built)).toBe(sigScript)
    }
  )

  it('reads the dispatch tag from the deployment rather than restating it', () => {
    expect(deedAbi.entries['transfer']!.dispatch_tag).toMatch(/^[0-9a-f]{8}$/)
    expect(deedAbi.entries['transfer']!.params.map((p) => p.name)).toEqual([
      'newOwnerType',
      'newOwner',
      'sigs',
      'witness',
    ])
  })
})

describe('canonical pushes', () => {
  it('takes the one-opcode form where there is one', () => {
    expect(toHex(new Script().addData(new Uint8Array(0)).bytes())).toBe('00')
    expect(toHex(new Script().addData(Uint8Array.of(1)).bytes())).toBe('51')
    expect(toHex(new Script().addData(Uint8Array.of(16)).bytes())).toBe('60')
    expect(toHex(new Script().addData(Uint8Array.of(0x81)).bytes())).toBe('4f')
    // 0 and 17 have no small-integer opcode, so they are ordinary one-byte pushes.
    expect(toHex(new Script().addData(Uint8Array.of(0)).bytes())).toBe('0100')
    expect(toHex(new Script().addData(Uint8Array.of(17)).bytes())).toBe('0111')
  })

  it('picks the shortest length prefix', () => {
    expect(toHex(new Script().addData(new Uint8Array(75)).bytes()).slice(0, 2)).toBe('4b')
    expect(toHex(new Script().addData(new Uint8Array(76)).bytes()).slice(0, 4)).toBe('4c4c')
    expect(toHex(new Script().addData(new Uint8Array(256)).bytes()).slice(0, 6)).toBe('4d0001')
  })

  it('writes script numbers with the sign in the top bit', () => {
    expect(toHex(new Script().addI64(0).bytes())).toBe('00')
    expect(toHex(new Script().addI64(-1).bytes())).toBe('4f')
    expect(toHex(new Script().addI64(16).bytes())).toBe('60')
    expect(toHex(new Script().addI64(17).bytes())).toBe('0111')
    expect(toHex(scriptNumber(127))).toBe('7f')
    expect(toHex(scriptNumber(128))).toBe('8000')
    expect(toHex(scriptNumber(-127))).toBe('ff')
    expect(toHex(scriptNumber(-128))).toBe('8080')
  })
})
