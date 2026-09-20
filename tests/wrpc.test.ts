import { Dotk, encodeActiveDeedState, fromHex, hex32, toHex } from '@dotk/sdk'
import { describe, expect, it } from 'vitest'
import { assemble } from '../src/assemble.js'
import type { SpendableUtxo } from '../src/ports.js'
import { transferIntent } from '../src/transfer.js'
import { toSafeJson, type Tx } from '../src/tx.js'
import { txNodeOverWasm, txNodeOverWrpc, nodesOver, nodesOverWrpc, toRpcTransaction } from '../src/adapters.js'
import { encodeRequest, nodeOver, type WrpcJson } from '../src/wrpc.js'
import { vectors } from './vectors.js'

const dotk = new Dotk({ api: null, network: 'testnet-10' })
const registry = dotk.protocol

function rebuild(c: (typeof vectors.transferAssembly)[number]) {
  const padded = new Uint8Array(32)
  padded.set(new TextEncoder().encode(c.name))
  const state = encodeActiveDeedState(fromHex(dotk.keyOf(c.name)), c.ownerType, hex32(c.owner, 'owner'), padded)
  const plan = transferIntent(
    registry,
    registry.deedAbi,
    {
      state: { key: dotk.keyOf(c.name), ownerType: c.ownerType, owner: c.owner, name: c.name },
      utxo: {
        outpoint: { transactionId: c.deedOutpoint[0], index: c.deedOutpoint[1] },
        amount: BigInt(registry.params.bond),
        scriptPublicKey: toHex(registry.deed.scriptPublicKey(state)),
        scriptVersion: 0,
        blockDaaScore: 0n,
        isCoinbase: false,
        covenantId: registry.registryCovenantId,
      },
    },
    c.newOwnerType,
    c.newOwner
  )
  const funding: SpendableUtxo[] = c.funding.map(([txid, index, value]) => ({
    outpoint: { transactionId: txid, index },
    amount: BigInt(value),
    scriptPublicKey: c.fundingSpk,
    scriptVersion: 0,
    blockDaaScore: 0n,
    isCoinbase: false,
  }))
  return assemble(plan.base, {
    funding,
    changeScriptPublicKey: c.changeSpk,
    feerate: c.feerate,
    requiredFunding: 0n,
  }).tx
}

/**
 * The node takes a different shape from the one a wallet is handed, and this is the only thing
 * that holds this package's copy of it to the node's own serialization. A field out of place is
 * a transaction the node will not parse, which is a failure with nothing to read in it.
 */
describe('the transaction a node is submitted', () => {
  // Compared through the encoder that ships, because that is where amounts become JSON.
  const asSent = (tx: Tx) => JSON.parse(encodeRequest(1, 'submitTransaction', toRpcTransaction(tx))).params

  it.each(vectors.transferAssembly)('$name serializes as the corpus holds it for the rpc', (c) => {
    expect(asSent(rebuild(c))).toEqual(JSON.parse(c.rpcJson))
  })

  it('writes an amount larger than a double can hold without rounding it', () => {
    // The signature commits to the exact value, so a rounded one is refused as a bad signature
    // with nothing naming the cause.
    const tx = rebuild(vectors.transferAssembly[0]!)
    const huge = { ...tx, outputs: [{ ...tx.outputs[0]!, value: 9_007_199_254_740_993n }] }
    expect(encodeRequest(1, 'submitTransaction', toRpcTransaction(huge))).toContain('9007199254740993')
  })

  it('carries the storage mass under both names the node accepts', () => {
    const rpc = asSent(rebuild(vectors.transferAssembly[0]!)) as Record<string, unknown>
    expect(rpc['storageMass']).toBe(0)
    expect(rpc['mass']).toBe(0)
  })

  it('is not the body a wallet is handed', () => {
    // Two shapes of one transaction: the wallet's carries an id and string amounts, the node's
    // carries verboseData slots and numbers. Conflating them is the mistake this guards.
    const rpc = asSent(rebuild(vectors.transferAssembly[0]!)) as Record<string, unknown>
    expect(rpc['id']).toBeUndefined()
    expect((rpc['outputs'] as { value: unknown }[])[0]!.value).toBeTypeOf('number')
  })
})

