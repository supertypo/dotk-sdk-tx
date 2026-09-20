// The fee, derived the way the mempool prices a transaction. A wrong constant here costs money
// and raises no error. Each one carries the name of the consensus constant it mirrors, and the
// corpus in `tests/` replays the reference implementation's answers.
//
// Storage mass is here too and is not part of the fee. KIP-9 prices it contextually, over the
// values a transaction consumes and creates. A node refuses a transaction over the limit without
// charging more for it. This package models storage mass because the refusal is otherwise
// invisible until the node makes it, by which time a wallet already prompted its user.

import { hexLen, type Tx } from './tx.js'

/** `mass_per_tx_byte`. */
const MASS_PER_TX_BYTE = 1n
/** `mass_per_script_pub_key_byte`. */
const MASS_PER_SCRIPT_PUB_KEY_BYTE = 10n
/** `GRAMS_PER_COMPUTE_BUDGET_UNIT`. */
const GRAMS_PER_COMPUTE_BUDGET_UNIT = 100n
/** `TRANSIENT_BYTE_TO_MASS_FACTOR`. */
const TRANSIENT_BYTE_TO_MASS_FACTOR = 4n
/**
 * The mempool's transient cofactor, which normalizes transient mass against compute mass.
 *
 * Consensus derives it as the compute block limit over the transient one. Every network sets
 * those to 500_000 and 1_000_000, so it is one half everywhere. This package carries no
 * consensus params to derive it from, so it states the result.
 */
export const TRANSIENT_COFACTOR = 0.5
/**
 * How far past a coinbase output's DAA score the chain must be before anything can spend it.
 *
 * Consensus sets it per network, and every network this package runs on agrees on this value. A
 * selection of a younger one builds a transaction the node refuses, and nothing here sees it.
 */
export const COINBASE_MATURITY = 1000n

/** `MINIMUM_RELAY_FEE_SOMPI_PER_KG`: the floor a transaction pays to be relayed at all. */
const MINIMUM_RELAY_FEE_SOMPI_PER_KG = 100_000n
/** The margin every fee carries. It absorbs signature-script size drift. */
const FEE_MARGIN_NUMERATOR = 105n
const FEE_MARGIN_DENOMINATOR = 100n

const HASH_SIZE = 32n
const SUBNETWORK_ID_SIZE = 20n

/** `transaction_estimated_serialized_size`, which is a byte count and not a serialization. */
export function estimatedSerializedSize(tx: Tx): bigint {
  let size = 2n // version (u16)
  size += 8n // input count (u64)
  for (const input of tx.inputs) {
    size += 32n + 4n // outpoint: transaction id (32) and index (u32)
    size += 8n + BigInt(hexLen(input.signatureScript)) // length prefix and the script
    size += 8n // sequence (u64)
    if (tx.version >= 1) size += 2n // compute budget (u16)
  }
  size += 8n // output count (u64)
  for (const output of tx.outputs) {
    size += 8n // value (u64)
    size += 2n // script public key version (u16)
    size += 8n + BigInt(hexLen(output.scriptPublicKey)) // length prefix and the script
    if (output.covenant !== undefined) size += 2n + HASH_SIZE // authorizing input and covenant id
  }
  size += 8n // lock time (u64)
  size += SUBNETWORK_ID_SIZE
  size += 8n // gas (u64)
  size += HASH_SIZE // payload hash
  size += 8n + BigInt(hexLen(tx.payload)) // payload length prefix and the payload
  return size
}

export interface Masses {
  size: bigint
  compute: bigint
  transient: bigint
  /** What the mempool charges the fee against. It is the larger of compute and normalized transient. */
  fee: bigint
}

