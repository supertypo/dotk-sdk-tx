# Changelog

The record starts at 1.2.0.

## 2.0.0

- The write half's node adapters have their own names: `txNodeOverWasm` for `fromWasm` and
  `txNodeOverWrpc` for `fromWrpcJson`, with `TxWasmRpcClient` and `TxWasmUtxoEntryReference` for
  the client types. `@dotk/sdk` exports the read adapters under the old names with other shapes,
  so a wallet that installs both packages now imports both without aliasing. `nodesOver`,
  `nodesOverWrpc` and `nodeOver` are unchanged.
- `WrpcJson.connect(url, options?)` takes its two deadlines in an options object, `timeoutMs`
  for the socket to open and `callTimeoutMs` for each call, as every option of this package is
  taken. `DEFAULT_CONNECT_TIMEOUT_MS` is the first one's default.
- A plan refuses a deed, a gap or a PENDING deed that one of this registrar's own submissions
  spends, until the node confirms that transaction. The message says to wait. A seat of a
  submission whose outcome is unknown is not refused, so `planActivate` still finishes a
  registration whose reveal failed with no verdict. `deedOf` refuses such a deed too.
- A transaction whose seats free more than they post, which a release does by its bond and a
  gap value, pays its fee from that value before the wallet does. The wallet's part is then one
  coin of any size, which signs the change output, so a release costs one input whatever the
  wallet's coins are. A wallet with no coin at all is refused with `InsufficientFundingError`,
  and the message says that one coin of any size is what is missing. `assemble` refuses a
  `signedInputs` index that names no input carrying a signature placeholder. A key, an owner, a
  gap bound, a card field or a script that is not the hex it must be is refused as a `TxError`
  naming the field, on every intent, every plan and every send, where it was a bare `TypeError`.
- A registration refuses an owner nothing can spend, on both halves, as a transfer does: a
  script hash, a covenant id, a zero payload, or a key off the curve. Each posted bond and
  deposit into a deed that `activate` could never spend. `activateIntent` also refuses a PENDING
  deed that does not hold bond plus deposit, since the funding is computed from that figure.
- `submit` hands back what happened. A socket that dropped or a call that timed out is a
  `NodeError`, the caller's own cancel is the reason they aborted with, and `SubmitError` names a
  mempool verdict alone, with the node's error as its `cause`. The coins of a submission whose
  outcome is unknown count as spent until a resync, so a second prompt cannot spend them.
- `Registrar.resync()` forgets the coins of submissions whose outcome was unknown, once the
  node's view has settled. The coins of a transaction the node took stay struck.
- A registration refuses a name the deed covenant refuses before the commit, as the reference
  does, so no posting lands that no reveal can spend.
- The storage fold turns change into fee only up to `FOLD_CEILING_SOMPI`, about 0.04 KAS.
  Change past it that would overrun the storage cap is refused with `MassCeilingError`, and
  another coin is the remedy.
- `NodeError` is `@dotk/sdk`'s own class, so a `catch` of that class covers both halves. It no
  longer extends `TxError`.
- `DUST_SOMPI` is 2 000 000 sompi, the value under which KIP-9 refuses an output on its own,
  and change that would overrun the storage cap beside the other outputs folds into the fee the
  same way. A plan whose change lands there pays it as fee, shows it in `fee`, and stays under
  the ceiling, where it was refused with `MassCeilingError`.
- `assembleSweep` applies the same mass rail as `assemble`, so a sweep of many cards refuses
  before signing, and its `changeIndex` is -1, since its one output is the destination.
  `withCards` refuses a mint on a transaction that spends more than the one deed input.
- A wallet's answer that is not the shape asked for is a `SigningError` naming the part, and the
  altered-script diagnostic compares whole scripts. `SignedBody` and `RpcTransaction` are
  exported, and `toRpcTransaction` answers the latter. `changeScriptPublicKey` must be hex. A
  wRPC call abandoned by its timeout drops its abort listener.
- `package.json` is exported for tooling that reads it.
- `DEFAULT_CALL_TIMEOUT_MS` is exported, the deadline `WrpcJson.connect` uses when none is
  given. Every optional property on an answer or an option is spelled `?: T | undefined`, so a
  value read off one forwards into another under `exactOptionalPropertyTypes`. The package ships
  no source maps, as `@dotk/sdk` ships none.