describe('a node on the wrong chain', () => {
  /** A fake `WrpcJson`: only `call` is reached from `nodeOver`. */
  const rpcSaying = (networkId: unknown) =>
    ({
      async call(method: string) {
        if (method === 'getServerInfo') return { networkId }
        return { entries: [] }
      },
    }) as unknown as WrpcJson

  it('refuses before it reads anything, naming both chains', async () => {
    const node = nodeOver(rpcSaying('mainnet'), 'testnet-10')
    await expect(node.utxosOf('kaspatest:x')).rejects.toThrow(/on mainnet, the registry is on testnet-10/)
  })

  it('asks once, not on every call', async () => {
    let asked = 0
    const rpc = {
      async call(method: string) {
        if (method === 'getServerInfo') {
          asked++
          return { networkId: 'testnet-10' }
        }
        return { entries: [] }
      },
    } as unknown as WrpcJson
    const node = nodeOver(rpc, 'testnet-10')
    await node.utxosOf('a')
    await node.utxosOf('b')
    expect(asked).toBe(1)
  })

  it('does not ask at all when the caller named no network', async () => {
    const node = nodeOver(rpcSaying('mainnet'))
    await expect(node.utxosOf('a')).resolves.toEqual([])
  })
})

/**
 * One UTXO, as each client spells it. The two disagree on every field that matters, and the
 * only thing that can catch a conversion applied to the wrong one is putting them side by side:
 * the wasm SDK hands back a script already split from its version, wRPC JSON glues the two.
 */
describe('the same coin through either client', () => {
  const covenantId = 'dd'.repeat(32)
  const script = 'aa20' + '11'.repeat(32) + '87'

  const wasmClient = {
    async getUtxosByAddresses() {
      return {
        entries: [
          {
            outpoint: { transactionId: 'ab'.repeat(32), index: 3 },
            amount: 900_000_000n,
            scriptPublicKey: { version: 0, script },
            blockDaaScore: 12_345n,
            isCoinbase: false,
            entry: { covenantId: { toString: () => covenantId } },
          },
        ],
      }
    },
    async getFeeEstimate() {
      return { estimate: { normalBuckets: [{ feerate: 7 }], priorityBucket: { feerate: 99 } } }
    },
    async submitTransaction(request: { transaction: unknown }) {
      submitted = request.transaction
      return { transactionId: 'cc'.repeat(32) }
    },
  }
  let submitted: unknown

  const wrpcCall = async (method: string) => {
    if (method !== 'getUtxosByAddresses') return { estimate: { normalBuckets: [{ feerate: 7 }] } }
    return {
      entries: [
        {
          outpoint: { transactionId: 'ab'.repeat(32), index: 3 },
          utxoEntry: {
            amount: 900_000_000,
            scriptPublicKey: '0000' + script, // the version glued to the front, as JSON has it
            blockDaaScore: 12_345,
            isCoinbase: false,
            covenantId,
          },
        },
      ],
    }
  }

  it('reads to the same spendable utxo', async () => {
    const viaWasm = await txNodeOverWasm(wasmClient).utxosOf('kaspatest:x')
    const viaJson = await txNodeOverWrpc(wrpcCall).utxosOf('kaspatest:x')
    expect(viaWasm).toEqual(viaJson)
    expect(viaWasm[0]!.scriptPublicKey).toBe(script)
    expect(viaWasm[0]!.covenantId).toBe(covenantId)
    expect(viaWasm[0]!.amount).toBe(900_000_000n)
  })

  it('prefers the normal bucket over the priority one', async () => {
    expect(await txNodeOverWasm(wasmClient).feerate()).toBe(7)
    expect(await txNodeOverWrpc(wrpcCall).feerate()).toBe(7)
  })

  it('submits the body the wallet signed, not the rpc shape', async () => {
    // The wasm SDK builds its own `Transaction` from this, so it takes the safe JSON. wRPC does
    // not, so it takes an `RpcTransaction`. Sending either shape to the other is a parse error.
    const tx = rebuild(vectors.transferAssembly[0]!)
    await txNodeOverWasm(wasmClient).submit(tx)
    expect(submitted).toEqual(JSON.parse(toSafeJson(tx)))
    expect(submitted).not.toEqual(toRpcTransaction(tx))
  })
})

