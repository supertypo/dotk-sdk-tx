import { Dotk, InvalidNameError, OwnerType, names, toHex } from '@dotk/sdk'
import { describe, expect, it } from 'vitest'
import { assemble } from '../src/assemble.js'
import { TxError } from '../src/errors.js'
import { transactionId } from '../src/sighash.js'
import { activateIntent, splitIntent, type Pending } from '../src/register.js'
import type { Gap } from '../src/release.js'
import { vectors } from './vectors.js'

const registry = new Dotk({ api: null, network: 'testnet-10' }).protocol

/**
 * A registration, both halves, against the pair the corpus holds for the same coins.
 *
 * Built as a pair rather than as two cases, because the pair is the thing that goes wrong: each
 * half measures clean on its own, and only the reveal, built on the commit's own change, can be
 * over a limit. Replaying them separately would agree with the corpus about two transactions that
 * never have to be funded by one another.
 */
describe('a registration agrees with the corpus', () => {
  it.each(vectors.registrationAssembly.map((c) => [c.name, c] as const))('registers %s', (_name, c) => {
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
    const split = splitIntent(registry, gap, c.name, c.ownerType, c.owner)
    expect(split.base.inputs[0]!.signatureScript).toBe(c.splitSigScript)
    expect(split.base.outputs.map((o) => [Number(o.value), o.scriptPublicKey])).toEqual(c.splitOutputs)
    expect(split.requiredFunding).toBe(BigInt(c.splitRequiredFunding))

    const funding = c.funding.map(([transactionId, index, amount]) => ({
      outpoint: { transactionId, index },
      amount: BigInt(amount),
      scriptPublicKey: c.fundingSpk,
      scriptVersion: 0,
      blockDaaScore: 0n,
      isCoinbase: false,
    }))
    const committed = assemble(split.base, {
      funding,
      changeScriptPublicKey: c.changeSpk,
      feerate: c.feerate,
      requiredFunding: split.requiredFunding,
    })
    expect(committed.fee).toBe(BigInt(c.splitFee))
    expect(committed.changeIndex).toBe(c.splitChange![0])

    // The reveal, on the commit's own change: the outpoint is the commit's txid, which is why
    // both halves can be built and signed before either is sent.
    const txid = transactionId(committed.tx)
    const pending: Pending = {
      key: split.newborn.key,
      claim: split.newborn.claim,
      outpoint: { transactionId: txid, index: split.newborn.outputIndex },
      amount: split.newborn.value,
      scriptPublicKey: split.base.outputs[split.newborn.outputIndex]!.scriptPublicKey,
      scriptVersion: 0,
      blockDaaScore: 0n,
      isCoinbase: false,
      covenantId: registry.registryCovenantId,
    }
    const activate = activateIntent(registry, pending, c.name, c.ownerType, c.owner)
    expect(activate.base.inputs[0]!.signatureScript).toBe(c.activateSigScript)
    expect(activate.base.outputs.map((o) => [Number(o.value), o.scriptPublicKey])).toEqual(c.activateOutputs)
    expect(activate.requiredFunding).toBe(BigInt(c.activateRequiredFunding))
    expect(activate.fee).toBe(BigInt(c.feeTier))

    const revealed = assemble(activate.base, {
      funding: [
        {
          outpoint: { transactionId: txid, index: c.splitChange![0] },
          amount: BigInt(c.splitChange![1]),
          scriptPublicKey: c.changeSpk,
          scriptVersion: 0,
          blockDaaScore: 0n,
          isCoinbase: false,
        },
      ],
      changeScriptPublicKey: c.changeSpk,
      feerate: c.feerate,
      requiredFunding: activate.requiredFunding,
    })
    expect(revealed.fee).toBe(BigInt(c.activateFee))
  })

  it('refuses a key the gap does not cover', () => {
    const c = vectors.registrationAssembly[0]!
    const key = toHex(names.keyBytesOf(c.name))
    const gap: Gap = {
      lo: key,
      hi: c.gap.hi,
      outpoint: { transactionId: c.gap.outpoint[0], index: c.gap.outpoint[1] },
      amount: BigInt(registry.params.gap_value),
      scriptPublicKey: c.gap.spk,
      scriptVersion: 0,
      blockDaaScore: 0n,
      isCoinbase: false,
      covenantId: registry.registryCovenantId,
    }
    // `lo` equal to the key is the boundary of a registration that already exists, and the
    // covenant's containment is strict at both ends.
    expect(() => splitIntent(registry, gap, c.name, c.ownerType, c.owner)).toThrow(/strictly inside/)
  })
})

