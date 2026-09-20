// The part of the package an integrator actually calls, driven against a node and a wallet that
// exist only here. Everything below the Registrar is pinned by the corpus, and this
// is where the pieces are wired together, and a wrong wiring is invisible to a vector.

import {
  CARD_VALUE,
  Dotk,
  OwnerType,
  type Records,
  SubnameError,
  TimeoutError,
  Version,
  cardAddress,
  cardScriptPublicKey,
  cardState,
  decodeCardPayload,
  decodeRecords,
  encodeAddress,
  encodeActiveDeedState,
  encodeGapState,
  encodePendingDeedState,
  encodeRecords,
  feeForName,
  fromHex,
  hex32,
  names,
  recordsOf,
  subnameValue,
  toHex,
} from '@dotk/sdk'
import { DotkError, NodeError as SdkNodeError } from '@dotk/sdk'
import { schnorr } from '@noble/curves/secp256k1.js'
import { describe, expect, it } from 'vitest'
import { txNodeOverWasm } from '../src/adapters.js'
import { emptyTx } from '../src/tx.js'
import type { Account, SignRequest, Signer, SpendableUtxo, TxNode } from '../src/ports.js'
import { InsufficientFundingError, NodeError, TxError, UndecodableCardError } from '../src/errors.js'
import { COINBASE_MATURITY } from '../src/mass.js'
import { Registrar, scriptPublicKeyOf } from '../src/registrar.js'
import { mergeRecords } from '../src/records.js'
import type { Gap } from '../src/release.js'
import { schnorrSighash } from '../src/sighash.js'
import { SIGHASH_ALL, patchPlaceholder } from '../src/sign.js'
import { deedAddressOfState } from '../src/transfer.js'
import type { Tx } from '../src/tx.js'

const dotk = new Dotk({ api: null, network: 'testnet-10' })
const registry = dotk.protocol

const ownerKey = schnorr.utils.randomSecretKey()
const ownerPub = schnorr.getPublicKey(ownerKey)
const address = encodeAddress('kaspatest', Version.PubKey, ownerPub)
/** The URL a fetch was given, whatever form it came in. */
const urlOf = (input: string | URL | Request) =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
const account: Account = { address, ownerType: OwnerType.Pubkey, owner: toHex(ownerPub) }
const recipient = encodeAddress('kaspatest', Version.PubKey, schnorr.getPublicKey(schnorr.utils.randomSecretKey()))

const NAME = 'kaspa'

/** Two payees a subname can name, and the values that name them on a card. */
const payee = schnorr.getPublicKey(schnorr.utils.randomSecretKey())
const payeeAddress = encodeAddress('kaspatest', Version.PubKey, payee)
const second = schnorr.getPublicKey(schnorr.utils.randomSecretKey())
const secondAddress = encodeAddress('kaspatest', Version.PubKey, second)
const pays = subnameValue(OwnerType.Pubkey, payee)
const paysSecond = subnameValue(OwnerType.Pubkey, second)

/** The one name whose subnames no reader reaches, derived as the package derives it. */
const GATED = names.DISPLAY_SUFFIX.replace(/^\./, '')

function deedState(owner: string, name = NAME) {
  return { key: dotk.keyOf(name), ownerType: OwnerType.Pubkey, owner, name }
}

function deedUtxo(over: Partial<SpendableUtxo> = {}, name = NAME): SpendableUtxo {
  const bytes = encodeActiveDeedState(
    fromHex(dotk.keyOf(name)),
    OwnerType.Pubkey,
    hex32(account.owner, 'owner'),
    (() => {
      const p = new Uint8Array(32)
      p.set(new TextEncoder().encode(name))
      return p
    })()
  )
  return {
    outpoint: { transactionId: 'aa'.repeat(32), index: 0 },
    amount: BigInt(registry.params.bond),
    scriptPublicKey: toHex(registry.deed.scriptPublicKey(bytes)),
    scriptVersion: 0,
    blockDaaScore: 0n,
    isCoinbase: false,
    covenantId: registry.registryCovenantId,
    ...over,
  }
}

const coin: SpendableUtxo = {
  outpoint: { transactionId: 'bb'.repeat(32), index: 1 },
  amount: 10_000_000_000n,
  scriptPublicKey: toHex(scriptPublicKeyOf(address, dotk)),
  scriptVersion: 0,
  blockDaaScore: 0n,
  isCoinbase: false,
}

/** A node holding a deed at its derived address and a coin at the account's. */
function fakeNode(
  over: { deed?: SpendableUtxo[]; coins?: SpendableUtxo[]; submitted?: Tx[]; name?: string } = {}
): TxNode {
  const name = over.name ?? NAME
  const deedAddress = deedAddressOfState(registry, deedState(account.owner, name))
  return {
    async utxosOf(at) {
      if (at === deedAddress) return over.deed ?? [deedUtxo({}, name)]
      if (at === address) return over.coins ?? [coin]
      return []
    },
    async feerate() {
      return 1
    },
    async submit(tx) {
      over.submitted?.push(tx)
      return 'cc'.repeat(32)
    },
  }
}

class LocalSigner implements Signer {
  tx: Tx | undefined
  constructor(private readonly scheme: number = OwnerType.Pubkey) {}
  supportsOwnerScheme(ownerType: number): boolean {
    return ownerType === this.scheme
  }
  async sign(request: SignRequest): Promise<string> {
    const tx = this.tx!
    const owners = new Set(request.ownerSigInputs)
    const funding = new Set(request.fundingInputs)
    return JSON.stringify({
      inputs: tx.inputs.map((input, at) => {
        if (!owners.has(at) && !funding.has(at)) return { signatureScript: input.signatureScript }
        const sig = new Uint8Array(65)
        sig.set(schnorr.sign(schnorrSighash(tx, at), ownerKey))
        sig[64] = SIGHASH_ALL
        const script = owners.has(at)
          ? patchPlaceholder(fromHex(input.signatureScript), sig)
          : Uint8Array.of(0x41, ...sig)
        return { signatureScript: toHex(script) }
      }),
    })
  }
}

function registrarWith(node: TxNode, signer: Signer = new LocalSigner()) {
  const r = new Registrar({ dotk, node, signer, account })
  return { registrar: r, signer }
}

/** `fakeNode`, also holding this account's deed of `name` at its derived address. */
function nodeHoldingAlso(name: string, over: Parameters<typeof fakeNode>[0] = {}): TxNode {
  const inner = fakeNode(over)
  const at = deedAddressOfState(registry, deedState(account.owner, name))
  const held = deedUtxo({ outpoint: { transactionId: 'ae'.repeat(32), index: 0 } }, name)
  return { ...inner, utxosOf: async (a) => (a === at ? [held] : inner.utxosOf(a)) }
}

describe('planning a transfer', () => {
  it('names the recipient the caller gave, alongside where the deed moves', async () => {
    const { registrar } = registrarWith(fakeNode())
    const plan = await registrar.planTransfer(NAME, recipient)
    expect(plan.recipient).toBe(recipient)
    expect(plan.fromDeed).toBe(deedAddressOfState(registry, deedState(account.owner)))
    expect(plan.toDeed).not.toBe(plan.fromDeed)
    expect(plan.fee).toBeGreaterThan(0n)
  })

  /**
   * Nothing else can see this. The change script is pinned by a vector, but that
   * says nothing about which address it was derived from, and the remainder of the selected
   * coin goes wherever this points.
   */
  it('pays the change back to the account that funded it', async () => {
    const { registrar } = registrarWith(fakeNode())
    const plan = await registrar.planTransfer(NAME, recipient)
    const change = plan.assembled.tx.outputs[plan.assembled.changeIndex]!
    expect(change.scriptPublicKey).toBe(toHex(scriptPublicKeyOf(address, dotk)))
    expect(change.scriptPublicKey).not.toBe(toHex(scriptPublicKeyOf(recipient, dotk)))
  })

  it('spends only the deed and coins that carry no covenant id', async () => {
    // A covenant output at the account's own address, larger than the coin, so largest-first
    // would take it if the filter were not there. Consensus would refuse the result, but only
    // after the wallet had signed and the user approved.
    const registryCoin: SpendableUtxo = {
      ...coin,
      outpoint: { transactionId: 'ee'.repeat(32), index: 0 },
      amount: 99_000_000_000n,
      covenantId: registry.registryCovenantId,
    }
    const { registrar } = registrarWith(fakeNode({ coins: [registryCoin, coin] }))
    const plan = await registrar.planTransfer(NAME, recipient)
    expect(plan.assembled.tx.inputs).toHaveLength(2)
    expect(plan.assembled.tx.inputs[0]!.utxo.covenantId).toBe(registry.registryCovenantId)
    expect(plan.assembled.fundingInputs).toEqual([1])
    expect(plan.assembled.tx.inputs[1]!.previousOutpoint.transactionId).toBe(coin.outpoint.transactionId)
  })

  it('treats a null covenant id as a plain coin, which is how wRPC JSON spells one', async () => {
    const node = fakeNode({ coins: [{ ...coin, covenantId: null }] })
    const { registrar } = registrarWith(node)
    await expect(registrar.planTransfer(NAME, recipient)).resolves.toBeDefined()
  })

  it('refuses when the wallet cannot authorize the deed’s scheme', async () => {
    const { registrar } = registrarWith(fakeNode(), new LocalSigner(OwnerType.P2pkEcdsaEven))
    await expect(registrar.planTransfer(NAME, recipient)).rejects.toThrow(/cannot authorize/)
  })

  it('says the name is not held when the deed is absent', async () => {
    const { registrar } = registrarWith(fakeNode({ deed: [] }))
    await expect(registrar.planTransfer(NAME, recipient)).rejects.toThrow(/is not held by/)
  })

  it('blames the client, not the owner, when nothing reports a covenant id', async () => {
    const blind = fakeNode({ deed: [deedUtxo({ covenantId: undefined })] })
    const { registrar } = registrarWith(blind)
    await expect(registrar.planTransfer(NAME, recipient)).rejects.toThrow(/reports no covenant id/)
  })
})

