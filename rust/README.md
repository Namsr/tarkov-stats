# Rust extraction

Rust code extracted from the Node/TypeScript application, one piece at a time.
Each piece is a standalone binary that a Node script can invoke as a child
process, so nothing here changes the runtime architecture and any stage can be
reverted by reverting one commit.

Crate interface documentation lives in each crate's own README. This file records
the staging decisions and the measurements behind them.

## Rule: place the boundary where the data collapses

A Rust process boundary pays only when the **output volume is much smaller than
the input volume**. The cost of the boundary is the record stream crossing the
pipe and being read back into Node. If that stream is comparable to or larger
than the input, the boundary costs more than the faster computation saves, no
matter how much faster the computation is.

Place the boundary where the data collapses, not where per-item transformation
happens.

## Stage 1 — `tarkovstats-feed`

**Status: shipped, deliberately not wired in. This is the only PR planned for it.**

The crate is a byte-level streaming lexer for the Tarkov "updated" feed, ported
from `createTimestampObjectParser` in `scripts/regular-profile-sync-core.mjs`. It
is byte-exact with the original and fully tested. Nothing in the Node codebase
calls it.

The two follow-up commits originally planned for this stage — switch the systemd
unit to the binary, then delete the TypeScript — are **cancelled**. Wiring it in
would make the collectors slower.

### Measured outcome

Same machine, same session, the real 68.58 MiB feed, 2 970 147 entries.

| Path | Time | Throughput |
|---|---|---|
| Original parser, parse only | 1 899–1 956 ms | 35 MiB/s |
| Rust binary, lexing only, through a pipe | 165–171 ms | 403 MiB/s |
| Node reading the 88.41 MiB record stream | 1 727–2 245 ms | — |
| Node applying `JSON.parse`/`Number` to 2.97 M records | 5.5–9.5 ms | — |
| **Rust binary + Node reader, end to end** | **2 463–3 680 ms** | 18.6–27.9 MiB/s |

The lexer is **11.4x faster**. End to end the port runs at **0.74x, 0.99x and
0.87x** of the original across three runs.

The record stream is **1.289x the input size**. Pulling 88.41 MiB through a pipe
into Node costs more than the 10x parse difference saves. No framing choice
recovers this: an f64 value format shrinks the stream to 15.4 MiB, but only by
moving `StringToNumber` and the IEEE rounding rules into Rust, which trades an
exactness problem for a reimplementation problem and gives up the `JSON.parse`
fidelity that makes the port bit-exact in the first place.

This is the worst possible case for the rule above, and it is why the boundary
was measured before any wiring was written.

The one real gain is memory, ~250 MB down to ~20 MB, and only if the readers are
genuinely streaming instead of buffering the body.

### Verification

- The real 68.58 MiB feed matches the original exactly: entry count, first key,
  first value, last key, and `sha256` of the `key:value` stream —
  `ea40b07c34b74fa473bf5db9d34da1d2a0225afc8798835d0a829a02a8291ebd`.
- ~212 000 distinct input documents compared against the unmodified
  `createTimestampObjectParser`: 153 curated, 7 500 randomized, 107 799
  exhaustive, plus chunk-plan sweeps over 29 documents at every single cut point.
- 116 Rust tests. `cargo clippy --all-targets` clean with `forbid(unsafe_code)`,
  `missing_docs`, `clippy::pedantic` and `rust_2018_idioms` forced on all six
  targets.
- Zero third-party crates. `cargo tree` prints only the workspace member.

### Accepted deviation

A document that is malformed in a key token **and** in a separate place reports a
different message. `{"\q":2}` matches exactly, because the record is emitted and
V8 raises the identical error on the key token. `{"\q";2}` does not: the original
calls `JSON.parse` on the key in the `key` state, before it looks at the colon or
the value, whereas the port cannot emit a record until the value is present, so it
reports `expected ':' after account id`.

Characterized independently: the two diverge only when both conditions hold — the
original's first throwing event is a `JSON.parse` failure on a malformed key, and
the port raises a structural error before that record is emitted. A predictor for
those two conditions had 0 mispredictions over 100 000 random documents and
107 799 exhaustive ones. No single-defect document diverges, 0 of roughly 82 000.

Nothing but the message text changes. Acceptance, exit code and dispatched entry
count match in every divergent case, and both sides always throw. The one visible
consequence is the error *name* in the warmup wrapper, which embeds
`${lastError.name}: ${lastError.message}`: a two-defect document logs
`Error: expected ':' after account id` where the original logged
`SyntaxError: Bad escaped character…`. Both are non-retryable in the same way.

Accepted as-is. The original's ordering is an accident of where `readString`
happens to call `JSON.parse`, not a specification, and a document malformed in two
places has no correct "first" error.

## Planned stages

- **Stage 2 — leaderboard materialization.** `lib/leaderboard/materialize.ts` and
  `ranking.ts` are per-row formula and ordering over ~100k source rows, writing
  one aggregate table. The output collapses hard, so this is the shape where the
  boundary can pay. Note that the `ordinalMs` cost in
  `lib/leaderboard/publication.ts` is SQLite query time, not computation, and is
  not addressed by a Rust port — it is a separate SQL problem.
- **Stage 3 — average computation.** `lib/average-compute.ts`, same shape.

Re-measure the boundary before wiring any of them. Stage 1's number is the
reason that is a step and not a formality.

## Building

The crate is not part of the Docker image and no Node script invokes it, so the
image needs no Rust toolchain. To build locally:

```console
$ cargo test --manifest-path rust/Cargo.toml
$ cargo clippy --manifest-path rust/Cargo.toml --all-targets
$ cargo build --release --manifest-path rust/Cargo.toml
```

The local development toolchain is whatever `rustup` selects by default. The
project's `rust-version` is 1.74, matching the oldest edition the crate claims to
support.
