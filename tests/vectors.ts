// The corpus, one per registry `@dotk/sdk` can address. The reference implementation computes it
// and the parent workspace's generator writes it under tests/generated/<network>/ here. It is
// committed, so what these tests replay is a reviewed file and a clone of this repository alone
// can run them. It is a build artifact of that workspace rather than anything `@dotk/sdk`
// publishes, so it is read by path.
import { readdirSync, readFileSync } from 'node:fs'
import { DEPLOYMENT_NETWORKS, Dotk } from '@dotk/sdk'

export interface Vectors {
  manifest: { network: string; registryCovenantId: string }
  owner: { network: string; ownerType: number; owner: string; address: string | null }[]
  deedAddress: { network: string; name: string; ownerType: number; owner: string; state: string; address: string }[]
  gapAddress: { network: string; lo: string; hi: string; state: string; address: string }[]
  feeForName: { name: string; fee: number }[]
  rejection: { message: string; verdict: string | null }[]
  consensus: {
    network: string
    transientCofactor: number
    coinbaseMaturity: number
    massLimits: { compute: number; storage: number; transient: number }
    storageMassParameter: number
  }[]
  registrationAssembly: {
    name: string
    ownerType: number
    owner: string
    gap: { lo: string; hi: string; outpoint: [string, number]; spk: string }
    funding: [string, number, number][]
    fundingSpk: string
    changeSpk: string
    feerate: number
    splitSigScript: string
    splitOutputs: [number, string][]
    splitRequiredFunding: number
    splitFee: number
    splitChange: [number, number] | null
    activateSigScript: string
    activateOutputs: [number, string][]
    activateRequiredFunding: number
    activateFee: number
    activateChange: [number, number] | null
    feeTier: number
  }[]
  releaseAssembly: {
    name: string
    ownerType: number
    owner: string
    pred: { lo: string; hi: string; outpoint: [string, number]; spk: string }
    succ: { lo: string; hi: string; outpoint: [string, number]; spk: string }
    deedOutpoint: [string, number]
    funding: [string, number, number][]
    fundingSpk: string
    changeSpk: string
    feerate: number
    sigScripts: string[]
    mergedSpk: string
    size: number
    computeMass: number
    transientMass: number
    feeMass: number
    fee: number
    released: number
    changeValue: number | null
    safeJson: string
    sighashes: { input: number; schnorr: string; ecdsa: string }[]
  }[]
  storageMass: {
    why: string
    ins: { spk: string; amount: number; covenant: boolean }[]
    outs: { spk: string; amount: number; covenant: boolean }[]
    mass: number | null
  }[]
  changeScript: { address: string; spk: string }[]
  transferAssembly: {
    name: string
    ownerType: number
    owner: string
    newOwnerType: number
    newOwner: string
    deedOutpoint: [string, number]
    funding: [string, number, number][]
    fundingSpk: string
    changeSpk: string
    feerate: number
    size: number
    computeMass: number
    transientMass: number
    feeMass: number
    fee: number
    changeValue: number | null
    safeJson: string
    rpcJson: string
    sighashes: { input: number; schnorr: string; ecdsa: string }[]
  }[]
  cardAssembly: (Omit<Vectors['transferAssembly'][number], 'changeValue'> & {
    changeValue: number
    cards: {
      mint?: { records: Record<string, string | boolean | { opaque: string }>; spenderType: number; spender: string }
      sweep: { outpoint: [string, number]; value: number; recordsHash: string; spenderType: number; spender: string }[]
    }
  })[]
  transferSigScript: {
    name: string
    ownerType: number
    owner: string
    newOwnerType: number
    newOwner: string
    witness: number
    sig: string | null
    sigScript: string
  }[]
}

// `@dotk/sdk` carries a manifest per registry it can address, and a corpus is committed here for
// each: the copies are written in one pass and committed in two repositories, so either can be
// the stale one, and the parent workspace's own test recomputes every copy on disk. The suites replay
// one registry's, testnet-10, because what they hold to account is the TypeScript against
// the reference implementation. What does vary by deployment is the templates a script derives through, and every
// committed corpus is at least held to the manifest of the registry it names, below: a corpus
// written from another deployment would disagree with the bundled manifest everywhere, and the
// reason is better said once here than inferred from a hundred failing comparisons.
const client = new Dotk({ api: null, network: 'testnet-10' })
const generated = new URL('./generated/', import.meta.url)
const read = (network: string) =>
  JSON.parse(readFileSync(new URL(`${network}/vectors.json`, generated), 'utf8')) as Vectors
export const vectors = read(client.network)

const committed = readdirSync(generated)
for (const network of DEPLOYMENT_NETWORKS) {
  if (!committed.includes(network)) {
    throw new Error(
      `${network}: @dotk/sdk carries this registry and no corpus is committed for it. ` +
        `Rerun the generator in the parent workspace`
    )
  }
}
for (const network of committed) {
  if (!DEPLOYMENT_NETWORKS.includes(network)) {
    throw new Error(
      `${network}: a corpus for a registry @dotk/sdk does not carry; delete it, or bundle the registry there`
    )
  }
  const corpus = read(network)
  const bundled = new Dotk({ api: null, network }).registryCovenantId
  if (corpus.manifest.network !== network || corpus.manifest.registryCovenantId !== bundled) {
    throw new Error(
      `${network}: vectors.json was written from another deployment than the bundled manifest. ` +
        `Rerun the generator in the parent workspace`
    )
  }
}
