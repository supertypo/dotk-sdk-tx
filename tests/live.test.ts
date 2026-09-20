// The only test here that proves anything a node agrees with.
//
// Everything else in this suite proves this package agrees with the corpus. That is necessary
// and it is not sufficient: both could be wrong about something consensus checks, and no offline
// corpus would notice. This one builds a transfer, signs it with a real key, submits it to a
// real node and waits for the deed to appear where it derived that it would.
//
// No wasm anywhere, including here: the node is reached over wRPC JSON in plain TypeScript.
//
// Skipped unless `DOTK_LIVE_NODE` names a node started with `--rpclisten-json`. It needs the
// deployment the packages are built against, and two funded keys at `~/.dotk/<network>/`:
// `wallet.key`, which owns `DOTK_LIVE_NAME`, and `wallet2.key`, which the name is handed to and
// back from.
//
// It moves the name between the two keys and back, so it is repeatable and leaves the registry
// as it found it. It spends real coins: two transfers, network fee only. With `DOTK_LIVE_API`
// naming an indexer serving that deployment, the outbound transfer also mints a card for the
// second key, and the return sweeps it, so the card's value comes back too.

import { readFileSync } from 'node:fs'
import {
  CARD_VALUE,
  Dotk,
  OwnerType,
  type Records,
  Version,
  cardAddress,
  decodeCardPayload,
  encodeAddress,
  fromHex,
  toHex,
} from '@dotk/sdk'
import { schnorr } from '@noble/curves/secp256k1.js'
import { describe, expect, it } from 'vitest'
import type { Account, SignRequest, Signer } from '../src/ports.js'
import { Registrar } from '../src/registrar.js'
import { schnorrSighash } from '../src/sighash.js'
import { SIGHASH_ALL, patchPlaceholder } from '../src/sign.js'
import type { Tx } from '../src/tx.js'
import { WrpcJson, nodeOver } from '../src/wrpc.js'

const NODE = process.env['DOTK_LIVE_NODE']
const API = process.env['DOTK_LIVE_API']
// The registry the node and api are on. This test spends, so an unset variable is testnet-10,
// and mainnet runs only where the variable names it.
const NETWORK = process.env['DOTK_LIVE_NETWORK'] ?? 'testnet-10'
// Resolved once, so the key directory below follows the same registry the clients address.
const KEY_NETWORK = new Dotk({ api: null, network: NETWORK }).network
const NAME = process.env['DOTK_LIVE_NAME'] ?? 'sdktest'
const live = NODE ? describe : describe.skip

/**
 * Where the deployer's tooling keeps this machine's testnet keys, which is where these read
 * them from.
 *
 * Never the checkout. A funded key there is one `git add` from a remote, and an ignore rule is
 * the only thing that would have stopped it. The deployer's wallet tool writes the first, and the
 * second is made by hand beside it.
 */
function keyAt(name: string): { secret: Uint8Array; account: Account; address: string } {
  // Resolved per call rather than at module scope: this file is imported even when the suite is
  // skipped, and an unset HOME would otherwise interpolate to `file:///undefined/.dotk/…`, a
  // path rather than a refusal, which is the opposite of the rule `dotk` follows for the same
  // directory.
  const home = process.env['HOME']
  if (!home) throw new Error(`HOME is unset, so ~/.dotk/${KEY_NETWORK}/ cannot be found`)
  const hex = readFileSync(new URL(name, new URL(`${home}/.dotk/${KEY_NETWORK}/`, 'file:')), 'utf8').trim()
  const secret = Uint8Array.from(hex.match(/../g)!.map((b) => parseInt(b, 16)))
  const xonly = schnorr.getPublicKey(secret)
  const address = encodeAddress(new Dotk({ api: null, network: NETWORK }).prefix, Version.PubKey, xonly)
  return { secret, address, account: { address, ownerType: OwnerType.Pubkey, owner: toHex(xonly) } }
}

/**
 * A wallet, standing in for one that holds a key.
 *
 * It signs the named inputs by index under SIGHASH_ALL and returns the transaction otherwise
 * untouched, which is the whole contract. `tx` is handed to it rather than parsed out of the
 * body, which is the one liberty a real wallet does not have.
 */
class LocalSigner implements Signer {
  tx: Tx | undefined
  constructor(private readonly secret: Uint8Array) {}

  supportsOwnerScheme(ownerType: number): boolean {
    return ownerType === OwnerType.Pubkey
  }

