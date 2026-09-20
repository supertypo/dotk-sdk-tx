// Cross-implementation proof: a real dotk name transfer, its covenant seat signed by Kaspire's
// own Rust core (compiled to wasm), and verified by this package.
//
// The Kaspire wallet on Android signs a dotk transaction over WalletConnect by calling its
// `kaspa_signPskt`, which runs the same `sign_pskt` this test drives directly. The feasibility
// question for that whole path is one thing: does Kaspire's signer authorize a dotk deed's
// transfer seat in a way `applySignatures` accepts? If it does, the signature is valid under the
// deed owner's key over our exact transaction, which is what the covenant's `transfer` entry
// checks with checkSig.
//
// Skipped unless `KASPIRE_WASM` names the wasm-bindgen `kaspa_secure_core.cjs` for Kaspire's
// core, because that 6.6 MB third-party binary is not vendored here. To build it, from a Kaspire
// checkout (github.com/KaspaHUB21/Kaspire-Kaspa-Wallet):
//
//   cargo +1.98.0 build -p kaspa_secure_core --target wasm32-unknown-unknown --release
//   wasm-bindgen --target nodejs --out-dir <dir> \
//     target/wasm32-unknown-unknown/release/kaspa_secure_core.wasm
//   KASPIRE_WASM=<dir>/kaspa_secure_core.cjs npm test

import { createRequire } from 'node:module'
import { Dotk, OwnerType, Version, encodeActiveDeedState, encodeAddress, fromHex, hex32, toHex } from '@dotk/sdk'
import { schnorr } from '@noble/curves/secp256k1.js'
import { describe, expect, it } from 'vitest'
import type { SpendableUtxo, TxNode } from '../../src/ports.js'
import { Registrar, scriptPublicKeyOf } from '../../src/registrar.js'
import { applySignatures } from '../../src/sign.js'
import { deedAddressOfState } from '../../src/transfer.js'

const WASM = process.env['KASPIRE_WASM']
interface KaspireCore {
  preparePskt(request: string): string
  signPskt(secret: string, request: string, reviewHash: string): string
}
const kaspire: KaspireCore | null = WASM ? (createRequire(import.meta.url)(WASM) as KaspireCore) : null

const dotk = new Dotk({ api: null, network: 'testnet-10' })
const registry = dotk.protocol
const NAME = 'sdktest'

const ownerKey = schnorr.utils.randomSecretKey()
const ownerPub = schnorr.getPublicKey(ownerKey)
const ownerHex = toHex(ownerKey)
const address = encodeAddress('kaspatest', Version.PubKey, ownerPub)
const account = { address, ownerType: OwnerType.Pubkey, owner: toHex(ownerPub) }
const recipient = encodeAddress('kaspatest', Version.PubKey, schnorr.getPublicKey(schnorr.utils.randomSecretKey()))

function deedState() {
  return { key: dotk.keyOf(NAME), ownerType: OwnerType.Pubkey, owner: account.owner, name: NAME }
}
function deedUtxo(): SpendableUtxo {
  const name = new Uint8Array(32)
  name.set(new TextEncoder().encode(NAME))
  const bytes = encodeActiveDeedState(fromHex(dotk.keyOf(NAME)), OwnerType.Pubkey, hex32(account.owner, 'owner'), name)
  return {
    outpoint: { transactionId: 'aa'.repeat(32), index: 0 },
    amount: BigInt(registry.params.bond),
    scriptPublicKey: toHex(registry.deed.scriptPublicKey(bytes)),
    scriptVersion: 0,
    blockDaaScore: 0n,
    isCoinbase: false,
    covenantId: registry.registryCovenantId,
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
const deedAddress = deedAddressOfState(registry, deedState())
const node: TxNode = {
  async utxosOf(at) {
    if (at === deedAddress) return [deedUtxo()]
    if (at === address) return [coin]
    return []
  },
  async feerate() {
    return 1
  },
  async submit() {
    throw new Error('the harness never broadcasts')
  },
}

// A signer that hands the plan to Kaspire's wasm rather than signing itself, exactly as the
// Android wallet's `kaspa_signPskt` handler does.
const kaspireSigner = {
  supportsOwnerScheme: (t: number) => t === OwnerType.Pubkey,
  async sign(request: { txJson: string; ownerSigInputs: readonly number[]; fundingInputs: readonly number[] }) {
    // Kaspire refuses a pre-signed input, so the owner seats are emptied for its copy; the
    // signature commits to the previous output's script, never the spending input's.
    const body = JSON.parse(request.txJson) as { inputs: { signatureScript: string }[] }
    for (const index of request.ownerSigInputs) body.inputs[index]!.signatureScript = ''
    const kaspireRequest = {
      sender: address,
      txJsonString: JSON.stringify(body),
      // No `scripts` entry: Kaspire then writes a plain 65-byte signature push, which our
      // extractor reads for both the covenant seat and the funding coin.
      signInputs: [...request.ownerSigInputs, ...request.fundingInputs].map((index) => ({ index, sighashType: 1 })),
    }
    const review = JSON.parse(kaspire!.preparePskt(JSON.stringify(kaspireRequest))) as { reviewHash: string }
    const signed = JSON.parse(
      kaspire!.signPskt('private:' + ownerHex, JSON.stringify(kaspireRequest), review.reviewHash)
    ) as {
      signedTxJson: string
    }
    return signed.signedTxJson
  },
}

describe.skipIf(!kaspire)('Kaspire signs a dotk transfer this package accepts', () => {
  it('authorizes the covenant seat and every funding input', async () => {
    const registrar = new Registrar({ dotk, node, signer: kaspireSigner, account })
    const plan = await registrar.planTransfer(NAME, recipient)

    const signedJson = await kaspireSigner.sign(plan.request)
    // applySignatures verifies each returned signature against the owner's key over our
    // transaction and throws on any mismatch, so reaching a value is the proof.
    const merged = applySignatures(
      plan.assembled.tx,
      signedJson,
      plan.request.fundingInputs,
      plan.request.ownerSigInputs,
      account
    )

    const seat = plan.request.ownerSigInputs[0]!
    expect(merged.inputs[seat]!.signatureScript.length).toBeGreaterThan(0)
    expect(plan.request.fundingInputs.length).toBeGreaterThan(0)
  })
})