/**
 * The claim binds the owner for good, so an owner nothing can spend must be refused before the
 * posting, on both halves, as the reference refuses it. A deed under a script hash or a
 * covenant id, a zero payload, or a key off the curve holds the posting where no spend reaches.
 */
describe('what a registration refuses', () => {
  const c = vectors.registrationAssembly[0]!
  const gap = (): Gap => ({
    lo: c.gap.lo,
    hi: c.gap.hi,
    outpoint: { transactionId: c.gap.outpoint[0], index: c.gap.outpoint[1] },
    amount: BigInt(registry.params.gap_value),
    scriptPublicKey: c.gap.spk,
    scriptVersion: 0,
    blockDaaScore: 0n,
    isCoinbase: false,
    covenantId: registry.registryCovenantId,
  })
  const pending = (): Pending => {
    const split = splitIntent(registry, gap(), c.name, c.ownerType, c.owner)
    return {
      key: split.newborn.key,
      claim: split.newborn.claim,
      outpoint: { transactionId: 'ee'.repeat(32), index: split.newborn.outputIndex },
      amount: split.newborn.value,
      scriptPublicKey: split.base.outputs[split.newborn.outputIndex]!.scriptPublicKey,
      scriptVersion: 0,
      blockDaaScore: 0n,
      isCoinbase: false,
      covenantId: registry.registryCovenantId,
    }
  }
  const refused: [string, number, string, RegExp][] = [
    ['a script hash', OwnerType.ScriptHash, c.owner, /co-present input/],
    ['a covenant id', OwnerType.CovenantId, registry.registryCovenantId, /covenant id/],
    ['a zero payload', c.ownerType, '00'.repeat(32), /32 zero bytes/],
    ['a key off the curve', c.ownerType, 'ff'.repeat(32), /secp256k1/],
  ]

  it.each(refused)('refuses %s as the owner of a commit', (_what, ownerType, owner, words) => {
    expect(() => splitIntent(registry, gap(), c.name, ownerType, owner)).toThrow(TxError)
    expect(() => splitIntent(registry, gap(), c.name, ownerType, owner)).toThrow(words)
  })

  it.each(refused)('refuses %s as the owner of a reveal', (_what, ownerType, owner, words) => {
    expect(() => activateIntent(registry, pending(), c.name, ownerType, owner)).toThrow(TxError)
    expect(() => activateIntent(registry, pending(), c.name, ownerType, owner)).toThrow(words)
  })

  /** A name the deed covenant refuses is refused before the commit, or the posting would be unrecoverable. */
  it.each(['bad name!', '-a', 'a-', 'x'.repeat(33)])('refuses %s as a name on both halves', (name) => {
    expect(() => splitIntent(registry, gap(), name, c.ownerType, c.owner)).toThrow(InvalidNameError)
    expect(() => activateIntent(registry, pending(), name, c.ownerType, c.owner)).toThrow(InvalidNameError)
  })

  /** A PENDING deed holds exactly the posting. A node that understates it would turn the surplus into fee. */
  it('refuses a PENDING deed that does not hold bond plus deposit', () => {
    const short = { ...pending(), amount: pending().amount - 1n }
    expect(() => activateIntent(registry, short, c.name, c.ownerType, c.owner)).toThrow(/holds exactly/)
    expect(activateIntent(registry, pending(), c.name, c.ownerType, c.owner).base.inputs).toHaveLength(1)
  })
})
