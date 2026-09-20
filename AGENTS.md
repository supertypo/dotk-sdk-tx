# Contributor notes for @dotk/sdk-tx

This is the write half of the dotk TypeScript client, published as `@dotk/sdk-tx`. It builds,
signs and submits the transactions that register, transfer and release `.k` names on Kaspa. This
file holds the workflow and the rules that a change must not break. It does not explain the
package. [README.md](README.md) does that, for integrators.

This repository builds and tests standing alone. The maintainers also clone it inside a
workspace of their own, and that workspace holds the reference implementation, the generator of
the corpus under `tests/generated/`, and the glossary this package's words come from. A
contributor outside it receives the corpus as a reviewed file of this repository and cannot
refresh it. A change that needs it refreshed says so in its pull request, and a maintainer runs
the generator.

One topic, one place. Describe only the current state. Never write "used to", "no longer", or
change history, in documentation or in code comments.

## The read half is a dependency

`@dotk/sdk` carries the deployment that this package was built with. Everything else is derived
here: the intent's pinned seats, the signature script under silverscript's ABI encoding, coin
selection, and the fee. README.md says what an integrator supplies.

`@dotk/sdk` comes from the npm registry, by the version range in `package.json`. It is a peer
dependency and a dev dependency besides, at the same range. A nested second copy breaks both
`instanceof DotkError` and the `Dotk` that a `Registrar` is handed.

To work against an unpublished `@dotk/sdk`, build the sibling clone and install it from its
directory. That symlinks it and leaves the lockfile alone:

```bash
(cd ../sdk && npm run build) && npm install --no-save ../sdk
```

Once a matching `@dotk/sdk` is on the registry, the next `npm install` here replaces the link
with the registry copy. Until then a plain install fails and the link stands. A change that needs
an unpublished `@dotk/sdk` waits for that package to be published, and says so in
`CHANGELOG.md`.

## The corpus is committed

`tests/generated/<network>/vectors.json` is the corpus, the conformance test vectors the
reference implementation computes, one per registry `@dotk/sdk` can address. `@dotk/sdk` carries
the same file. This repository commits the corpus so that a clone of it alone runs the suite with
no Rust toolchain.

Never edit the corpus by hand. The generator runs again whenever a derivation or a deployment
manifest moves, and what changed is committed here.

The corpus pins everything in this package that restates the reference implementation, because
none of it has an error signal short of a node rejection. README.md says what is covered, and
`tests/vectors.ts` declares the sections this package replays. A change to either side without a
regenerated corpus is a change that nothing checks.

## Rules the code keeps

An integrator sees the word "api", never "indexer". The API's names are canonical: an identifier
that mirrors a wire field or a schema keeps the API's spelling, `neighbours` included, whatever
the prose rule says, because the API is a served contract and cannot change for this package.
Every option that they can set lives in an options object. A new capability is a new method or a
new optional field, never a changed signature.

### Money

- `MAX_FEE_SOMPI` is a rail and never a setting. `assemble` refuses a transaction that pays more.
- Every wallet signature is verified against the digest it must commit to, in the owner scheme's
  flavor, before it is adopted. A signature is never merely counted.
- No plan leaves an output that no input signs. A signature script sits outside the sighash, so
  such an output is a bearer value.
- Every intent pins the protocol value it spends: the bond of an ACTIVE deed, the bond and the
  deposit of a PENDING one, the gap value of a gap.
- A registration refuses an owner nothing can spend, on both halves, before the posting.

### Subnames

A save carries every `sub:` entry the given set does not name, readable or refused. It refuses an
entry it adds or changes that the subname rules refuse, and one under the parent `k`, which no
reader reaches.

### The three hasher conventions are not interchangeable

blake2b takes the domain string as its key verbatim. blake3 takes the same string zero-padded
into a 32-byte key. The ECDSA sighash is a plain sha256 preloaded with sha256 of its domain
string. The wrong one yields a digest that is well formed and means nothing.