export function massesOf(tx: Tx): Masses {
  const size = estimatedSerializedSize(tx)
  const scriptBytes = tx.outputs.reduce((n, o) => n + 2n + BigInt(hexLen(o.scriptPublicKey)), 0n)
  const budget = tx.inputs.reduce((n, i) => n + BigInt(i.computeBudget), 0n)
  const compute =
    size * MASS_PER_TX_BYTE + scriptBytes * MASS_PER_SCRIPT_PUB_KEY_BYTE + GRAMS_PER_COMPUTE_BUDGET_UNIT * budget
  const transient = size * TRANSIENT_BYTE_TO_MASS_FACTOR
  const normalized = BigInt(Math.ceil(Number(transient) * TRANSIENT_COFACTOR))
  return { size, compute, transient, fee: compute > normalized ? compute : normalized }
}

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b
}

/**
 * The relay minimum for a transaction of this mass. The per-kilogram rate stands in where the
 * division rounds the fee away entirely, which the mempool otherwise prices at nothing.
 */
export function relayMinimumFee(feeMass: bigint): bigint {
  const fee = (feeMass * MINIMUM_RELAY_FEE_SOMPI_PER_KG) / 1000n
  return fee === 0n ? MINIMUM_RELAY_FEE_SOMPI_PER_KG : fee
}

/**
 * What this transaction must pay at the node's current feerate, in sompi.
 *
 * The estimate arrives unvalidated from a node the caller did not necessarily choose, so a
 * negative or non-finite one reads as zero and the relay minimum decides. The ceiling in
 * `assemble` is what bounds the answer from above.
 */
export function requiredFee(tx: Tx, feerateSompiPerGram: number): bigint {
  const { fee: feeMass } = massesOf(tx)
  const rate = Number.isFinite(feerateSompiPerGram) ? Math.max(feerateSompiPerGram, 0) : 0
  const product = Math.ceil(Number(feeMass) * rate)
  // A rate large enough to overflow the product is one the ceiling in `assemble` refuses, and
  // that is the refusal worth reading. `BigInt(Infinity)` raises a RangeError instead.
  const market = Number.isFinite(product) ? BigInt(product) : BigInt(Number.MAX_SAFE_INTEGER)
  const floor = relayMinimumFee(feeMass)
  const chosen = market > floor ? market : floor
  return ceilDiv(chosen * FEE_MARGIN_NUMERATOR, FEE_MARGIN_DENOMINATOR)
}

/**
 * KIP-9 storage mass, and the per-transaction limits a node measures it against.
 *
 * This package ships no wasm, so it restates what kaspa's own `MassCalculator` computes. The
 * corpus holds the two to the same answers. Nothing here is a fee, and a node refuses a
 * transaction over one of these limits without repricing it.
 */
/** `STORAGE_MASS_PARAMETER`, the `C` of KIP-9. */
export const STORAGE_MASS_PARAMETER = 1_000_000_000_000n

/** Fixed bytes of a UTXO, before its script and any covenant id. */
const UTXO_CONST_STORAGE = 63n
/** Bytes per storage unit. Every standard script fits one. */
const UTXO_UNIT_SIZE = 100n
/** A covenant id adds its own 32 bytes, which is what puts a protocol output on two units. */
const UTXO_COVENANT_STORAGE = 32n

/** The per-transaction mass limits a node applies, which are Toccata's on every live network. */
export const MASS_LIMITS = { compute: 500_000n, storage: 500_000n, transient: 1_000_000n } as const

/** Whether an entry carries a covenant id, read as a JS caller may have passed it. */
function hasCovenant(id: unknown): boolean {
  return typeof id === 'string' && id.length > 0
}

/** How many 100-byte storage units this output or entry occupies. */
function plurality(scriptPublicKey: string, hasCovenant: boolean): bigint {
  const bytes = UTXO_CONST_STORAGE + BigInt(hexLen(scriptPublicKey)) + (hasCovenant ? UTXO_COVENANT_STORAGE : 0n)
  return (bytes + UTXO_UNIT_SIZE - 1n) / UTXO_UNIT_SIZE
}

/** One side of the formula. It is `(plurality, amount)` for every input or output. */
interface Cell {
  plurality: bigint
  amount: bigint
}