describe('submitting', () => {
  it('signs, verifies and sends the transaction this package built', async () => {
    const submitted: Tx[] = []
    const { registrar, signer } = registrarWith(fakeNode({ submitted }))
    const plan = await registrar.planTransfer(NAME, recipient)
    ;(signer as LocalSigner).tx = plan.assembled.tx
    expect(await registrar.submit(plan)).toMatch(/^[0-9a-f]{64}$/)
    expect(submitted).toHaveLength(1)
    expect(submitted[0]!.outputs[0]!.value).toBe(BigInt(registry.params.bond))
  })

  it('classifies a refusal rather than passing the node’s words along bare', async () => {
    const node = {
      ...fakeNode(),
      submit: async () => {
        throw new Error('transaction 6f0a is already in the mempool')
      },
    }
    const { registrar, signer } = registrarWith(node)
    const plan = await registrar.planTransfer(NAME, recipient)
    ;(signer as LocalSigner).tx = plan.assembled.tx
    const e = await registrar.submit(plan).catch((e: unknown) => e)
    expect(e).toMatchObject({ name: 'SubmitError', verdict: 'stale' })
    expect((e as Error).cause).toBeInstanceOf(Error)
    expect(((e as Error).cause as Error).message).toMatch(/already in the mempool/)
  })

  /**
   * A dropped socket at submit is a node failure, never a refusal, and whether the node took the
   * transaction is unknown, so its coins are struck off until a resync.
   */
  it('hands a dropped socket at submit back as a node error, and strikes the coins', async () => {
    const node = {
      ...fakeNode(),
      submit: async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:18210')
      },
    }
    const { registrar, signer } = registrarWith(node)
    const plan = await registrar.planTransfer(NAME, recipient)
    ;(signer as LocalSigner).tx = plan.assembled.tx
    const e = await registrar.submit(plan).catch((e: unknown) => e)
    expect(e).toBeInstanceOf(SdkNodeError)
    expect((e as Error).name).toBe('NodeError')
    expect((e as Error).message).toMatch(/ECONNREFUSED/)
    await expect(registrar.planTransfer(NAME, recipient)).rejects.toThrow(InsufficientFundingError)
    // Once the node's view has settled, a resync reads the wallet as the node reports it.
    registrar.resync()
    await expect(registrar.planTransfer(NAME, recipient)).resolves.toBeDefined()
  })

  /** A resync forgets only doubt. The coins of a transaction the node took are spent, whatever a resync says. */
  it('keeps the coins of an accepted submission struck through a resync', async () => {
    const { registrar, signer } = registrarWith(nodeHoldingAlso('other'))
    const first = await registrar.planTransfer(NAME, recipient)
    ;(signer as LocalSigner).tx = first.assembled.tx
    await registrar.submit(first)
    registrar.resync()
    // The deed of `other` is untouched, so the coin alone refuses.
    await expect(registrar.planTransfer('other', recipient)).rejects.toThrow(InsufficientFundingError)
  })

  /** A node that answers nothing, or names nothing, did not accept, and the adapter says so by name. */
  it('refuses a node that accepts without naming the transaction, by name', async () => {
    const answers: ({ transactionId?: string } | null | undefined)[] = [null, undefined, {}, { transactionId: '' }]
    for (const answer of answers) {
      const node = txNodeOverWasm({
        getUtxosByAddresses: async () => ({ entries: [] }),
        getFeeEstimate: async () => ({}),
        submitTransaction: async () => answer,
      })
      const e = await node.submit(emptyTx()).catch((e: unknown) => e)
      expect(e, JSON.stringify(answer)).toBeInstanceOf(TxError)
      expect((e as Error).message).toMatch(/without naming it/)
    }
  })

  /** A cancel mid-flight is an unknown outcome: the coins count as spent until a resync. */
  it('strikes the coins of a cancelled submission until a resync', async () => {
    const node = {
      ...fakeNode(),
      submit: (_tx: Tx, options?: { signal?: AbortSignal }) =>
        new Promise<string>((_, reject) =>
          options?.signal?.addEventListener('abort', () => reject(options.signal?.reason as Error))
        ),
    }
    const { registrar, signer } = registrarWith(node)
    const plan = await registrar.planTransfer(NAME, recipient)
    ;(signer as LocalSigner).tx = plan.assembled.tx
    const controller = new AbortController()
    const sent = registrar.submit(plan, { signal: controller.signal })
    controller.abort(new Error('cancel'))
    await expect(sent).rejects.toThrow('cancel')
    await expect(registrar.planTransfer(NAME, recipient)).rejects.toThrow(InsufficientFundingError)
    registrar.resync()
    await expect(registrar.planTransfer(NAME, recipient)).resolves.toBeDefined()
  })

  it("hands the caller's cancel at submit back as the reason they aborted with", async () => {
    const reason = new Error('the user pressed cancel')
    const node = {
      ...fakeNode(),
      submit: (_tx: Tx, options?: { signal?: AbortSignal }) =>
        new Promise<string>((_, reject) =>
          options?.signal?.addEventListener('abort', () => reject(options.signal?.reason as Error))
        ),
    }
    const { registrar, signer } = registrarWith(node)
    const plan = await registrar.planTransfer(NAME, recipient)
    ;(signer as LocalSigner).tx = plan.assembled.tx
    const controller = new AbortController()
    const sent = registrar.submit(plan, { signal: controller.signal })
    controller.abort(reason)
    await expect(sent).rejects.toBe(reason)
  })
})

describe('where change can be paid', () => {
  it('builds the script for each address kind an account can have', () => {
    const ecdsa = encodeAddress('kaspatest', Version.PubKeyECDSA, Uint8Array.of(0x02, ...ownerPub))
    const p2sh = encodeAddress('kaspatest', Version.ScriptHash, new Uint8Array(32).fill(0x44))
    expect(toHex(scriptPublicKeyOf(address, dotk)).slice(0, 2)).toBe('20')
    expect(toHex(scriptPublicKeyOf(ecdsa, dotk)).slice(0, 2)).toBe('21')
    expect(toHex(scriptPublicKeyOf(p2sh, dotk)).slice(0, 4)).toBe('aa20')
  })

  it('refuses an address that is not one at all', () => {
    expect(() => scriptPublicKeyOf('kaspatest:notanaddress', dotk)).toThrow()
  })
})

describe('a signer that does not implement the interface', () => {
  it('says which method is missing rather than failing as a TypeError from inside', async () => {
    const partial = {
      async sign() {
        return '{}'
      },
    } as unknown as Signer
    const { registrar } = registrarWith(fakeNode(), partial)
    await expect(registrar.planTransfer(NAME, recipient)).rejects.toThrow(/implements no supportsOwnerScheme/)
  })
})

describe('coins this package will not select', () => {
  const coinbase = (over: Partial<SpendableUtxo> = {}): SpendableUtxo => ({
    ...coin,
    outpoint: { transactionId: 'dd'.repeat(32), index: 0 },
    amount: 99_000_000_000n,
    isCoinbase: true,
    blockDaaScore: 5_000n,
    ...over,
  })

  /** A miner's largest coin is always the newest one, which is the one consensus refuses. */
  it('leaves an immature coinbase alone when the node can date it', async () => {
    const node = { ...fakeNode({ coins: [coinbase(), coin] }), daaScore: async () => 5_500n }
    const { registrar } = registrarWith(node)
    const plan = await registrar.planTransfer(NAME, recipient)
    expect(plan.assembled.tx.inputs[1]!.previousOutpoint.transactionId).toBe(coin.outpoint.transactionId)
  })

  it('spends a coinbase the chain has aged past the maturity', async () => {
    const node = { ...fakeNode({ coins: [coinbase(), coin] }), daaScore: async () => 5_000n + COINBASE_MATURITY }
    const { registrar } = registrarWith(node)
    const plan = await registrar.planTransfer(NAME, recipient)
    expect(plan.assembled.tx.inputs[1]!.previousOutpoint.transactionId).toBe(coinbase().outpoint.transactionId)
  })

  it('selects it anyway when no node can say the score, rather than refusing to build', async () => {
    const { registrar } = registrarWith(fakeNode({ coins: [coinbase(), coin] }))
    const plan = await registrar.planTransfer(NAME, recipient)
    expect(plan.assembled.tx.inputs[1]!.previousOutpoint.transactionId).toBe(coinbase().outpoint.transactionId)
  })

  /**
   * The UTXO index reports a coin until the transaction spending it confirms, so a second plan
   * built moments later would pick the same one and double-spend it.
   */
  it('does not offer a coin one of its own submissions already spends', async () => {
    const submitted: Tx[] = []
    const { registrar, signer } = registrarWith(nodeHoldingAlso('other', { submitted }))
    const first = await registrar.planTransfer(NAME, recipient)
    ;(signer as LocalSigner).tx = first.assembled.tx
    await registrar.submit(first)
    // The deed of `other` is untouched, so the coin alone refuses.
    await expect(registrar.planTransfer('other', recipient)).rejects.toThrow(InsufficientFundingError)
  })

  it('keeps the coin when the node refused the transaction', async () => {
    const node = {
      ...fakeNode(),
      submit: async () => {
        throw new Error('transaction 6f0a is not standard: a reason the mempool gives')
      },
    }
    const { registrar, signer } = registrarWith(node)
    const first = await registrar.planTransfer(NAME, recipient)
    ;(signer as LocalSigner).tx = first.assembled.tx
    await expect(registrar.submit(first)).rejects.toThrow()
    await expect(registrar.planTransfer(NAME, recipient)).resolves.toBeDefined()
  })
})

