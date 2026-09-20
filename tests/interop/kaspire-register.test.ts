// Cross-implementation proof for a registration: both halves, the commit that splits a gap and
// the reveal that activates the deed, signed by Kaspire's own Rust core (compiled to wasm) and
// verified by this package. The wallet signs only the funding inputs in each: the covenant seat
// carries this package's own signature script and is left as it is, which is the one shape the
// transfer proof in `kaspire.test.ts` does not cover.
//
// Skipped unless `KASPIRE_WASM` names the wasm-bindgen module; `kaspire.test.ts` says how to
// build one.
import { createRequire } from 'node:module'
import { Dotk, OwnerType, Version, encodeAddress, toHex } from '@dotk/sdk'
import { schnorr } from '@noble/curves/secp256k1.js'
import { describe, expect, it } from 'vitest'
import type { SpendableUtxo, TxNode } from '../../src/ports.js'
import { Registrar, scriptPublicKeyOf } from '../../src/registrar.js'
import type { Gap } from '../../src/release.js'
import { applySignatures } from '../../src/sign.js'
import { vectors } from '../vectors.js'

const WASM = process.env['KASPIRE_WASM']
interface KaspireCore {
  preparePskt(request: string): string
  signPskt(secret: string, request: string, reviewHash: string): string
}
const kaspire: KaspireCore | null = WASM ? (createRequire(import.meta.url)(WASM) as KaspireCore) : null

const dotk = new Dotk({ api: null, network: 'testnet-10' })
const registry = dotk.protocol

const ownerKey = schnorr.utils.randomSecretKey()
const ownerPub = schnorr.getPublicKey(ownerKey)
const ownerHex = toHex(ownerKey)
const address = encodeAddress('kaspatest', Version.PubKey, ownerPub)
const account = { address, ownerType: OwnerType.Pubkey, owner: toHex(ownerPub) }

const coin: SpendableUtxo = {
  outpoint: { transactionId: 'bb'.repeat(32), index: 1 },
  amount: 10_000_000_000n,
  scriptPublicKey: toHex(scriptPublicKeyOf(address, dotk)),
  scriptVersion: 0,
  blockDaaScore: 0n,
  isCoinbase: false,
}
const node: TxNode = {
  async utxosOf(at) {
    return at === address ? [coin] : []
  },
  async feerate() {
    return 1
  },
  async submit() {
    throw new Error('the harness never broadcasts')
  },
}

/** The request as a Kaspire adapter forms it: owner seats emptied, every index named. */
function kaspireSign(request: { txJson: string; ownerSigInputs: readonly number[]; fundingInputs: readonly number[] }) {
  const body = JSON.parse(request.txJson) as { inputs: { signatureScript: string }[] }
  for (const index of request.ownerSigInputs) body.inputs[index]!.signatureScript = ''
  const kaspireRequest = {
    sender: address,
    txJsonString: JSON.stringify(body),
    signInputs: [...request.ownerSigInputs, ...request.fundingInputs].map((index) => ({ index, sighashType: 1 })),
  }
  const review = JSON.parse(kaspire!.preparePskt(JSON.stringify(kaspireRequest))) as {
    reviewHash: string
    warnings: string[]
  }
  const signed = JSON.parse(
    kaspire!.signPskt('private:' + ownerHex, JSON.stringify(kaspireRequest), review.reviewHash)
  ) as {
    signedTxJson: string
  }
  return { review, signedTxJson: signed.signedTxJson }
}

describe.skipIf(!kaspire)('Kaspire signs a dotk registration this package accepts', () => {
  it('authorizes the funding inputs of the commit and of the reveal', async () => {
    const c = vectors.registrationAssembly[0]!
    const gap: Gap = {
      lo: c.gap.lo,
      hi: c.gap.hi,
      outpoint: { transactionId: c.gap.outpoint[0], index: c.gap.outpoint[1] },
      amount: BigInt(registry.params.gap_value),
      scriptPublicKey: c.gap.spk,
      scriptVersion: 0,
      blockDaaScore: 0n,
      isCoinbase: false,
      covenantId: registry.registryCovenantId,
    }
    const registrar = new Registrar({
      dotk,
      node,
      signer: { supportsOwnerScheme: () => true, sign: async () => '' },
      account,
    })
    const plan = await registrar.planRegistration(c.name, { gap })

    for (const half of [plan.commit, plan.reveal]) {
      const { review, signedTxJson } = kaspireSign(half.request)
      expect(review.warnings).toEqual(['This is a partial signature; other parties may add signatures.'])
      const merged = applySignatures(
        half.assembled.tx,
        signedTxJson,
        half.request.fundingInputs,
        half.request.ownerSigInputs,
        account
      )
      for (const index of half.request.fundingInputs)
        expect(merged.inputs[index]!.signatureScript.length).toBeGreaterThan(0)
    }
  })
})