- `MassOverrun.mass` and `MassCeilingError.mass` change type to `bigint | null`. A caller that
  reads either one must handle a null. A storage mass that the KIP-9 formula declines to price
  was reported as `0`. That read as a transaction over the limit by nothing at all. The value now
  says that no figure exists.
- `Registrar.planActivate(name)` finishes a registration whose commit landed and whose reveal did
  not. It finds the PENDING deed on the node, rebuilds the reveal on a fresh coin, and answers a
  plan for `submit`. `register` names it after the node refuses the reveal.
- `register` takes both signatures before it sends the commit. A refusal at the wallet then leaves
  the name free, rather than committed to and unrevealed.
- A cancellation reaches the caller as the reason they aborted with, whatever it is.
  `abort(new Error('cancelled'))` and `abort('x')` came back as `NodeError`.
- The gap probes behind `planRelease` and `planRegistration` run under `timeoutMs`. They raise
  `NodeError` on a transport failure, as every other node call here does.
- `RegisterOptions`, `RegistrationPlanned`, `ActivationPlanned` and `TransferPlan` are exported.
- `mergeRecords(given, live, options?)` applies the writer's rule to a card's `sub:` entries, the
  subnames of dotk.name. A save carries every entry the given set does not name, readable or
  refused. It refuses an entry the save adds or changes that the three rules refuse. That
  refusal is a `TxError` whose `cause` is the `SubnameError` carrying the fault tag.
- `mergeRecords` answers `subnames` and `subnamesDropped` besides. `MergedRecords` and
  `MergeOptions` name the two shapes. The third argument is new and optional, so the two-argument
  call of 1.2.0 stands. `options.prefix` renders every payee. Without it, a record set that holds
  a `sub:` entry is refused, because nothing else says what network a payee is on.
- `TransferPlanned.cards` gains `subnames` and `subnamesDropped`. Show them before the wallet
  signs. An added, a changed and a refused entry each show in full, and the unchanged payees fold
  into a count. `PlannedSubname` and `DroppedSubname` are exported.
- `planTransfer`, `transfer`, `planRecords` and `saveRecords` take `dropSubnames`, the labels this
  save removes, as the card stores them. A drop writes back the set it read, so it is refused
  while nobody can say what the live card carries. `RecordsOptions` is exported.
- `planTransfer` reads the name's live card on every transfer, at one API call and one node probe.
  A transfer that mints no card ends every subname the card holds, and `cards.subnamesDropped`
  lists them.
- A transfer to another owner carries no `sub:` entry of the live card into the new owner's card.
  That transfer retires the card and every subname on it, so the new owner's card seats the
  entries the given set names and no other. `cards.subnamesDropped` lists every entry that ends.
- `TransferPlanned.cards.cardRead` says whether this registrar read the name's live card.
  `cards.complete` keeps its meaning, which is about the set the caller gave. A transfer that
  mints no card plans through an API fault and a node fault alike, and lists no subname.
- A record set that comes out of the merge empty mints no card, as `planRecords(name, null)` does.
- `transferIntent` refuses a transfer that moves no deed and touches no card, and the message
  now reads off the plan rather than off the owner of the deed. That refusal is narrower than
  1.2.0's. `CardPlan` gains `retires`, which says that this transfer ends a live card it cannot
  sweep. 1.2.0 refused `planRecords(name, null)` over a card somebody else seated, and 2.0.0
  plans it, because moving the deed ends that card. The node has to prove the card first.
- `planTransfer` and `planRecords` refuse a `sub:` entry they add or change under the name `k`. A
  reader strips one `.k` suffix, so no lookup reaches such an entry.
- `validateOwner` takes its tests from `checkPayload` in `@dotk/sdk`. Its message now names the
  fault, `the new owner is refused: the payload is 32 zero bytes`.
- Requires `@dotk/sdk` 2.0.0, because it calls exports only that version has.

## 1.2.0

- `planRecords`, `saveRecords` and `planTransfer` with records keep the live card's opaque values
  under keys the given set does not name. They report `plan.cards.carried`, `plan.cards.dropped`
  and `plan.cards.complete`. A live card whose blob does not decode is refused with
  `UndecodableCardError`. You can still clear a card. `mergeRecords` is exported. Requires
  `@dotk/sdk` 1.2.0.