### A wallet gets empty funding signature scripts

This package hands a wallet a transaction whose funding signature scripts are empty. It measures
the mass on a clone. That clone stands a 66-byte placeholder in for each script. A measurement of
the body itself under-counts by exactly the signatures that the body does not yet carry.

### The node transport is a wRPC JSON client

This package reaches the node over `src/wrpc.ts`, a shipped wRPC JSON client. JSON is the only
encoding worth a hand-written client. Borsh is what every wallet uses, and it is the wrong target
here. Its methods travel as numeric ids, and every message type carries its own version
prologue. None of that has a second implementation in the corpus.

README.md describes the two transaction shapes. `transferAssembly`'s `safeJson` and `rpcJson`
pin both.

### Storage mass is absent from the fee model

It is absent here exactly as it is absent from the reference implementation's model. Storage mass
is contextual. The fee iteration cannot see it. A transaction that a node refuses for it is
`Fatal`.

## Writing style

Documentation, code comments and user-facing strings follow the same rules. Prose that reads as
machine-written is a defect like any other. The rules below come from ASD-STE100, the controlled
English that aerospace writes its procedures in.

- Keep a sentence that tells the reader what to do under 20 words, and one that explains under 25.
  One instruction per sentence.
- Use simple tenses and the active voice. Write "the client sends", never "has sent" and never
  "is sent". Name the actor.
- Use only the modals can, will and must. A required "should" becomes "must". An optional one is
  deleted.
- Put a condition before its command, divided by a comma: "If the build fails, read the log."
- Write no semicolons and no em-dashes. Write two sentences, or name the relation with "because",
  "but" or "so".
- Keep complete grammar. No contractions, keep the articles, keep "that".
- One word, one meaning, for a whole file. Write `make sure that` for check, verify, confirm and
  ensure. Write `configuration` for config, settings and options.
- Break a noun chain longer than three words with a preposition.
- Define a concept term where it first appears, in under ten words. Do not define a product name,
  a standard name or the thing the file is about.
- State the fact, not its importance. Delete simply, seamlessly, robust, powerful, comprehensive,
  leverage, crucial, "in order to" and "it is worth noting".
- Use no bold lead-ins, no bold for emphasis and no emoji. A vertical list is for three or more
  parallel items.
- Capitals are for identifiers, never for emphasis. Protocol constants (`PENDING`, `ACTIVE`),
  acronyms and code names keep their case.
- Say a thing once, and vary the phrasing. A stock phrase repeated until it is a tic reads as
  filler.
- A contrast has to earn its negation. "X, not Y" is precise where Y is a real alternative that a
  reader assumes otherwise, and filler where it is not.
- Use one spelling per term, everywhere, and American spelling throughout. The covenant id is
  never abbreviated: "covenant id" in prose, `covenantId` in JSON.

### Comment shape

The rules above govern words. These govern what a comment is for and what it can point at.

- A comment states the fact and stops. Never add a sentence whose only job is to tell the reader
  that the fact matters. Where the consequence is not obvious, put it in the same sentence as the
  fact.
- Write nothing the signature already says. A comment that reads back the field names under it
  is a comment to delete.
- Write the shortest form that carries the fact. Three paragraphs over a forty-line file is a
  defect even where every sentence is true.
- Do not end a paragraph with a short fragment for rhythm.
- Do not count for effect. "Three exclusions apply" goes stale on the fourth, and the list under
  it already says how many there are.
- Write what the code does, not what the code wants. A wallet returns an altered output. It does
  not lie.
- Never name a closed-source project of this family, and never name a file, a path, a crate or a
  command inside one. That covers the parent workspace, the web app and the wasm bundle. Where a
  rule lives in one of them, state the rule here instead of pointing at it.
- An open-source project is fine to name, and naming one is usually more precise than not.
  `kaspanet/rusty-kaspa` and its crates, silverscript, Rust itself, a third-party wallet and a
  standard that defines a wire format (KIP-9, KIP-20, KCC-1, KCC-2, ENSIP-5, RFC 8949) all
  qualify, and so does a sibling package on npm.