describe('a node that does not answer, and one that is not there', () => {
  const silent: TxNode = {
    utxosOf: () => new Promise(() => undefined),
    feerate: async () => 1,
    submit: async () => 'x',
  }

  it('gives up after the deadline rather than leaving a send screen spinning', async () => {
    const r = new Registrar({ dotk, node: silent, signer: new LocalSigner(), account, timeoutMs: 30 })
    await expect(r.planTransfer(NAME, recipient)).rejects.toThrow(TimeoutError)
  })

  it('waits for ever only when the caller asked it to', async () => {
    const r = new Registrar({ dotk, node: silent, signer: new LocalSigner(), account, timeoutMs: null })
    const race = await Promise.race([
      r.planTransfer(NAME, recipient).then(() => 'answered'),
      new Promise((resolve) => setTimeout(() => resolve('still waiting'), 50)),
    ])
    expect(race).toBe('still waiting')
  })

  it('honours an already-aborted signal even when the node ignores it', async () => {
    const r = new Registrar({ dotk, node: silent, signer: new LocalSigner(), account })
    await expect(r.planTransfer(NAME, recipient, { signal: AbortSignal.abort() })).rejects.toThrow()
  })

  /**
   * A cancel button hands over whatever the caller aborted with, and that is what they have to
   * get back: a wallet branching on its own reason cannot recognise it once this package has
   * wrapped it as a failure of the node, which is the opposite of what happened.
   */
  it('hands a cancellation back as the reason the caller gave', async () => {
    const r = new Registrar({ dotk, node: silent, signer: new LocalSigner(), account })
    const reason = new Error('the user pressed cancel')
    await expect(r.planTransfer(NAME, recipient, { signal: AbortSignal.abort(reason) })).rejects.toBe(reason)
  })

  it('hands back a reason that is not an Error at all', async () => {
    const r = new Registrar({ dotk, node: silent, signer: new LocalSigner(), account })
    await expect(r.planTransfer(NAME, recipient, { signal: AbortSignal.abort('cancelled') })).rejects.toBe('cancelled')
  })

  it('hands back the reason for an abort that arrives mid-call', async () => {
    // A node that honours the signal, as an adapter over fetch does: the rejection it raises is
    // the transport's own AbortError, and the caller's reason has to survive it.
    const honouring: TxNode = {
      utxosOf: (_at, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {
            once: true,
          })
        }),
      feerate: async () => 1,
      submit: async () => 'x',
    }
    const r = new Registrar({ dotk, node: honouring, signer: new LocalSigner(), account })
    const reason = new Error('the user pressed cancel')
    const controller = new AbortController()
    const pending = r.planTransfer(NAME, recipient, { signal: controller.signal })
    controller.abort(reason)
    await expect(pending).rejects.toBe(reason)
  })

  /** A wallet branching on this package's errors should not file a dropped socket as its bug. */
  it('names a transport failure rather than passing the socket’s words up bare', async () => {
    const broken: TxNode = {
      utxosOf: async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:18210')
      },
      feerate: async () => 1,
      submit: async () => 'x',
    }
    const r = new Registrar({ dotk, node: broken, signer: new LocalSigner(), account })
    const failure = await r.planTransfer(NAME, recipient).catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(NodeError)
    // The read client's own class, so one catch covers both halves.
    expect(failure).toBeInstanceOf(SdkNodeError)
    expect(failure).toBeInstanceOf(DotkError)
    expect(failure).not.toBeInstanceOf(TxError)
    expect((failure as Error).message).toMatch(/ECONNREFUSED/)
  })
})

/**
 * Cards through the registrar: a record save is a transfer to the owner the
 * deed has, sweeping the old card and minting the new one, and a sweep on its own reclaims
 * what a transfer left behind. The bytes are pinned by the corpus in cards.test.ts; this is
 * the wiring to the API's listing and the node's UTXO set.
 */