/**
 * `max(0, C·(|O|/H(O) − |I|/A(I)))`, with KIP-9's relaxed form where it applies.
 *
 * The relaxed form takes the harmonic mean over the inputs too. It applies when `|O| = 1`,
 * `|I| = 1`, or `|O| = |I| = 2`, counted in storage units. A covenant-bound output counts twice,
 * so no registry shape reaches it. The answer is `null` wherever the formula cannot price a side,
 * which is a non-positive value on either one.
 */
function storageMass(ins: Cell[], outs: Cell[]): bigint | null {
  let outsPlurality = 0n
  let harmonicOuts = 0n
  for (const cell of outs) {
    if (cell.amount <= 0n) return null
    outsPlurality += cell.plurality
    harmonicOuts += (STORAGE_MASS_PARAMETER * cell.plurality * cell.plurality) / cell.amount
  }
  const insPlurality = ins.reduce((total, cell) => total + cell.plurality, 0n)
  const relaxed = outsPlurality === 1n || insPlurality === 1n || (outsPlurality === 2n && insPlurality === 2n)
  if (relaxed) {
    let harmonicIns = 0n
    for (const cell of ins) {
      if (cell.amount <= 0n) return null
      harmonicIns += (STORAGE_MASS_PARAMETER * cell.plurality * cell.plurality) / cell.amount
    }
    return harmonicOuts > harmonicIns ? harmonicOuts - harmonicIns : 0n
  }
  const sumIns = ins.reduce((total, cell) => total + cell.amount, 0n)
  if (insPlurality === 0n) return null
  const meanIns = sumIns / insPlurality
  const arithmeticIns = insPlurality * (STORAGE_MASS_PARAMETER / (meanIns > 0n ? meanIns : 1n))
  return harmonicOuts > arithmeticIns ? harmonicOuts - arithmeticIns : 0n
}

/**
 * The storage mass of an assembled transaction, or `null` where the formula declines to answer.
 *
 * The inputs' values and scripts come from the entries the transaction carries, so this needs no
 * node. A covenant id counts on either side. It is what makes a protocol output cost four times
 * what its value alone suggests, and counting one as absent understates the answer.
 */
export function storageMassOf(tx: Tx): bigint | null {
  const ins: Cell[] = tx.inputs.map((input) => ({
    plurality: plurality(input.utxo.scriptPublicKey, hasCovenant(input.utxo.covenantId)),
    amount: input.utxo.amount,
  }))
  const outs: Cell[] = tx.outputs.map((output) => ({
    plurality: plurality(output.scriptPublicKey, output.covenant !== undefined),
    amount: output.value,
  }))
  return storageMass(ins, outs)
}

/** The dimension a transaction outgrows, if any, with the numbers to say so. */
export interface MassOverrun {
  dimension: 'compute' | 'transient' | 'storage'
  /**
   * What the transaction measures in that dimension, and `null` for the one case where no
   * figure exists. That case is a storage mass the formula declines to answer at all.
   */
  mass: bigint | null
  cap: bigint
}

/**
 * Which limit `tx` exceeds, if any.
 *
 * A storage mass the formula declines to price counts as an overrun with no figure to it. What a
 * node charges such a transaction is unknown here, not known to be small.
 */
export function massOverrun(tx: Tx): MassOverrun | null {
  const masses = massesOf(tx)
  const storage = storageMassOf(tx)
  if (storage === null) return { dimension: 'storage', mass: null, cap: MASS_LIMITS.storage }
  // Measured, so every `mass` here is a figure. The branch above answers the one case without one.
  const measured: { dimension: MassOverrun['dimension']; mass: bigint; cap: bigint }[] = [
    { dimension: 'compute', mass: masses.compute, cap: MASS_LIMITS.compute },
    { dimension: 'transient', mass: masses.transient, cap: MASS_LIMITS.transient },
    { dimension: 'storage', mass: storage, cap: MASS_LIMITS.storage },
  ]
  return measured.find((m) => m.mass > m.cap) ?? null
}