describe('the network guard under failure', () => {
  const flaky = (fail: number) => {
    let asked = 0
    const rpc = {
      async call(method: string) {
        if (method === 'getServerInfo') {
          asked += 1
          if (asked <= fail) throw new Error('socket hang up')
          return { networkId: 'testnet-10' }
        }
        return { entries: [] }
      },
    } as unknown as WrpcJson
    return { rpc, asked: () => asked }
  }

  /**
   * A rejected promise memoizes as readily as a fulfilled one. One blocked socket, or one
   * caller who cancelled, would otherwise leave the adapter replaying that failure for ever
   * with the node never asked again.
   */
  it('asks again after a failure rather than remembering it', async () => {
    const { rpc, asked } = flaky(1)
    const node = nodeOver(rpc, 'testnet-10')
    await expect(node.utxosOf('a')).rejects.toThrow(/socket hang up/)
    await expect(node.utxosOf('a')).resolves.toEqual([])
    expect(asked()).toBe(2)
  })

  it('remembers a success, so the node is asked once', async () => {
    const { rpc, asked } = flaky(0)
    const node = nodeOver(rpc, 'testnet-10')
    await node.utxosOf('a')
    await node.utxosOf('b')
    await node.feerate()
    expect(asked()).toBe(1)
  })

  it('confirms the chain before quoting a feerate, not only before reading', async () => {
    const rpc = {
      async call(method: string) {
        if (method === 'getServerInfo') return { networkId: 'mainnet' }
        return { estimate: { normalBuckets: [{ feerate: 3 }] } }
      },
    } as unknown as WrpcJson
    await expect(nodeOver(rpc, 'testnet-10').feerate()).rejects.toThrow(/on mainnet, the registry is on testnet-10/)
  })
})

describe('encoding a request', () => {
  it('leaves a string that looks like the marker alone', () => {
    // The marker is chosen to survive `JSON.stringify` unescaped, so a payload could carry the
    // same characters. Only the quotes this encoder itself wrote may be removed.
    const note = '@~bigint:5@'
    const back = JSON.parse(encodeRequest(1, 'm', { note, real: 5n }))
    expect(back.params.note).toBe(note)
    expect(back.params.real).toBe(5)
  })

  it('writes a bigint nested anywhere, not only at the top', () => {
    const encoded = encodeRequest(1, 'm', { a: [{ b: 12_345_678_901_234_567_890n }] })
    expect(encoded).toContain('12345678901234567890')
    expect(encoded).not.toContain('"12345678901234567890"')
  })
})

/**
 * A wallet has one client and needs both halves. The two packages ask different things of it,
 * so the shapes have to stay compatible, and nothing else would notice if one drifted.
 */
describe('one client, both halves', () => {
  it('asks the wasm client the way the bindings declare it', async () => {
    let asked: unknown
    const client = {
      async getUtxosByAddresses(request: { addresses: string[] }) {
        asked = request
        return { entries: [] }
      },
      async getFeeEstimate() {
        return { estimate: { normalBuckets: [{ feerate: 2 }] } }
      },
      async submitTransaction() {
        return { transactionId: 'ff'.repeat(32) }
      },
    }
    const both = nodesOver(client)
    await both.tx.utxosOf('kaspatest:x')
    expect(asked).toEqual({ addresses: ['kaspatest:x'] })
    await both.read.getUtxosByAddresses(['kaspatest:x'])
    expect(asked).toEqual({ addresses: ['kaspatest:x'] })
  })

  it('drives both halves from one wRPC call function', async () => {
    const seen: string[] = []
    const call = async (method: string) => {
      seen.push(method)
      return { entries: [] }
    }
    const both = nodesOverWrpc(call)
    await both.tx.utxosOf('a')
    await both.read.getUtxosByAddresses(['a'])
    expect(seen).toEqual(['getUtxosByAddresses', 'getUtxosByAddresses'])
  })
})