describe('cards', () => {
  const OLD_TXID = 'dd'.repeat(32)
  const records = { url: 'https://kaspa.org', primary: true }

  /** The card the account minted on the name in an earlier transfer, as the API lists it. */
  function oldCard(name = NAME) {
    const blob = encodeRecords({ url: 'old' })
    const state = cardState(fromHex(dotk.keyOf(name)), recordsOf(blob), OwnerType.Pubkey, ownerPub)
    return {
      state,
      address: cardAddress(dotk.prefix, state),
      listing: {
        name,
        key: dotk.keyOf(name),
        outpointTxid: OLD_TXID,
        outpointIndex: 1,
        value: CARD_VALUE,
        spenderType: OwnerType.Pubkey,
        spender: account.owner,
        spenderAddress: address,
        cardAddress: cardAddress(dotk.prefix, state),
        recordsHash: toHex(state.records),
        blob: toHex(blob),
        live: false,
      },
      utxo: {
        outpoint: { transactionId: OLD_TXID, index: 1 },
        amount: BigInt(CARD_VALUE),
        scriptPublicKey: toHex(cardScriptPublicKey(state)),
        scriptVersion: 0,
        blockDaaScore: 0n,
        isCoinbase: false,
      } satisfies SpendableUtxo,
    }
  }

  /**
   * A read client whose API lists these cards for the account's key, and answers the name with
   * `live` as its one live card, or with none.
   */
  function dotkListing(cards: object[], live: object | null = null, name = NAME) {
    const fetchFn: typeof fetch = async (input) => {
      const json = (body: object) =>
        new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
      const url = urlOf(input)
      if (url.endsWith(`/spenders/0/${account.owner}/cards`)) {
        return json({
          spenderType: 0,
          spender: account.owner,
          address,
          cards,
          registryCovenantId: registry.registryCovenantId,
        })
      }
      if (url.endsWith(`/names/${name}`)) {
        return json({
          name,
          ownerType: OwnerType.Pubkey,
          owner: account.owner,
          address,
          deedAddress: deedAddressOfState(registry, deedState(account.owner, name)),
          ...(live ? { card: live } : {}),
          registryCovenantId: registry.registryCovenantId,
        })
      }
      return new Response('nope', { status: 404 })
    }
    return new Dotk({ api: 'http://x', fetch: fetchFn, network: 'testnet-10' })
  }

  /**
   * The name's live card: output 1 of the transaction the deed's UTXO came from, as rule 2
   * demands, carrying `blob`, and the UTXO a node holds for it.
   */
  function liveCard(blob: Uint8Array, name = NAME) {
    const state = cardState(fromHex(dotk.keyOf(name)), recordsOf(blob), OwnerType.Pubkey, ownerPub)
    const address = cardAddress(dotk.prefix, state)
    const txid = 'aa'.repeat(32)
    return {
      address,
      listing: {
        name,
        key: dotk.keyOf(name),
        outpointTxid: txid,
        outpointIndex: 1,
        value: CARD_VALUE,
        spenderType: OwnerType.Pubkey,
        spender: account.owner,
        spenderAddress: address,
        cardAddress: address,
        recordsHash: toHex(state.records),
        blob: toHex(blob),
        live: true,
      },
      utxo: {
        outpoint: { transactionId: txid, index: 1 },
        amount: BigInt(CARD_VALUE),
        scriptPublicKey: toHex(cardScriptPublicKey(state)),
        scriptVersion: 0,
        blockDaaScore: 0n,
        isCoinbase: false,
      } satisfies SpendableUtxo,
    }
  }

  /** A node also holding these UTXOs at these addresses. */
  function nodeWith(at: Record<string, SpendableUtxo[]>, submitted: Tx[] = [], name = NAME): TxNode {
    const inner = fakeNode({ submitted, name })
    return { ...inner, utxosOf: async (a) => at[a] ?? inner.utxosOf(a) }
  }

  it('saves records by transferring to the same owner, sweeping the old card and minting the new', async () => {
    const old = oldCard()
    const submitted: Tx[] = []
    const node = nodeWith({ [old.address]: [old.utxo] }, submitted)
    const signer = new LocalSigner()
    const registrar = new Registrar({ dotk: dotkListing([old.listing]), node, signer, account })

    const plan = await registrar.planRecords(NAME, records)
    expect(plan.toDeed).toBe(plan.fromDeed)
    expect(plan.cards).toEqual({
      minted: true,
      swept: 1,
      value: 0n,
      carried: [],
      dropped: [],
      subnames: [],
      subnamesDropped: [],
      cardRead: true,
      complete: true,
    })
    expect(plan.ownerSigInputs).toEqual([0, 1])
    expect(plan.request.fundingInputs).toEqual([2])
    const tx = plan.assembled.tx
    expect(tx.inputs[1]!.previousOutpoint).toEqual(old.utxo.outpoint)
    expect(tx.outputs[1]!.value).toBe(BigInt(CARD_VALUE))
    const minted = decodeCardPayload(fromHex(tx.payload))!
    expect(decodeRecords(minted.blob)).toEqual(records)
    expect(toHex(minted.state.spender)).toBe(account.owner)
    expect(toHex(cardScriptPublicKey(minted.state))).toBe(tx.outputs[1]!.scriptPublicKey)

    signer.tx = tx
    expect(await registrar.submit(plan)).toMatch(/^[0-9a-f]{64}$/)
    expect(submitted).toHaveLength(1)
    // The sweep's signature was patched into the card's own script, after its placeholder.
    expect(submitted[0]!.inputs[1]!.signatureScript.slice(0, 2)).toBe('41')
    expect(submitted[0]!.inputs[1]!.signatureScript).not.toBe(tx.inputs[1]!.signatureScript)
  })

  it('clears records by sweeping alone, and refuses a same-owner transfer with nothing to carry', async () => {
    const old = oldCard()
    const registrar = new Registrar({
      dotk: dotkListing([old.listing]),
      node: nodeWith({ [old.address]: [old.utxo] }),
      signer: new LocalSigner(),
      account,
    })
    const plan = await registrar.planRecords(NAME, null)
    expect(plan.cards).toEqual({
      minted: false,
      swept: 1,
      value: -BigInt(CARD_VALUE),
      carried: [],
      dropped: [],
      subnames: [],
      subnamesDropped: [],
      cardRead: true,
      complete: true,
    })
    expect(plan.assembled.tx.payload).toBe('')

    // Nothing to sweep and nothing to mint: the refusal says that, rather than talking about
    // the owner of a deed the caller never mentioned.
    const bare = new Registrar({ dotk: dotkListing([]), node: fakeNode(), signer: new LocalSigner(), account })
    await expect(bare.planRecords(NAME, null)).rejects.toThrow(/mints no card and sweeps none/)
  })

  /**
   * The tolerant decoder: a save keeps the live card's opaque
   * values under keys the set does not name, drops one the set names, and reports both.
   */
  it("carries the live card's opaque values a save does not name, and says what it drops", async () => {
    const old = oldCard()
    const live = liveCard(encodeRecords({ url: 'old', x: { opaque: '182a' }, y: { opaque: '20' } }))
    const node = nodeWith({ [old.address]: [old.utxo], [live.address]: [live.utxo] })
    const registrar = new Registrar({
      dotk: dotkListing([old.listing], live.listing),
      node,
      signer: new LocalSigner(),
      account,
    })

    const plan = await registrar.planRecords(NAME, { ...records, y: 'text now' })
    expect(plan.cards.carried).toEqual(['x'])
    expect(plan.cards.dropped).toEqual(['y'])
    // The round trip the SDK README asks for, the same opaque value handed back, is kept and
    // reported as kept, never as dropped.
    const same = await registrar.planRecords(NAME, { ...records, x: { opaque: '182a' } })
    expect(same.cards.carried).toEqual(['x', 'y'])
    expect(same.cards.dropped).toEqual([])
    const minted = decodeCardPayload(fromHex(plan.assembled.tx.payload))!
    expect(decodeRecords(minted.blob)).toEqual({ ...records, y: 'text now', x: { opaque: '182a' } })
  })

  it('plans records without an api, carrying nothing since nothing can be looked up', async () => {
    const old = oldCard()
    const registrar = new Registrar({
      dotk,
      node: nodeWith({ [old.address]: [old.utxo] }),
      signer: new LocalSigner(),
      account,
    })
    const plan = await registrar.planRecords(NAME, records)
    expect(plan.cards).toEqual({
      minted: true,
      swept: 0,
      value: BigInt(CARD_VALUE),
      carried: [],
      dropped: [],
      subnames: [],
      subnamesDropped: [],
      cardRead: false,
      complete: false,
    })
  })

  it('takes no value from a card the node refuted', async () => {
    const old = oldCard()
    // Listed as live, but the node holds no UTXO for it: rule 1 refutes it, and nothing of it
    // is carried. A listing that fails rule 2 is refused the same way.
    const live = liveCard(encodeRecords({ url: 'old', x: { opaque: '182a' } }))
    const registrar = new Registrar({
      dotk: dotkListing([old.listing], live.listing),
      node: fakeNode(),
      signer: new LocalSigner(),
      account,
    })
    const plan = await registrar.planRecords(NAME, records)
    expect(plan.cards.carried).toEqual([])
    expect(plan.cards.complete).toBe(false)
  })

  it('refuses to save records over a live card it cannot decode, and still clears it', async () => {
    const old = oldCard()
    // A blob no reader decodes: an indefinite-length map, on a card the node proves.
    const live = liveCard(fromHex('bf'))
    const registrar = new Registrar({
      dotk: dotkListing([old.listing], live.listing),
      node: nodeWith({ [old.address]: [old.utxo], [live.address]: [live.utxo] }),
      signer: new LocalSigner(),
      account,
    })
    await expect(registrar.planRecords(NAME, records)).rejects.toThrow(UndecodableCardError)
    const cleared = await registrar.planRecords(NAME, null)
    expect(cleared.cards.minted).toBe(false)
  })

  it('mints for the recipient on a transfer with records, and sweeps unless told not to', async () => {
    const old = oldCard()
    const node = nodeWith({ [old.address]: [old.utxo] })
    const registrar = new Registrar({ dotk: dotkListing([old.listing]), node, signer: new LocalSigner(), account })

    const carried = await registrar.planTransfer(NAME, recipient, { records })
    expect(carried.cards).toEqual({
      minted: true,
      swept: 1,
      value: 0n,
      carried: [],
      dropped: [],
      subnames: [],
      subnamesDropped: [],
      cardRead: true,
      complete: true,
    })
    const minted = decodeCardPayload(fromHex(carried.assembled.tx.payload))!
    expect(toHex(minted.state.spender)).toBe(dotk.ownerOf(recipient).owner)

    const kept = await registrar.planTransfer(NAME, recipient, { sweep: false })
    expect(kept.cards).toEqual({
      minted: false,
      swept: 0,
      value: 0n,
      carried: [],
      dropped: [],
      subnames: [],
      subnamesDropped: [],
      cardRead: true,
      complete: true,
    })
    expect(kept.ownerSigInputs).toEqual([0])
  })

  it('sweeps only what the node still holds, and nothing without an api to list it', async () => {
    const old = oldCard()
    const spent = new Registrar({
      dotk: dotkListing([old.listing]),
      node: fakeNode(),
      signer: new LocalSigner(),
      account,
    })
    expect((await spent.planTransfer(NAME, recipient)).cards.swept).toBe(0)

    const blind = new Registrar({
      dotk,
      node: nodeWith({ [old.address]: [old.utxo] }),
      signer: new LocalSigner(),
      account,
    })
    expect((await blind.planTransfer(NAME, recipient)).cards.swept).toBe(0)
  })

  /** A card is the account's by its (spenderType, spender) pair, whatever the listing was asked for. */
  it('leaves a listed card under another scheme byte alone', async () => {
    const old = oldCard()
    const ecdsa = { ...old.listing, spenderType: OwnerType.P2pkEcdsaEven }
    const registrar = new Registrar({
      dotk: dotkListing([ecdsa]),
      node: nodeWith({ [old.address]: [old.utxo] }),
      signer: new LocalSigner(),
      account,
    })
    expect((await registrar.planTransfer(NAME, recipient)).cards.swept).toBe(0)
    await expect(registrar.planSweep()).rejects.toThrow(/no card/)
  })

  it('refuses a listed card whose UTXO pays to another script', async () => {
    const old = oldCard()
    const forged = { ...old.utxo, scriptPublicKey: coin.scriptPublicKey }
    const registrar = new Registrar({
      dotk: dotkListing([old.listing]),
      node: nodeWith({ [old.address]: [forged] }),
      signer: new LocalSigner(),
      account,
    })
    await expect(registrar.planTransfer(NAME, recipient)).rejects.toThrow(/card's script/)
  })

  it('sweeps leftover cards on their own, paying the account from the cards themselves', async () => {
    const old = oldCard()
    const submitted: Tx[] = []
    const signer = new LocalSigner()
    const registrar = new Registrar({
      dotk: dotkListing([old.listing]),
      node: nodeWith({ [old.address]: [old.utxo] }, submitted),
      signer,
      account,
    })
    const plan = await registrar.planSweep()
    expect(plan.cards).toBe(1)
    expect(plan.value + plan.fee).toBe(BigInt(CARD_VALUE))
    expect(plan.request.fundingInputs).toEqual([])
    expect(plan.ownerSigInputs).toEqual([0])
    expect(plan.assembled.tx.outputs[0]!.scriptPublicKey).toBe(toHex(scriptPublicKeyOf(address, dotk)))

    signer.tx = plan.assembled.tx
    await registrar.submit(plan)
    expect(submitted).toHaveLength(1)

    // Submitted once: the outpoint is struck off, so a second sweep finds nothing.
    await expect(registrar.planSweep()).rejects.toThrow(/no card/)
    await expect(registrar.planSweep('other')).rejects.toThrow(/no card/)
  })

  /**
   * Subnames: the `sub:<label>` entries of a card, which a save carries, replaces or drops under
   * the rule that it keeps every entry the given set does not name. The values themselves are
   * pinned by the corpus of `@dotk/sdk`. What is here is that rule, the listing a wallet shows
   * and the two refusals this package makes.
   */
  describe('subnames', () => {
    /** A registrar whose name carries this live card, with one older card of its own to sweep. */
    function holding(records: Records, name = NAME) {
      const old = oldCard(name)
      const live = liveCard(encodeRecords(records), name)
      return new Registrar({
        dotk: dotkListing([old.listing], live.listing, name),
        node: nodeWith({ [old.address]: [old.utxo], [live.address]: [live.utxo] }, [], name),
        signer: new LocalSigner(),
        account,
      })
    }

    /** The records the plan's own card carries. */
    function mintedRecords(plan: { assembled: { tx: Tx } }) {
      return decodeRecords(decodeCardPayload(fromHex(plan.assembled.tx.payload))!.blob)
    }

    it('lists the merged set as added, changed, unchanged and refused', async () => {
      const registrar = holding({ 'sub:bob': pays, 'sub:keep': pays, 'sub:bad': 'not a payee' })
      const plan = await registrar.planRecords(NAME, {
        url: 'https://alice.example',
        'sub:bob': paysSecond,
        'sub:new': pays,
      })
      expect(plan.cards.subnames).toEqual([
        { label: 'bad', address: null, fault: 'not-bytes', change: 'unchanged' },
        { label: 'bob', address: secondAddress, change: 'changed' },
        { label: 'keep', address: payeeAddress, change: 'unchanged' },
        { label: 'new', address: payeeAddress, change: 'added' },
      ])
      expect(plan.cards.subnamesDropped).toEqual([])
    })

    it('carries a sub: key the set does not name, refused or readable, and never as an opaque key', async () => {
      const registrar = holding({ 'sub:bob': pays, 'sub:bad': 'not a payee', x: { opaque: '182a' } })
      const plan = await registrar.planRecords(NAME, { url: 'https://alice.example' })
      // `carried` names the opaque values a surface cannot show, and a subname is never one.
      expect(plan.cards.carried).toEqual(['x'])
      expect(plan.cards.subnames).toEqual([
        { label: 'bad', address: null, fault: 'not-bytes', change: 'unchanged' },
        { label: 'bob', address: payeeAddress, change: 'unchanged' },
      ])
      expect(mintedRecords(plan)).toEqual({
        url: 'https://alice.example',
        'sub:bob': pays,
        'sub:bad': 'not a payee',
        x: { opaque: '182a' },
      })
    })

    it('drops a subname by the label the card stores, and lists the payee it paid', async () => {
      const registrar = holding({ 'sub:bob': pays, 'sub:keep': paysSecond, 'sub:Bob': pays })
      const plan = await registrar.planRecords(NAME, { url: 'https://alice.example' }, { dropSubnames: ['bob', 'Bob'] })
      // Key-byte order, whatever order the caller named the labels in. A counterparty can seat
      // a label no lookup reaches, and the holder can still remove it.
      expect(plan.cards.subnamesDropped).toEqual([
        { label: 'Bob', address: null, fault: 'bad-label' },
        { label: 'bob', address: payeeAddress },
      ])
      expect(plan.cards.subnames).toEqual([{ label: 'keep', address: secondAddress, change: 'unchanged' }])
      expect(mintedRecords(plan)).toEqual({ url: 'https://alice.example', 'sub:keep': paysSecond })

      // A clear ends every subname already, so a drop beside it names nothing that stays.
      await expect(registrar.planRecords(NAME, null, { dropSubnames: ['bob'] })).rejects.toThrow(
        /ends every subname already/
      )
    })

    it('refuses a sub: value the three rules refuse, with the tag that names the fault', async () => {
      const registrar = holding({ url: 'old' })
      const failed = await registrar.planRecords(NAME, { 'sub:bob': { opaque: '182a' } }).catch((e: unknown) => e)
      expect(failed).toBeInstanceOf(TxError)
      expect((failed as Error).message).toMatch(/cannot write sub:bob/)
      // The tag is the vocabulary a caller branches on, and it rides on the cause.
      expect(((failed as Error).cause as SubnameError).tag).toBe('not-bytes')
    })

    it('lists what a transfer that mints no card retires, and lists nothing without an api', async () => {
      const registrar = holding({ 'sub:bob': pays, 'sub:bad': 'not a payee' })
      const plan = await registrar.planTransfer(NAME, recipient)
      expect(plan.cards.minted).toBe(false)
      expect(plan.cards.subnamesDropped).toEqual([
        { label: 'bad', address: null, fault: 'not-bytes' },
        { label: 'bob', address: payeeAddress },
      ])

      const blind = new Registrar({ dotk, node: fakeNode(), signer: new LocalSigner(), account })
      const nothing = await blind.planTransfer(NAME, recipient)
      expect(nothing.cards.subnamesDropped).toEqual([])
      expect(nothing.cards.cardRead).toBe(false)
      // `complete` speaks for the set the caller gave, and this caller gave none.
      expect(nothing.cards.complete).toBe(true)
    })

    it('refuses a new or repointed subname under the one name no reader reaches', async () => {
      const registrar = holding({ 'sub:bob': pays }, GATED)
      await expect(registrar.planRecords(GATED, { 'sub:new': pays })).rejects.toThrow(/no reader reaches sub:new/)
      // A repoint is a write too, and no reader reaches the new payee either.
      await expect(registrar.planRecords(GATED, { 'sub:bob': paysSecond })).rejects.toThrow(/no reader reaches sub:bob/)
      // The holder of that name can still save, carry and drop the entry a counterparty seated.
      const carried = await registrar.planRecords(GATED, { url: 'https://example.com' })
      expect(carried.cards.subnames).toEqual([{ label: 'bob', address: payeeAddress, change: 'unchanged' }])
      const dropping = await registrar.planRecords(GATED, { url: 'https://example.com' }, { dropSubnames: ['bob'] })
      expect(dropping.cards.subnamesDropped).toEqual([{ label: 'bob', address: payeeAddress }])
    })

    it('refuses a drop when nobody can say what the card carries, and warns without one', async () => {
      // The API lists the card and the node holds no UTXO for it, so rule 1 refutes the listing.
      const live = liveCard(encodeRecords({ 'sub:bob': pays }))
      const refuted = new Registrar({
        dotk: dotkListing([], live.listing),
        node: fakeNode(),
        signer: new LocalSigner(),
        account,
      })
      await expect(refuted.planRecords(NAME, { url: 'x' }, { dropSubnames: ['bob'] })).rejects.toThrow(
        /writes back what it read/
      )
      // Without the drop the same plan builds, and `complete` is the 1.2.0 warning.
      expect((await refuted.planRecords(NAME, { url: 'x' })).cards.complete).toBe(false)

      const blind = new Registrar({ dotk, node: fakeNode(), signer: new LocalSigner(), account })
      await expect(blind.planRecords(NAME, { url: 'x' }, { dropSubnames: ['bob'] })).rejects.toThrow(
        /writes back what it read/
      )
    })

    /**
     * A transfer to another owner retires the card and every subname on it. The buyer mints
     * their own, so nothing of the seller's claims rides into it.
     */
    it("carries no subname of the seller into the buyer's card, and lists what ends", async () => {
      const registrar = holding({ 'sub:pay': pays, url: 'seller' })
      const plan = await registrar.planTransfer(NAME, recipient, { records: { url: 'buyer' } })
      expect(mintedRecords(plan)).toEqual({ url: 'buyer' })
      expect(plan.cards.subnames).toEqual([])
      expect(plan.cards.subnamesDropped).toEqual([{ label: 'pay', address: payeeAddress }])

      // What the seller seats for the buyer is what they named, and it is new to that card.
      const seated = await registrar.planTransfer(NAME, recipient, {
        records: { url: 'buyer', 'sub:pay': paysSecond },
      })
      expect(seated.cards.subnames).toEqual([{ label: 'pay', address: secondAddress, change: 'added' }])
      // One mark per label: a re-seated entry is added, and never ended beside it.
      expect(seated.cards.subnamesDropped).toEqual([])
      expect(mintedRecords(seated)).toEqual({ url: 'buyer', 'sub:pay': paysSecond })

      // Every subname ends there, so a drop names nothing that stays.
      await expect(
        registrar.planTransfer(NAME, recipient, { records: { url: 'buyer' }, dropSubnames: ['pay'] })
      ).rejects.toThrow(/names nothing that stays/)
    })

    /**
     * A transfer that writes no card back reads the live card only to say what it retires. A
     * fault on either side of that read costs the listing and nothing else, because the
     * transfer writes no card back.
     */
    it('plans a mint-less transfer when nothing can read the live card', async () => {
      const live = liveCard(encodeRecords({ 'sub:bob': pays }))
      const inner = fakeNode()
      const blindNode: TxNode = {
        ...inner,
        utxosOf: async (at) => {
          if (at === live.address) throw new Error('connect ECONNREFUSED 127.0.0.1:18210')
          return inner.utxosOf(at)
        },
      }
      const registrar = new Registrar({
        dotk: dotkListing([], live.listing),
        node: blindNode,
        signer: new LocalSigner(),
        account,
      })
      const plan = await registrar.planTransfer(NAME, recipient)
      expect(plan.cards.subnamesDropped).toEqual([])
      expect(plan.cards.cardRead).toBe(false)
      expect(plan.cards.complete).toBe(true)
      // A save writes the card back, so there the same node fault is the refusal it always was.
      await expect(registrar.planRecords(NAME, { url: 'x' })).rejects.toBeInstanceOf(NodeError)

      // The same for an API that answers the name with a server error.
      const failing: typeof fetch = async (input) => {
        if (urlOf(input).endsWith(`/spenders/0/${account.owner}/cards`)) {
          return new Response(
            JSON.stringify({
              spenderType: 0,
              spender: account.owner,
              address,
              cards: [],
              registryCovenantId: registry.registryCovenantId,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
        }
        return new Response('boom', { status: 500 })
      }
      const sick = new Registrar({
        dotk: new Dotk({ api: 'http://x', fetch: failing, network: 'testnet-10' }),
        node: fakeNode(),
        signer: new LocalSigner(),
        account,
      })
      const anyway = await sick.planTransfer(NAME, recipient)
      expect(anyway.cards.cardRead).toBe(false)
      expect(anyway.cards.subnamesDropped).toEqual([])
      expect(anyway.cards.complete).toBe(true)
    })

    /**
     * The optional probe swallows a node that cannot answer for the card. A cancellation is not
     * that. It is the caller's, and they get their own reason back, as every other call here
     * hands it back.
     */
    it('hands a cancellation back from the card probe as the reason the caller gave', async () => {
      const live = liveCard(encodeRecords({ 'sub:bob': pays }))
      const controller = new AbortController()
      const reason = new Error('the user pressed cancel')
      const inner = fakeNode()
      let funding = 0
      const canceling: TxNode = {
        ...inner,
        utxosOf: async (at) => {
          if (at === address) funding++
          if (at !== live.address) return inner.utxosOf(at)
          // The reader cancels while this probe is in flight, and the transport gives up.
          controller.abort(reason)
          throw new DOMException('aborted', 'AbortError')
        },
      }
      const registrar = new Registrar({
        dotk: dotkListing([], live.listing),
        node: canceling,
        signer: new LocalSigner(),
        account,
      })
      await expect(registrar.planTransfer(NAME, recipient, { signal: controller.signal })).rejects.toBe(reason)
      // The plan stopped where the reader canceled, so it never went looking for coins.
      expect(funding).toBe(0)
    })

    /**
     * The same on the other half of the read. A records save that meets a canceled listing
     * hands back the reader's reason, rather than a verdict on the API.
     */
    it('hands a cancellation back from the listing as the reason the caller gave', async () => {
      const controller = new AbortController()
      const reason = new Error('the user pressed cancel')
      const cancelingApi: typeof fetch = async (input) => {
        if (urlOf(input).endsWith(`/spenders/0/${account.owner}/cards`)) {
          return new Response(
            JSON.stringify({
              spenderType: 0,
              spender: account.owner,
              address,
              cards: [],
              registryCovenantId: registry.registryCovenantId,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
        }
        controller.abort(reason)
        throw new DOMException('aborted', 'AbortError')
      }
      const registrar = new Registrar({
        dotk: new Dotk({ api: 'http://x', fetch: cancelingApi, network: 'testnet-10' }),
        node: fakeNode(),
        signer: new LocalSigner(),
        account,
      })
      await expect(registrar.planRecords(NAME, { url: 'x' }, { signal: controller.signal })).rejects.toBe(reason)
    })

    /**
     * A listing alone is a hint. Nothing is known to end, so the clear has nothing to do and
     * says so, rather than paying a fee over a card nothing proved is there.
     */
    it('refuses the same clear over a card the node does not prove', async () => {
      const live = liveCard(encodeRecords({ 'sub:bob': pays }))
      const listing = dotkListing([], live.listing)
      // The node holds no UTXO for the card the API lists, so rule 1 refutes it.
      const refuted = new Registrar({ dotk: listing, node: fakeNode(), signer: new LocalSigner(), account })
      await expect(refuted.planRecords(NAME, null)).rejects.toThrow(/mints no card and sweeps none/)

      // The node cannot answer for the card at all, which is no verdict either way.
      const inner = fakeNode()
      const silent: TxNode = {
        ...inner,
        utxosOf: async (at) => {
          if (at === live.address) throw new Error('connect ECONNREFUSED 127.0.0.1:18210')
          return inner.utxosOf(at)
        },
      }
      const unanswered = new Registrar({ dotk: listing, node: silent, signer: new LocalSigner(), account })
      await expect(unanswered.planRecords(NAME, null)).rejects.toThrow(/mints no card and sweeps none/)
    })

    /**
     * A card a counterparty seated is retired by the transfer that moves the deed, and nothing
     * here can sweep it. That clear is the only way to end it, so it has to plan.
     */
    it('clears a card nothing here can sweep, and lists the subnames that end', async () => {
      const live = liveCard(encodeRecords({ 'sub:bob': pays, url: 'theirs' }))
      const registrar = new Registrar({
        dotk: dotkListing([], live.listing),
        node: nodeWith({ [live.address]: [live.utxo] }),
        signer: new LocalSigner(),
        account,
      })
      const plans = [
        await registrar.planRecords(NAME, null),
        await registrar.planRecords(NAME, {}, { dropSubnames: ['bob'] }),
      ]
      for (const plan of plans) {
        expect(plan.cards.minted).toBe(false)
        expect(plan.cards.swept).toBe(0)
        expect(plan.cards.subnamesDropped).toEqual([{ label: 'bob', address: payeeAddress }])
      }
    })

    it('mints no card for a set that merges to nothing', async () => {
      const registrar = holding({ 'sub:bob': pays })
      const plan = await registrar.planRecords(NAME, {}, { dropSubnames: ['bob'] })
      expect(plan.cards.minted).toBe(false)
      expect(plan.cards.swept).toBe(1)
      expect(plan.cards.subnamesDropped).toEqual([{ label: 'bob', address: payeeAddress }])
      expect(plan.assembled.tx.payload).toBe('')
    })
  })
})

/**
 * The rule that a save carries what it does not name, on its own. `mergeRecords` is
 * what every plan here mints from. It takes a record set rather than a node, so these cases
 * read as the rule reads.
 */
describe('mergeRecords', () => {
  const prefix = dotk.prefix

  it('carries every sub: entry the set does not name, readable or refused', () => {
    const live = { 'sub:bob': pays, 'sub:bad': 'not a payee', url: 'old', x: { opaque: '182a' } }
    const merged = mergeRecords({ url: 'new' }, live, { prefix })
    expect(merged.records).toEqual({ url: 'new', 'sub:bob': pays, 'sub:bad': 'not a payee', x: { opaque: '182a' } })
    // `carried` keeps its contract: the opaque values a surface cannot show, and nothing else.
    expect(merged.carried).toEqual(['x'])
    expect(merged.subnames).toEqual([
      { label: 'bad', address: null, fault: 'not-bytes', change: 'unchanged' },
      { label: 'bob', address: payeeAddress, change: 'unchanged' },
    ])
  })

  it('replaces the one the set names and lists it as changed', () => {
    const merged = mergeRecords({ 'sub:bob': paysSecond }, { 'sub:bob': pays }, { prefix })
    expect(merged.records).toEqual({ 'sub:bob': paysSecond })
    expect(merged.subnames).toEqual([{ label: 'bob', address: secondAddress, change: 'changed' }])
    expect(merged.dropped).toEqual([])
  })

  it('removes a label as the card stores it, and names the payee it paid', () => {
    const merged = mergeRecords({}, { 'sub:bob': pays, 'sub:Bob': paysSecond }, { prefix, dropSubnames: ['Bob'] })
    expect(merged.records).toEqual({ 'sub:bob': pays })
    expect(merged.subnamesDropped).toEqual([{ label: 'Bob', address: null, fault: 'bad-label' }])
    expect(merged.subnames).toEqual([{ label: 'bob', address: payeeAddress, change: 'unchanged' }])
  })

  it('refuses a drop of a label the live card does not carry', () => {
    expect(() => mergeRecords({}, { 'sub:bob': pays }, { prefix, dropSubnames: ['pay'] })).toThrow(
      /the live card carries no sub:pay to drop/
    )
    // With a name, the refusal names the card it read.
    expect(() => mergeRecords({}, { 'sub:bob': pays }, { prefix, dropSubnames: ['pay'], name: 'alice.k' })).toThrow(
      /alice.k's live card carries no sub:pay to drop/
    )
  })

  it('refuses a label the set both names and drops', () => {
    expect(() =>
      mergeRecords({ 'sub:bob': paysSecond }, { 'sub:bob': pays }, { prefix, dropSubnames: ['bob'] })
    ).toThrow(/both given a value and dropped/)
  })

  it('refuses a new sub: value the three rules refuse, and carries the same value back', () => {
    const failed = (() => {
      try {
        mergeRecords({ 'sub:bob': { opaque: '182a' } }, {}, { prefix })
      } catch (e) {
        return e
      }
      return undefined
    })()
    expect(failed).toBeInstanceOf(TxError)
    expect(((failed as Error).cause as SubnameError).tag).toBe('not-bytes')

    // The set read off the card and handed back whole is the entry staying where it is.
    const round = mergeRecords({ 'sub:bob': { opaque: '182a' } }, { 'sub:bob': { opaque: '182a' } }, { prefix })
    expect(round.subnames).toEqual([{ label: 'bob', address: null, fault: 'not-bytes', change: 'unchanged' }])
  })

  /**
   * The 1.2.0 call is still the 1.2.0 call. Every card written by that version holds no `sub:`
   * key, so nothing about a payee arises and the answer only gains two empty listings.
   */
  it('takes the 1.2.0 call over a set with no subname, and refuses one with a subname', () => {
    const merged = mergeRecords({ url: 'new' }, { url: 'old', x: { opaque: '182a' } })
    expect(merged.records).toEqual({ url: 'new', x: { opaque: '182a' } })
    expect(merged.carried).toEqual(['x'])
    expect(merged.subnames).toEqual([])
    expect(merged.subnamesDropped).toEqual([])

    // A payee is an address, and no set of records says which network it is on.
    expect(() => mergeRecords({ 'sub:bob': pays }, {})).toThrow(/needs the registry's network prefix/)
    expect(() => mergeRecords({ url: 'new' }, { 'sub:bob': pays })).toThrow(/needs the registry's network prefix/)
  })

  /**
   * A transfer to another owner retires the card, so nothing of it reaches the new owner's.
   * The seller reads what ends.
   */
  it('carries no subname of the live card to another owner', () => {
    const live = { 'sub:bob': pays, 'sub:bad': 'not a payee', x: { opaque: '182a' } }
    const merged = mergeRecords({ url: 'buyer' }, live, { prefix, sameOwner: false })
    expect(merged.records).toEqual({ url: 'buyer', x: { opaque: '182a' } })
    expect(merged.subnames).toEqual([])
    expect(merged.subnamesDropped).toEqual([
      { label: 'bad', address: null, fault: 'not-bytes' },
      { label: 'bob', address: payeeAddress },
    ])
    // The opaque values a reader cannot show still carry, as they do on a save.
    expect(merged.carried).toEqual(['x'])

    // What the buyer's card seats is what the given set names, and it is new to that card.
    const seated = mergeRecords({ 'sub:bob': paysSecond }, live, { prefix, sameOwner: false })
    expect(seated.subnames).toEqual([{ label: 'bob', address: secondAddress, change: 'added' }])
  })
})

/**
 * The two gap probes, which sit on the release and the registration paths and nowhere else.
 *
 * They are the only node calls a caller reaches through an api's answer rather than through an
 * address they handed over, and the deadline and the named transport failure have to hold there
 * too: a wedged node behind `planRelease` leaves a send screen spinning exactly as one behind
 * `planTransfer` would.
 */
describe('the gap probes behind planRelease and planRegistration', () => {
  const key = dotk.keyOf(NAME)
  const bound = (b: string) => b.repeat(32)
  const neighbours = { predecessor: { lo: bound('11'), hi: key }, successor: { lo: key, hi: bound('ee') } }
  const covering = { lo: bound('11'), hi: bound('ee') }

  /** A read client whose api answers this key's neighbourhood, and knows nothing else. */
  function dotkKey(answer: object) {
    const fetchFn: typeof fetch = async (input) => {
      if (!urlOf(input).endsWith(`/keys/${key}`)) return new Response('nope', { status: 404 })
      return new Response(
        JSON.stringify({ key, registryCovenantId: registry.registryCovenantId, proven: true, ...answer }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    }
    return new Dotk({ api: 'http://x', fetch: fetchFn, network: 'testnet-10' })
  }

  /** A node that answers for the deed and the account, and behaves like `gap` at a gap address. */
  function nodeBeyondTheDeed(gap: () => Promise<SpendableUtxo[]>): TxNode {
    const inner = fakeNode()
    const deedAddress = deedAddressOfState(registry, deedState(account.owner))
    return { ...inner, utxosOf: (at) => (at === deedAddress || at === address ? inner.utxosOf(at) : gap()) }
  }

  const silentGap = () => new Promise<SpendableUtxo[]>(() => undefined)
  const brokenGap = () => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:18210'))

  it('gives up after the deadline when the probe never answers', async () => {
    const r = new Registrar({
      dotk: dotkKey({ kind: 'active', neighbours }),
      node: nodeBeyondTheDeed(silentGap),
      signer: new LocalSigner(),
      account,
      timeoutMs: 30,
    })
    await expect(r.planRelease(NAME)).rejects.toThrow(TimeoutError)
  })

  it('names a transport failure from the probe rather than passing the socket’s words up bare', async () => {
    const r = new Registrar({
      dotk: dotkKey({ kind: 'active', neighbours }),
      node: nodeBeyondTheDeed(brokenGap),
      signer: new LocalSigner(),
      account,
    })
    await expect(r.planRelease(NAME)).rejects.toBeInstanceOf(NodeError)
  })

  it('holds the registration’s covering-gap probe to the same deadline', async () => {
    const r = new Registrar({
      dotk: dotkKey({ kind: 'free', covering }),
      node: nodeBeyondTheDeed(silentGap),
      signer: new LocalSigner(),
      account,
      timeoutMs: 30,
    })
    await expect(r.planRegistration(NAME)).rejects.toThrow(TimeoutError)
  })
})

/**
 * Registering, and finishing a registration whose commit landed on its own.
 *
 * The reveal carries no signature of its own, so it can be rebuilt from the PENDING deed and a
 * fresh coin. That is the only way back into a half-landed registration, and what `register`
 * names when the reveal is refused.
 */
describe('registering a name', () => {
  /** A gap covering this key, wide enough to hold it at both ends. */
  function coveringGap(): Gap {
    const lo = '00'.repeat(32)
    const hi = 'ff'.repeat(32)
    const state = encodeGapState(fromHex(lo), fromHex(hi))
    return {
      lo,
      hi,
      outpoint: { transactionId: 'ba'.repeat(32), index: 0 },
      amount: BigInt(registry.params.gap_value),
      scriptPublicKey: toHex(registry.gap.scriptPublicKey(state)),
      scriptVersion: 0,
      blockDaaScore: 0n,
      isCoinbase: false,
      covenantId: registry.registryCovenantId,
    }
  }

  /** The PENDING deed a commit leaves behind, where `planActivate` has to find it. */
  function pendingDeed() {
    const state = encodePendingDeedState(fromHex(dotk.keyOf(NAME)), names.claimOf(NAME, OwnerType.Pubkey, ownerPub))
    return {
      address: registry.deed.address(dotk.prefix, state).text,
      utxo: {
        outpoint: { transactionId: 'ab'.repeat(32), index: 2 },
        amount: BigInt(registry.params.bond) + BigInt(registry.params.deposit),
        scriptPublicKey: toHex(registry.deed.scriptPublicKey(state)),
        scriptVersion: 0,
        blockDaaScore: 0n,
        isCoinbase: false,
        covenantId: registry.registryCovenantId,
      } satisfies SpendableUtxo,
    }
  }

  /** A node also holding these UTXOs at these addresses. */
  function nodeHolding(at: Record<string, SpendableUtxo[]>, submitted: Tx[] = []): TxNode {
    const inner = fakeNode({ submitted })
    return { ...inner, utxosOf: async (a) => at[a] ?? inner.utxosOf(a) }
  }

  /** A wallet that signs the transactions it was told to expect, in order, and can refuse one. */
  class ScriptedSigner implements Signer {
    prompts = 0
    constructor(
      private readonly txs: Tx[],
      private readonly refuseAt = 0
    ) {}
    supportsOwnerScheme(): boolean {
      return true
    }
    async sign(request: SignRequest): Promise<string> {
      const at = this.prompts++
      if (at + 1 === this.refuseAt) throw new Error('the user said no')
      const local = new LocalSigner()
      local.tx = this.txs[at]!
      return local.sign(request)
    }
  }

  it('rebuilds the reveal from the deed the commit left, and sends it', async () => {
    const pending = pendingDeed()
    const submitted: Tx[] = []
    const signer = new LocalSigner()
    const registrar = new Registrar({
      dotk,
      node: nodeHolding({ [pending.address]: [pending.utxo] }, submitted),
      signer,
      account,
    })

    const plan = await registrar.planActivate(NAME)
    expect(plan.name).toBe(NAME)
    expect(plan.deed).toBe(deedAddressOfState(registry, deedState(account.owner)))
    expect(plan.tier).toBe(BigInt(feeForName(registry.params, NAME)))
    expect(plan.assembled.tx.inputs[0]!.previousOutpoint).toEqual(pending.utxo.outpoint)
    // The preimage is the whole authorization, so the deed's own seat is signed by nobody.
    expect(plan.ownerSigInputs).toEqual([])
    expect(plan.assembled.tx.outputs[0]!.value).toBe(BigInt(registry.params.bond))

    signer.tx = plan.assembled.tx
    expect(await registrar.submit(plan)).toMatch(/^[0-9a-f]{64}$/)
    expect(submitted).toHaveLength(1)
  })

  it('says so when no pending deed of this account is there to finish', async () => {
    const { registrar } = registrarWith(fakeNode())
    await expect(registrar.planActivate(NAME)).rejects.toThrow(/no PENDING deed/)
  })

  /**
   * What the comment on `register` promises: both signatures are in hand before anything is
   * sent, so a wallet refusal leaves the name free rather than committed to and unrevealed.
   */
  it('takes both signatures before the commit is sent', async () => {
    const gap = coveringGap()
    const submitted: Tx[] = []
    const node = nodeHolding({}, submitted)
    const planner = new Registrar({ dotk, node, signer: new LocalSigner(), account })
    const planned = await planner.planRegistration(NAME, { gap })

    const wallet = new ScriptedSigner([planned.commit.assembled.tx, planned.reveal.assembled.tx], 2)
    const registrar = new Registrar({ dotk, node, signer: wallet, account })
    await expect(registrar.register(NAME, { gap })).rejects.toThrow(/the user said no/)
    expect(wallet.prompts).toBe(2)
    expect(submitted).toEqual([])
  })

  it('sends the commit and then the reveal, in that order', async () => {
    const gap = coveringGap()
    const submitted: Tx[] = []
    const node = nodeHolding({}, submitted)
    const planner = new Registrar({ dotk, node, signer: new LocalSigner(), account })
    const planned = await planner.planRegistration(NAME, { gap })

    const wallet = new ScriptedSigner([planned.commit.assembled.tx, planned.reveal.assembled.tx])
    const registrar = new Registrar({ dotk, node, signer: wallet, account })
    const sent = await registrar.register(NAME, { gap })
    expect(sent.commit).toMatch(/^[0-9a-f]{64}$/)
    expect(submitted).toHaveLength(2)
    expect(submitted[0]!.inputs[0]!.previousOutpoint).toEqual(gap.outpoint)
    expect(submitted[1]!.outputs[0]!.value).toBe(BigInt(registry.params.bond))
  })

  it('names the way back in when the reveal is refused after the commit lands', async () => {
    const gap = coveringGap()
    const submitted: Tx[] = []
    const node = nodeHolding({}, submitted)
    const planner = new Registrar({ dotk, node, signer: new LocalSigner(), account })
    const planned = await planner.planRegistration(NAME, { gap })

    let sends = 0
    const refusing: TxNode = {
      ...node,
      submit: async (tx) => {
        if (++sends === 2) throw new Error('transaction is not standard')
        submitted.push(tx)
        return 'cc'.repeat(32)
      },
    }
    const wallet = new ScriptedSigner([planned.commit.assembled.tx, planned.reveal.assembled.tx])
    const registrar = new Registrar({ dotk, node: refusing, signer: wallet, account })
    await expect(registrar.register(NAME, { gap })).rejects.toThrow(/planActivate/)
    expect(submitted).toHaveLength(1)
  })
})

/**
 * A submission strikes every input the node took, and a protocol seat is one of them. The node
 * lists the seat until the transaction confirms, so a second plan on it would prompt the wallet
 * for a transaction the node refuses as stale. A seat of unknown outcome is different: the reveal
 * that a failed activation leaves is retried through exactly such a seat.
 */
describe('the seats a submission spent', () => {
  const second: SpendableUtxo = { ...coin, outpoint: { transactionId: 'dd'.repeat(32), index: 2 } }
  const key = dotk.keyOf(NAME)
  function gapAt(lo: string, hi: string, seed: string): Gap {
    const state = encodeGapState(fromHex(lo), fromHex(hi))
    return {
      lo,
      hi,
      outpoint: { transactionId: seed.repeat(32), index: 0 },
      amount: BigInt(registry.params.gap_value),
      scriptPublicKey: toHex(registry.gap.scriptPublicKey(state)),
      scriptVersion: 0,
      blockDaaScore: 0n,
      isCoinbase: false,
      covenantId: registry.registryCovenantId,
    }
  }
  const neighbours = { pred: gapAt('00'.repeat(32), key, 'ba'), succ: gapAt(key, 'ff'.repeat(32), 'bc') }
  const other = 'other'

  it('refuses to plan on a deed one of its own submissions already spends', async () => {
    const { registrar, signer } = registrarWith(fakeNode({ coins: [coin, second] }))
    const first = await registrar.planTransfer(NAME, recipient)
    ;(signer as LocalSigner).tx = first.assembled.tx
    await registrar.submit(first)
    const e = await registrar.planTransfer(NAME, recipient).catch((e: unknown) => e)
    expect(e).toBeInstanceOf(TxError)
    expect(e).not.toBeInstanceOf(InsufficientFundingError)
    expect((e as Error).message).toMatch(/wait for it to confirm/)
    // The node took it, so a resync changes nothing.
    registrar.resync()
    await expect(registrar.planTransfer(NAME, recipient)).rejects.toThrow(/wait for it to confirm/)
  })

  it('still plans on a deed whose submission had no known outcome', async () => {
    const node = {
      ...fakeNode({ coins: [coin, second] }),
      submit: async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:18210')
      },
    }
    const { registrar, signer } = registrarWith(node)
    const first = await registrar.planTransfer(NAME, recipient)
    ;(signer as LocalSigner).tx = first.assembled.tx
    await expect(registrar.submit(first)).rejects.toBeInstanceOf(SdkNodeError)
    await expect(registrar.planTransfer(NAME, recipient)).resolves.toBeDefined()
  })

  it('refuses a gap a release already spent, whether a caller passes it or a plan reaches it', async () => {
    const { registrar, signer } = registrarWith(nodeHoldingAlso(other, { coins: [coin, second] }))
    const release = await registrar.planRelease(NAME, { neighbours })
    ;(signer as LocalSigner).tx = release.assembled.tx
    await registrar.submit(release)
    await expect(registrar.planRelease(other, { neighbours })).rejects.toThrow(/wait for it to confirm/)
    await expect(registrar.planRegistration(other, { gap: neighbours.pred })).rejects.toThrow(/wait for it to confirm/)
  })

  /** A bound that is not hex is refused as this package's own error, never as a bare TypeError. */
  it('refuses a neighbour whose bound is not hex, as a TxError', async () => {
    const { registrar } = registrarWith(fakeNode())
    const odd = { pred: { ...neighbours.pred, lo: 'zz' }, succ: neighbours.succ }
    const e = await registrar.planRelease(NAME, { neighbours: odd }).catch((e: unknown) => e)
    expect(e).toBeInstanceOf(TxError)
    expect((e as Error).message).toMatch(/gap lo/)
  })

  /** What a node reports is decoded as this package's own refusal, on the plan and on the send. */
  it('refuses hex a node reports that is not hex, as its own error, before and after the wallet', async () => {
    const oddCoin = registrarWith(fakeNode({ coins: [{ ...coin, scriptPublicKey: 'zz' }] }))
    const sent = await (async () => {
      const plan = await oddCoin.registrar.planTransfer(NAME, recipient)
      ;(oddCoin.signer as LocalSigner).tx = plan.assembled.tx
      return oddCoin.registrar.submit(plan)
    })().catch((e: unknown) => e)
    expect(sent).toBeInstanceOf(DotkError)
    const oddDeed = registrarWith(fakeNode({ deed: [deedUtxo({ outpoint: { transactionId: 'zz', index: 0 } })] }))
    const planned = await oddDeed.registrar.planTransfer(NAME, recipient).catch((e: unknown) => e)
    expect(planned).toBeInstanceOf(DotkError)
  })

  it('refuses a pair of neighbours under the wrong field names, by name', async () => {
    const { registrar } = registrarWith(fakeNode())
    const wrong = { predecessor: neighbours.pred, successor: neighbours.succ } as unknown as typeof neighbours
    await expect(registrar.planRelease(NAME, { neighbours: wrong })).rejects.toThrow(/must carry `pred` and `succ`/)
  })

  it('refuses a PENDING deed an activation already spends', async () => {
    const state = encodePendingDeedState(fromHex(key), names.claimOf(NAME, OwnerType.Pubkey, ownerPub))
    const at = registry.deed.address(dotk.prefix, state).text
    const pending: SpendableUtxo = {
      outpoint: { transactionId: 'ab'.repeat(32), index: 2 },
      amount: BigInt(registry.params.bond) + BigInt(registry.params.deposit),
      scriptPublicKey: toHex(registry.deed.scriptPublicKey(state)),
      scriptVersion: 0,
      blockDaaScore: 0n,
      isCoinbase: false,
      covenantId: registry.registryCovenantId,
    }
    const inner = fakeNode({ coins: [coin, second] })
    const node: TxNode = { ...inner, utxosOf: async (a) => (a === at ? [pending] : inner.utxosOf(a)) }
    const { registrar, signer } = registrarWith(node)
    const first = await registrar.planActivate(NAME)
    ;(signer as LocalSigner).tx = first.assembled.tx
    await registrar.submit(first)
    await expect(registrar.planActivate(NAME)).rejects.toThrow(/wait for it to confirm/)
  })
})

/** A release pays its fee from what it frees, and a coin of any size binds the change. */
describe('a release from a wallet that holds almost nothing', () => {
  const key = dotk.keyOf(NAME)
  function gapAt(lo: string, hi: string, seed: string): Gap {
    const state = encodeGapState(fromHex(lo), fromHex(hi))
    return {
      lo,
      hi,
      outpoint: { transactionId: seed.repeat(32), index: 0 },
      amount: BigInt(registry.params.gap_value),
      scriptPublicKey: toHex(registry.gap.scriptPublicKey(state)),
      scriptVersion: 0,
      blockDaaScore: 0n,
      isCoinbase: false,
      covenantId: registry.registryCovenantId,
    }
  }
  const neighbours = { pred: gapAt('00'.repeat(32), key, 'ba'), succ: gapAt(key, 'ff'.repeat(32), 'bc') }

  it('builds on a coin smaller than the fee, and refuses an empty wallet with the remedy', async () => {
    const tiny: SpendableUtxo = { ...coin, amount: 1_000n }
    const funded = registrarWith(fakeNode({ coins: [tiny] })).registrar
    const plan = await funded.planRelease(NAME, { neighbours })
    expect(plan.assembled.fundingInputs).toEqual([3])
    expect(plan.returned).toBe(BigInt(registry.params.bond) + BigInt(registry.params.gap_value) - plan.fee)
    const empty = registrarWith(fakeNode({ coins: [] })).registrar
    const e = await empty.planRelease(NAME, { neighbours }).catch((e: unknown) => e)
    expect(e).toBeInstanceOf(InsufficientFundingError)
    expect((e as Error).message).toMatch(/one signed funding input of any size/)
  })
})