  async sign(request: SignRequest): Promise<string> {
    const tx = this.tx
    if (!tx) throw new Error('the test did not hand this signer the transaction')
    const owners = new Set(request.ownerSigInputs)
    const funding = new Set(request.fundingInputs)
    const inputs = tx.inputs.map((input, at) => {
      if (!owners.has(at) && !funding.has(at)) return { signatureScript: input.signatureScript }
      const sig = new Uint8Array(65)
      sig.set(schnorr.sign(schnorrSighash(tx, at), this.secret))
      sig[64] = SIGHASH_ALL
      // A covenant seat comes back as the script it was handed with the signature written in,
      // which is what a real wallet returns; a funding input as one canonical push.
      const script = owners.has(at)
        ? patchPlaceholder(fromHex(input.signatureScript), sig)
        : Uint8Array.of(0x41, ...sig)
      return {
        signatureScript: toHex(script),
        transactionId: input.previousOutpoint.transactionId,
        index: input.previousOutpoint.index,
      }
    })
    return JSON.stringify({ inputs })
  }
}

live('against a real node', () => {
  // Read inside the test, never beside it: vitest evaluates a skipped suite's body, and these
  // files are untracked, so a fresh clone would fail here instead of skipping.
  type Key = ReturnType<typeof keyAt>

  /** Hand the name from one key to the other, and answer once the chain shows it moved. */
  const handOver = async (from: Key, to: Key, records?: Records) => {
    const rpc = await WrpcJson.connect(NODE!)
    try {
      const dotk = new Dotk({ api: API ?? null, network: NETWORK })
      const node = nodeOver(rpc, dotk.network)
      const signer = new LocalSigner(from.secret)
      const registrar = new Registrar({ dotk, node, signer, account: from.account })

      const plan = await registrar.planTransfer(NAME, to.address, records ? { records } : undefined)
      expect(plan.fee).toBeGreaterThan(0n)
      expect(plan.fromDeed).not.toBe(plan.toDeed)
      expect(plan.recipient).toBe(to.address)
      expect(plan.cards.minted).toBe(records !== undefined)
      signer.tx = plan.assembled.tx

      const txid = await registrar.submit(plan)
      expect(txid).toMatch(/^[0-9a-f]{64}$/)
      // The id the node answers with is the one this package computed before signing.
      expect(txid).toBe(JSON.parse(plan.request.txJson).id)

      const minted = decodeCardPayload(fromHex(plan.assembled.tx.payload))
      const cardAt = minted && cardAddress(dotk.prefix, minted.state)
      for (let tries = 0; tries < 40; tries++) {
        const held = await node.utxosOf(plan.toDeed)
        if (held.some((u) => u.covenantId?.toLowerCase() === dotk.protocol.registryCovenantId)) {
          // Rule 2 in the flesh: the card is output 1 of the transaction the deed came from.
          if (cardAt) {
            const card = (await node.utxosOf(cardAt)).find((u) => u.outpoint.transactionId === txid)
            expect(card?.outpoint.index).toBe(1)
            expect(card?.amount).toBe(BigInt(CARD_VALUE))
          }
          return { txid, plan }
        }
        await new Promise((r) => setTimeout(r, 1500))
      }
      throw new Error(`the transfer was accepted as ${txid} but the deed never appeared at ${plan.toDeed}`)
    } finally {
      rpc.close()
    }
  }

  it('moves a name to another key and back', async () => {
    const a = keyAt('wallet.key')
    const b = keyAt('wallet2.key')
    const there = await handOver(a, b, API ? { url: 'https://kaspa.org', primary: true } : undefined)
    if (API) {
      // The return sweeps what the indexer lists, so wait for it to have seen the mint.
      const dotk = new Dotk({ api: API, network: NETWORK })
      for (let tries = 0; tries < 40; tries++) {
        if ((await dotk.cardsOf(b.address)).some((c) => c.outpointTxid === there.txid)) break
        await new Promise((r) => setTimeout(r, 1500))
      }
    }
    const back = await handOver(b, a)
    // The round trip is closed: the deed is back where it started, by a different route.
    expect(back.plan.toDeed).toBe(there.plan.fromDeed)
    expect(back.txid).not.toBe(there.txid)
    // The card minted on the way out came back with the return, once the indexer had listed it.
    if (API) expect(back.plan.cards.swept).toBe(1)
  }, 300_000)
  /**
   * The whole life of a name against a real mempool: register it, transfer it, and release it.
   *
   * The registration is what this exists for. It is two transactions and the second is funded by
   * the first's change, so a node is the only thing that can say whether the pair this package
   * builds actually relays. The corpus proves agreement with the reference implementation and can be wrong with
   * it. The release closes the round trip, so the run leaves the registry exactly as it found it
   * and the coins come home.
   */
  it('registers a fresh name, hands it over and releases it', async () => {
    const rpc = await WrpcJson.connect(NODE!)
    try {
      const a = keyAt('wallet.key')
      const b = keyAt('wallet2.key')
      const dotk = new Dotk({ api: API ?? null, network: NETWORK })
      const node = nodeOver(rpc, dotk.network)
      const fresh = `sdk${Date.now().toString(36)}`

      const signerA = new LocalSigner(a.secret)
      const asA = new Registrar({ dotk, node, signer: signerA, account: a.account })

      // --- register: the commit and the reveal, both built before either is signed ---
      const plan = await asA.planRegistration(fresh)
      expect(plan.name).toBe(fresh)
      expect(plan.tier).toBe(BigInt(dotk.quote(fresh).fee))
      expect(plan.locked).toBe(BigInt(dotk.params.bond) + BigInt(dotk.params.gap_value))
      expect(plan.fee).toBeGreaterThan(0n)
      // The reveal is chained on the commit's own change, which is why both can be signed first.
      expect(plan.reveal.assembled.tx.inputs[1]!.previousOutpoint.transactionId).toBe(
        JSON.parse(plan.commit.request.txJson).id
      )

      signerA.tx = plan.commit.assembled.tx
      const commit = await asA.submit(plan.commit)
      expect(commit).toBe(JSON.parse(plan.commit.request.txJson).id)
      signerA.tx = plan.reveal.assembled.tx
      const reveal = await asA.submit(plan.reveal)
      expect(reveal).toBe(JSON.parse(plan.reveal.request.txJson).id)

      // The deed the plan named is the one the chain now holds, under this registry's lineage.
      const held = await waitForDeed(node, dotk, plan.deed)
      expect(held.amount).toBe(BigInt(dotk.params.bond))

      // --- and the name resolves to the address that registered it ---
      if (API) {
        for (let tries = 0; tries < 40; tries++) {
          if ((await dotk.addressFor(fresh)) === a.address) break
          await new Promise((r) => setTimeout(r, 1500))
        }
        expect(await dotk.addressFor(fresh)).toBe(a.address)
      }

      // --- transfer it, so the release is driven by a key that did not register it ---
      const moved = await asA.planTransfer(fresh, b.address)
      signerA.tx = moved.assembled.tx
      await asA.submit(moved)
      await waitForDeed(node, dotk, moved.toDeed)

      // --- release: the exit merge, three registry inputs and one widened gap ---
      const signerB = new LocalSigner(b.secret)
      const asB = new Registrar({ dotk, node, signer: signerB, account: b.account })
      if (API) {
        // The neighbours come from the api and are proved on the node, so wait for it to have
        // seen the transfer before asking it which gaps flank the name.
        for (let tries = 0; tries < 40; tries++) {
          if ((await dotk.addressFor(fresh)) === b.address) break
          await new Promise((r) => setTimeout(r, 1500))
        }
      }
      const ended = await asB.planRelease(fresh)
      expect(ended.name).toBe(fresh)
      expect(ended.returned).toBe(BigInt(dotk.params.bond) + BigInt(dotk.params.gap_value) - ended.fee)
      signerB.tx = ended.assembled.tx
      const exit = await asB.submit(ended)
      expect(exit).toMatch(/^[0-9a-f]{64}$/)

      // The deed is gone, which is the only thing that says the merge really landed.
      for (let tries = 0; tries < 40; tries++) {
        const still = await node.utxosOf(ended.fromDeed)
        if (!still.some((u) => u.covenantId?.toLowerCase() === dotk.protocol.registryCovenantId)) {
          console.log(
            `  ${fresh}.k: registered (${commit}, ${reveal}), handed over, released (${exit}); ` +
              `tier ${plan.tier} sompi, fees ${plan.fee + moved.fee + ended.fee}`
          )
          return
        }
        await new Promise((r) => setTimeout(r, 1500))
      }
      throw new Error(`${fresh} was released but its deed is still on chain`)
    } finally {
      rpc.close()
    }
  }, 600_000)

  /** Wait for a deed to appear at an address under this registry's covenant id. */
  const waitForDeed = async (node: ReturnType<typeof nodeOver>, dotk: Dotk, address: string) => {
    for (let tries = 0; tries < 40; tries++) {
      const held = await node.utxosOf(address)
      const found = held.find((u) => u.covenantId?.toLowerCase() === dotk.protocol.registryCovenantId)
      if (found) return found
      await new Promise((r) => setTimeout(r, 1500))
    }
    throw new Error(`no deed appeared at ${address}`)
  }
})