- Never write history. No "used to", no "no longer", no "previously", and no note about what a
  change replaced or why the old way was wrong. A comment and a document describe the current
  state alone. `CHANGELOG.md` records what changed for an integrator, and a commit message
  records it for a contributor. Those two are the only places.

## Implementation workflow

1. Run `git pull` first, before you write anything. The remote can hold work from another machine
   or session. If you find that out at push time, you must do a needless merge.
2. Implement the change, with tests. If a change can regress behavior, write the regression test
   first. A change to a derivation starts in the reference implementation, then a regenerated
   corpus, then the TypeScript that replays it. A contributor without the generator writes the
   TypeScript and says in the pull request that the corpus needs regenerating.
3. Run the five, from the repository root. `npm ci` is the whole of the setup, with no Rust and
   no wasm. While the `@dotk/sdk` range names a version the registry does not carry, `npm ci`
   cannot resolve it, and the `--no-save ../sdk` recipe above is the bootstrap instead.

```bash
npm run lint && npm run typecheck && npm run format:check && npm test && npm run build
```

4. Update the documentation that the change touches. Write what an integrator can see under a
   `## <next version>` heading in `CHANGELOG.md`.
5. Commit with a short message, directly on `main`. A mechanical reformat is its own commit, after
   the functional one.
6. Run `git push`. Never leave finished work as local-only commits.

CI runs the five on every push and pull request, under `.github/workflows/ci.yml`. It runs them
after the fact, so the sequence above still runs before a push. The package is in production.
This repository commits its own `package-lock.json`.

## The live tests

README.md says why `tests/live.test.ts` exists. It runs only when `DOTK_LIVE_NODE` names a node
started with `--rpclisten-json`:

```bash
DOTK_LIVE_NETWORK=testnet-10 DOTK_LIVE_NODE=ws://your-node:18210 DOTK_LIVE_API=https://api-tn10.dotk.name npm test
```

When `DOTK_LIVE_NETWORK` is unset, the registry is testnet-10, because this test spends. Mainnet
runs only where the variable names it. The test reads two funded keys from
`~/.dotk/<network>/wallet.key` and `wallet2.key`, never from the checkout. `DOTK_LIVE_NAME` names
a name that the first key owns, `sdktest` by default. The registration case makes its own name and
releases it, so it leaves the registry as it found it.

### A third party's signer

A third party's signer agrees with the reference implementation the same way, and a test proves
that instead of assuming it. `tests/interop/kaspire.test.ts` drives a real transfer through Kaspire's own Rust
core, compiled to wasm. It then makes sure that `applySignatures` accepts the covenant seat it
signed. That is the whole feasibility question behind a Kaspire wallet integration, because
Kaspire's `kaspa_signPskt` runs that same `sign_pskt`.

The test runs only when `KASPIRE_WASM` names the wasm-bindgen `kaspa_secure_core.cjs`. The file
header says how to build one, and the 6.6 MB binary is deliberately not vendored. Any wallet whose
signer is available this way earns the same test rather than a reasoned claim that it
interoperates. `tests/interop/kaspire-register.test.ts` proves the registration shape the same
way.

## Releasing

Release after `@dotk/sdk`, where the change needs it. First run `git pull`. Then get the five
green with the `@dotk/sdk` that the range resolves to from the registry, not a link. Nothing
packed here is generated, so this package has no release gate beyond the build, and it packs from
any clone. Then:

```bash
npm version <new> --no-git-tag-version
npm publish
```

`files` packs `CHANGELOG.md`, so a bump with no entry under `## <new>` ships a stale record.
`prepack` builds, so a tarball never carries a stale `dist` or none at all. A major on `@dotk/sdk`
moves both ranges in `package.json` here, `peerDependencies` and `devDependencies`. If one range
stays behind, an install resolves a nested second copy. Commit the bump and push.
