# @dotk/sdk-tx

Register a `.k` name on Kaspa, move it to another owner, save its records and end it. This
package is the write half of a pair. [`@dotk/sdk`](https://www.npmjs.com/package/@dotk/sdk) reads
the registry, and this one builds, signs and sends transactions against it.

```bash
npm install @dotk/sdk @dotk/sdk-tx
```

This package asks you for a node and a signer. A wallet already has both. Nothing here dials
anything or holds a key.

## Use

```ts
import { Dotk } from '@dotk/sdk'
import { Registrar, nodesOver } from '@dotk/sdk-tx'

// One client, both halves: reading a name and building a transaction ask different things of
// it, so they are two objects.
const { read, tx } = nodesOver(rpcClient, 'mainnet') // the first transaction call confirms the node is on it

const dotk = new Dotk({ node: read }) // the read client proves what it reads
const account = { address, ...dotk.ownerOf(address) } // the account that holds the name
const registrar = new Registrar({ dotk, node: tx, signer, account })

const plan = await registrar.planTransfer('alice.k', 'kaspa:qz…')
// show plan.recipient and plan.fee, then:
const txid = await registrar.submit(plan)
```

Show the person `plan.recipient`, which is the address they typed. `plan.fromDeed` and
`plan.toDeed` are where the deed itself sits. They are script addresses, and a reader cannot make
sure that they are right.

An unqualified client addresses mainnet, so addresses are `kaspa:`. `new Dotk({ network: 'testnet-10' })`
addresses the testnet registry, whose addresses are `kaspatest:`. The registry belongs to the
client. The network you give `nodesOver` selects nothing. It is the network that this package
makes sure the node is on.

When you show nothing in between, use `registrar.transfer(name, to)` to do both steps at once.

## Calls

This package builds and measures every plan before it signs anything, so a refusal costs nothing.
`submit` signs what needs a signature and sends it. `submit` takes any plan but the registration.
A registration is two transactions, so there you pass `plan.commit` and then `plan.reveal`.

| Call                                            | What it does                                                                                                                               |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `planRegistration(name)` / `register(name)`     | the commit and the reveal, both built and measured before either is signed                                                                 |
| `planTransfer(name, to)` / `transfer(name, to)` | hand a name over, sweep the account's cards on it, and list the subnames it ends                                                           |
| `planActivate(name)`                            | the reveal alone, for a registration whose commit landed without it                                                                        |
| `planRelease(name)` / `release(name)`           | end a registration, and get the bond and the gap value back                                                                                |
| `planRecords(name, records)` / `saveRecords(…)` | save or clear a name's records, carrying the subnames the card holds                                                                       |
| `planSweep(name?)` / `sweep(name?)`             | reclaim the cards this account left behind, paid for by the cards                                                                          |
| `submit(planned)`                               | sign and send a plan, and answer the transaction id                                                                                        |
| `resync()`                                      | forget the coins of submissions whose outcome was unknown, once the node settled                                                           |
| `deedOf(name)`                                  | the deed UTXO a name's owner holds, proven on the node. Refused while a transaction this registrar sent that spends it awaits confirmation |

Every call takes a final `{ signal }`, and every plan carries a `fee`. Every plan but the
registration's carries a `request` that you can hand a wallet directly. The registration carries
one on each half.

Under those calls are the parts that build them. A caller who assembles their own shape uses them
directly:

- `splitIntent`, `activateIntent`, `transferIntent` and `releaseIntent` build the protocol seats,
  the inputs and outputs a covenant pins, with no funding attached.
- `assemble` adds coins, the fee and the change.
- `selectFunding` picks the coins.
- `massOverrun` and `storageMassOf` say whether a node can carry the result.
- `classify` reads a node's rejection into a `Verdict`.
- `WrpcJson` with `nodeOver` is a node client for a JSON-RPC endpoint.

## Registering a name

```ts
const plan = await registrar.planRegistration('alice.k')
// show plan.tier, plan.fee and plan.locked, then:
const { commit, reveal } = await registrar.register('alice.k')
```

`plan.tier` is the registration fee, paid to the devfund, which `@dotk/sdk` quotes as
`quote(name).fee`. `plan.fee` is the network fee.

A registration is two transactions. The commit spends the gap that covers the name. A gap is the
registry's record of an empty stretch of keyspace, and every name is registered out of one. The
commit writes a PENDING deed that holds the bond and the deposit. The reveal spends that deed,
publishes the name, pays the tier and leaves the deed ACTIVE. The gap comes from the API. A client
with no API passes `{ gap }` itself, as the release section says of `{ neighbours }`.

Between the two, the name is reserved and the deposit is at risk. A PENDING deed that nobody
reveals is evicted after `t_evict`, and the deposit goes to whoever evicts it.

`planRegistration` builds both halves and measures both before either one is signed. This is not
a convenience. The commit's change funds the reveal. So a funding amount can leave the commit
relayable and put the reveal over KIP-9's storage floor, and nothing about the commit says so. If
you submit the commit first and build the reveal after, the commit is on chain by the time anyone
finds out.

For the same reason, the funding target carries headroom over the exact posting. `{ buffer }` sets
that headroom.

This package signs both halves before it sends the commit, so a refusal at the wallet costs a
prompt and not a name committed to and unrevealed.

The reveal carries no signature. Knowledge of the claim's preimage is its whole authorization. So
anyone who holds the name and the owner key can finish a registration that half-lands.
`planActivate(name)` is the door back in. The reveal is the `activate` entrypoint of the deed
covenant, which is where the method's name comes from. It finds the PENDING deed the commit left,
rebuilds the reveal on a fresh coin, and hands back a plan to submit. When the node refuses the reveal after the
commit lands, `register` names it.

## Ending a registration

```ts
const plan = await registrar.planRelease('alice.k')
// show plan.returned (the name bond and the gap value, less the fee), then:
const txid = await registrar.submit(plan)
```

A release is not a spend of the deed alone. The deed dies, and the two gaps that flanked it become
one. So the transaction takes the predecessor gap, the deed and the successor gap, and it writes a
single widened gap. Only the deed's seat is signed. The other two seats consent by being present.

Those neighbors have to come from somewhere. A gap's address hashes from its bounds, and nothing
in the name yields them. A node can therefore make sure that a pair is right, but it can never
find one. `planRelease` takes the pair from the API and proves each gap against the node before it
builds. A client with no API must pass `{ neighbours }` itself. This package tells such a client
so, and does not guess.

## Records

A name's records ride in a card, output 1 of the transfer that minted it, beside the deed
(`@dotk/sdk` reads them). To save records, this package builds a transfer to the owner the deed
already has:

```ts
const plan = await registrar.planRecords('alice.k', { url: 'https://alice.example', primary: true })
// plan.cards is what this transfer does to the card. The old one comes back, the new one goes out:
// { minted: true, swept: 1, value: 0n, carried: [], dropped: [], subnames: [], subnamesDropped: [],
//   cardRead: true, complete: true }
await registrar.submit(plan)

await registrar.saveRecords('alice.k', null) // clear them: sweep, mint nothing
```

A mint keeps what it cannot show, on a save and on a transfer with records alike. The live card's
opaque values are `{ opaque: '<hex>' }`. The ones under keys the given set does not name are
carried into the new card. `plan.cards.carried` and `plan.cards.dropped` list them by key, so a
signing surface can name them. A `sub:` entry is in neither list, because the two subname
listings below name it.

A set that comes out empty after the merge mints no card, as `saveRecords(name, null)` does. A
card holding the empty map pays `CARD_VALUE` for nothing.

`plan.cards.cardRead` says whether this package read the name's live card. It is true where an
API that knows the name lists no card, and where the node proves the card the API lists. It is
false in four cases:

- no API is configured
- the API does not know the name
- the node refutes the card
- this package cannot read the listing, or the node cannot answer for the card

The last case reaches a plan only where that plan mints no card. A records save throws on it,
because a save writes the card back. `plan.cards.complete` says the same about the set the caller
gave, so a transfer that merges no set leaves it true. A mint that follows a false here can drop
what nobody can read.

This package refuses a live card whose blob does not decode at all, and raises
`UndecodableCardError`. A save over such a card drops everything the card holds.
`saveRecords(name, null)` clears it on purpose. That refusal belongs to the records path. A
transfer that mints no card over the same card throws nothing, because it writes nothing back.

A card holds `CARD_VALUE` (0.5 KAS), and it is the spender's to take back. A transfer sweeps the
account's cards on the name by default, so their value returns with the change.
`planTransfer(name, to, { records })` mints the new owner's card in the same transaction, as its
output 1.

`{ sweep: false }` leaves the cards where they are. `planSweep(name?)` and `sweep(name?)` reclaim
whatever was left, paid for by the cards themselves. A sweep takes what the API lists for the
account's key (`Dotk.cardsOf`) and the node still holds. A client built with `api: null` can list
nothing, so it sweeps nothing.

`plan.cards.value` is what the cards move beyond the fee. When more comes back than goes out, that
value is negative. The signer signs a card sweep like an owner seat, by index, so it appears in
`ownerSigInputs`.

### Subnames

A `sub:<label>` record points a label at an address. `bob.alice.k` is the label `bob` on the card
of `alice.k`, and `@dotk/sdk` resolves it. The payee is the claim of the parent's owner, so a save
of the parent's records is the one thing that writes it.

A save carries every `sub:` entry of the live card the given set does not name, readable or not.
The set replaces one it names, and `dropSubnames` is the one way for a save to end one:

```ts
import { ownerOfParsed, parseAddress, subnameKey, subnameValue } from '@dotk/sdk'

const { ownerType, owner } = ownerOfParsed(parseAddress(payee, dotk.prefix))
const plan = await registrar.planRecords(
  'alice.k',
  { [subnameKey('bob')]: subnameValue(ownerType, owner) },
  { dropSubnames: ['pay'] }
)
plan.cards.subnames // [{ label: 'bob', address: 'kaspatest:qr…', change: 'added' }]
plan.cards.subnamesDropped // [{ label: 'pay', address: 'kaspatest:qq…' }]
```

Show `plan.cards.subnames` before the wallet signs. An added, a changed and a refused entry each
show in full, and the unchanged payees fold into a count. A refused entry carries `address: null`
and a `fault` tag, and it never folds, because a later reader can turn one into a payee.

A `sub:` value in the given set that this save adds or changes, and that the subname rules
refuse, throws `TxError`. `@dotk/sdk`'s README states the rules. Its `cause` is the `SubnameError` from `@dotk/sdk`, and that carries the `tag`.
A set that hands a counterparty's refused entry back unchanged saves, because the entry stays
where it is.

`mergeRecords(given, live, options?)` is the rule on its own, for a caller that builds the card
itself. `options.prefix` renders the payees, and a record set that holds a `sub:` entry without it
is refused.

`dropSubnames` names each label as the card stores it, so a client can remove a `sub:Bob` that no
lookup reaches. A drop writes back the set it read, so this package refuses one while nobody can
say what the live card carries. It refuses one without `records` too, and one on a transfer to
another owner, because both of those end every subname already.

Under the name `k` this package refuses a `sub:` entry a save adds or changes. A reader strips one
`.k` suffix, so no lookup reaches such an entry.

A transfer retires the card and every subname on it. Three plans end every subname the card
holds: a transfer that mints no card, which `saveRecords(name, null)` is one of, a transfer to
another owner, and a sweep. `plan.cards.subnamesDropped` names them with the payee each one paid,
except on a sweep, whose plan lists nothing. `planTransfer` reads the live card on every transfer,
so a seller reads that list before they sign. Without an API it lists nothing, because nothing
lists the card.

A transfer that retires a live card this account cannot sweep still plans, because moving the
deed ends that card. `saveRecords(name, null)` is how a holder ends a card somebody else seated.
The node has to prove the card first, so a listing the node refutes leaves nothing to do.

A transfer to another owner carries no `sub:` entry of the live card into the new owner's card.
That owner mints their own. `planTransfer(name, to, { records })` seats the `sub:` entries
`records` names and no other, and each one is `added`. A seller who reads the live set and hands
it back whole strips the `sub:` keys first, or the refused ones throw.

## What you supply

This package needs no wasm and no keys. It needs two things, and a wallet already has both.

### A node

A node gives coins, a feerate and a way to send. This package reads an outpoint and a value from
the node, never from the API. The API can say who owns a name. Only the chain can say which UTXO
that is and what it holds.

`nodesOver` above builds both halves from a wasm `RpcClient`, and `nodesOverWrpc(call, network)`
does the same for any transport where `call(method, params)` resolves. To take the write half on
its own, use `txNodeOverWasm` or `txNodeOverWrpc` from this package. The read half on its own is
`fromWasm`, `fromWrpcJson` or `fromGrpc` from `@dotk/sdk`.

This package's two take an optional network (`dotk.network`). The first transaction call then
makes sure that the node is on the chain the registry lives on. The read halves from `@dotk/sdk`
take no network.

If the client is replaced over time, pass `txNodeOverWasm` a function instead of the client. An
extension can tear its RPC down when idle and dial again. The function keeps this package from
holding a socket nobody will answer. Whichever one you use, it must be new enough to report covenant ids. If
it is not, a deed reads as an ordinary coin and the name as one nobody holds.

If you have no Kaspa client at all, there is one here over wRPC JSON, in plain TypeScript with no
dependencies:

```ts
import { WrpcJson, nodeOver } from '@dotk/sdk-tx'

const rpc = await WrpcJson.connect('ws://your-node:18210')
const node = nodeOver(rpc, dotk.network)
```

`connect` takes `{ timeoutMs, callTimeoutMs }` as its second argument: how long the socket can
take to open, and how long each call can take.

A node must start with `--rpclisten-json` to serve that encoding. The Borsh port most wallets use
will not answer it.

To write your own node client instead, implement three methods:

```ts
interface TxNode {
  utxosOf(address: string): Promise<SpendableUtxo[]>
  feerate(): Promise<number>
  submit(tx: Tx): Promise<string>
}
```

This package hands over the transaction itself, because how it goes on the wire belongs to the
transport. A wasm client takes the SDK's safe JSON (`toSafeJson`).
`submitTransaction` over wRPC takes an `RpcTransaction` (`toRpcTransaction`), which is a different
shape of the same thing.

### A signer

A signer is a wallet reduced to what a covenant spend needs. It must sign the named inputs by
index. It must not pick them out by their scripts. It must sign under SIGHASH_ALL, and it must
return the transaction otherwise unchanged. KasWare's `signPskt` and Kastle's `signTx` both do
this.

```ts
interface Signer {
  sign(request: SignRequest): Promise<string>
  supportsOwnerScheme(ownerType: number): boolean
}

interface SignRequest {
  txJson: string // the transaction, as JSON
  fundingInputs: number[] // indices paying to the account's own address
  ownerSigInputs: number[] // indices holding the name or a card, which pay to a script the wallet will not know
}
```

`ownerSigInputs` is why the signing must go by index. Those inputs pay to a P2SH address derived
from the name, or from a card's state. A wallet that matches inputs against its own addresses
finds nothing there, so it signs none of them.

`sign` answers the transaction as JSON, in the shape this package handed it. This package reads
`inputs[].signatureScript` from that answer and nothing else. Each signature is 65 bytes, which is
64 bytes of signature and then `0x01`, the sighash type. A funding input comes back as a single
66-byte push of that signature. An owner input comes back as the script it was given, with its 65
zero bytes overwritten in place. The length of that script does not change.

This package makes sure that every signature matches the assembled transaction before it sends
anything. A wallet that signs the wrong input, the wrong sighash type or nothing at all is caught
here, before the node ever sees it. This package never asks a wallet to build a transaction, never asks
it to broadcast one, and never asks it what a name is worth.

`SigningError` is the one that means this package cannot use the wallet's answer. The Errors
section at the end lists every class this package throws or lets through.

Every node call runs under `timeoutMs`, a `Registrar` option with a default of 20 seconds.
`planTransfer` and `submit` take a final `{ signal }` for a cancel button. This package applies
both itself and does not leave them to the node, which can ignore a signal. `null` waits for ever.

A node that cannot be reached raises `NodeError`. A deadline raises `@dotk/sdk`'s `TimeoutError`.
A cancellation reaches the caller as the reason the caller aborted with.

After a submission whose outcome is unknown, a socket that dropped, a timeout or a cancel
mid-flight, the coins it spent count as spent, so the next plan cannot offer them to a second
prompt. `registrar.resync()` forgets those coins and reads the wallet as the node reports it.
This package cannot see when the node's view has settled, so call it when you have reason to,
such as after the transaction shows up or after a minute has passed. The coins of a transaction the node took stay struck, because the
node lists them until it confirms.

A deed, a gap or a PENDING deed that one of this registrar's submissions spent is refused the same
way, until the node confirms that transaction, and `deedOf` refuses it too. A registrar remembers
what it spent for its lifetime. If the node dropped a transaction it took, a new `Registrar` reads
the wallet afresh.

## What it costs

`plan.fee` is the network fee in sompi. This package computes it the way the mempool prices a
transaction. It takes the larger of the compute mass and the normalized transient mass, at the
node's feerate. It floors that at the relay minimum and carries a 5% margin for signature-size
drift. A transfer moves nothing else, so the fee is the whole cost. With cards,
`plan.cards.value` is the rest, and you can recover it.

`FeeCeilingError` means the fee came out above 5 KAS. That 5 KAS is a rail and never a setting,
because the estimate the fee derives from arrives unvalidated from a node the user did not pick.
`InsufficientFundingError` names the shortfall.

A release frees the bond and a gap value, which is more than its fee, so the wallet's part is one
coin of any size. That coin signs the change output, and it is the one signature this package
counts for that, as the reference implementation counts it. With no coin at all,
`InsufficientFundingError` says that one coin is what is missing.

`MassCeilingError` means a node will not carry the transaction at all. KIP-9 prices an output at
`C / value`, so a remainder under about 0.02 KAS costs more mass than a whole transaction is
allowed. This package folds such a remainder into the fee rather than keeping it as change, up
to `FOLD_CEILING_SOMPI`, about 0.04 KAS, and `fee` shows it. So the error names a shape the fold
cannot mend: many inputs, several small outputs at once, or change past that ceiling. Another coin is the remedy, and the caller chooses it. This package selects
largest-first and does not widen the selection on its own.

Storage mass is priced into the mempool's ranking when the mempool is full, and not into the
relay floor the fee above clears. A refusal on that ground is `transient`, and the same bytes can
be sent again.

## When the node refuses

`SubmitError` carries a `verdict`:

| verdict     | what to do                                                                          |
| ----------- | ----------------------------------------------------------------------------------- |
| `transient` | retry, and only with the same bytes                                                 |
| `stale`     | rebuild against a fresh selection, which means a fresh signature and a new approval |
| `fatal`     | the node will refuse it again for the same reason                                   |
| `unknown`   | never a mempool verdict. `submit` hands such a failure back as the error it was     |

Only `transient` is safe to retry automatically. A `stale` retry needs the user to approve again,
so this package never takes it for them.

## What it will not do

A co-present input, and not a signature, approves a deed held under a script-hash or covenant-id
owner, and this version does not build that shape. It will not hand a name _to_ one either.
`activate` cannot mint those schemes, so a transfer is the only way into them. The recipient of
such a transfer holds a name no shipped tool can move again.

This package refuses a wallet that cannot sign the owner's scheme before it builds a transaction,
instead of at the prompt. A schnorr signature over an ECDSA-owned deed is a well-formed 65 bytes.
It fails only at consensus, after the user approves and the fee is paid.

Kastle signs schnorr only. On a Ledger account it refuses every covenant transaction, because they
are all version 1.

It will not leave a change output that no input signs, either. Signature scripts sit outside the
sighash, so nothing commits to such an output. Any party who can win the resulting txid conflict
rewrites where that output goes.

That shape is reachable, because not every registry transaction carries a signature of its own. A
`split`, an `activate` and an exit can all satisfy the covenants with none.

One `SIGHASH_ALL` input fixes every output in place. That input is a funding coin, or a card the
transfer sweeps, and a `Registrar` transfer always has one. The refusal is therefore aimed at a
caller who assembles around this package with `signedInputs` of their own. Such a caller has to
keep that duty themselves.

## How it is tested

The tests replay every derivation this package makes, case by case, against the reference
implementation's answers for the same deed, funding and feerate. Each case covers these items:

- The signature script, byte for byte.
- The fee, down to the size and both masses.
- The serialized body a wallet and a node parse.
- The transaction id.
- The digest a signature over each input commits to, in both flavors.

The same cases run again for a transfer that carries cards and for an exit merge.

A registration is replayed as the pair it is, with each half built on the other. Those cases cover
the signature scripts, the outputs, what each half must be funded by and what each one costs.
Alongside them come the fee table, the rejection taxonomy, KIP-9's storage mass and the script an
address pays to.

There is no second implementation of the covenant rules here. There is only a second
implementation of the encoding. The tests exist so the two can only agree or fail.

This package makes sure that a signature the wallet returns matches the digest it must commit to,
under the flavor the owner's scheme names. It does so before it adopts the signature. A signature
of the right shape over the wrong transaction passes every other test there is. So does a
signature of the wrong flavor.

All of that is agreement with a model, which is necessary and is not sufficient. A model and its
copy can be wrong together about something consensus enforces. `tests/live.test.ts` settles it
against a real node.

The live test registers a fresh name, hands it to a second key and releases it. Separately it
moves a name out and back with a card riding along. At each step it makes sure that the id the
node answers with is the one this package computed before signing. It also makes sure that the
deed appears, moves and finally disappears at the places this package derived.

The live test reaches the node over wRPC JSON in plain TypeScript, so there is no WebAssembly in
the test either. `AGENTS.md` says how to run it.

## Errors

Everything this package throws extends `DotkError` from `@dotk/sdk`, given input of the types its
signatures declare. Its own classes, the first
seven rows, extend `TxError`. The read client's own classes reach you unchanged, and a `catch` of
`TxError` does not cover them, so a `catch` of `DotkError` is the one that covers everything.

| Error                      | When                                                                                                                                                                               |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TxError`                  | this package refuses to build, sign or send: the base class of the rest but `NodeError`                                                                                            |
| `InsufficientFundingError` | the wallet holds too little for what the transaction moves plus its fee, or no coin at all where the value freed pays the fee and the change needs one of any size. `have`, `need` |
| `FeeCeilingError`          | the fee came out above `MAX_FEE_SOMPI`, 5 KAS                                                                                                                                      |
| `MassCeilingError`         | a node will not carry the transaction, over one of the three mass caps. `dimension`                                                                                                |
| `SigningError`             | the wallet's answer is not one this package can use                                                                                                                                |
| `SubmitError`              | the node refused the transaction. `verdict` says whether a retry can help                                                                                                          |
| `UndecodableCardError`     | a live card's blob is not a record set, and a save would wipe what it cannot read                                                                                                  |
| `NodeError`                | `@dotk/sdk`'s: the node could not be reached, or refused the call before it had an opinion                                                                                         |
| `TimeoutError`             | `@dotk/sdk`'s: a call outlived `timeoutMs`                                                                                                                                         |
| `InvalidNameError`         | `@dotk/sdk`'s: the name cannot be one the registry holds                                                                                                                           |
| `SubnameError`             | `@dotk/sdk`'s: a `sub:` entry or a subname input the rules refuse. `tag` says which                                                                                                |
| `ConfigError`              | `@dotk/sdk`'s: the client was built without what the call needs, such as an API                                                                                                    |
| `InvalidAddressError`      | `@dotk/sdk`'s: not an address, or not one on this network                                                                                                                          |
| `CardError`                | `@dotk/sdk`'s: a record value no card can carry, such as an opaque value that is not hex                                                                                           |
| `ApiError`                 | `@dotk/sdk`'s: the API refused or answered something unusable, on a call that asks it                                                                                              |

`@dotk/sdk`'s own refusals reach you unchanged, and a cancellation reaches you as the reason you
aborted with.
