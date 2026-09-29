# tarkovstats-feed

A byte-level streaming lexer for the Tarkov "updated" feed, ported from
`createTimestampObjectParser` in `scripts/regular-profile-sync-core.mjs`.

**Nothing calls it yet.** It is byte-exact and fully tested, but it is not wired
into any collector and is not built into the Docker image. The measurements and
the reason are in [`../README.md`](../README.md) — in short, the pipe back into
Node costs more than the 11.4x faster lexing saves.

**It is a lexer, not a value parser.** It carries raw source tokens. Every
JSON and numeric semantic stays in V8: the binary never calls `JSON.parse`,
never calls `Number`, and never validates the contents of a string token. The
Node reader applies the same two calls to the same bytes it always did, so the
values, the `SyntaxError` messages and the token-relative positions are
unchanged.

Zero dependencies. Standard library only, because the input is untrusted
upstream bytes and the dependency surface is meant to stay at zero.

## The grammar

```
document    := ws '{' ws entry-list ws trailing-comma? ws '}' ws*
entry       := string ws ':' ws value
entry-list  := empty | entry ( ws ',' ws entry )*
value       := number-token | string
number-token:= '-'? [0-9]+ ( '.' [0-9]+ )? ( [eE] [+-]? [0-9]+ )?
```

Deliberate deviations from JSON, all preserved from the original: a trailing
comma is accepted, leading zeros are accepted, there is no range or finiteness
check, duplicate keys are emitted in full and in document order, and keys are
never validated as numeric.

## Usage

```console
$ curl -s https://example/updated | tarkovstats-feed > records.bin
$ tarkovstats-feed --format=text < feed.json
{"15":1755979243867}
{"42":"1720000001"}
```

- **stdin** — the raw response bytes, concatenated, no framing, no
  transformation, no terminator. EOF is the end of the input. The body is never
  decoded.
- **stdout** — a bare record stream. No header, no footer, no count. EOF plus
  exit 0 is the terminator.

### Record framing (`--format=binary`, the default)

```
record := kind       : u8             0x4e 'N' numeric, 0x53 'S' string
       | key_len    : u32 little-endian
       | key_bytes  : key_len bytes, verbatim from stdin
       | value_len  : u32 little-endian
       | value_bytes: value_len bytes, verbatim from stdin
```

`key_bytes` is the key string token **including both double quotes**, escapes
unprocessed. `value_bytes` is the numeric token as written for `'N'`
(`007`, `1E+5`, `1e400`) and the string token including its quotes for `'S'`.

The reader:

```js
const key = JSON.parse(buf.utf8Slice(o, o + keyLen));
const value = kind === 0x4e ? Number(buf.utf8Slice(o, o + valueLen))
                            : JSON.parse(buf.utf8Slice(o, o + valueLen));
```

Length prefixes keep the framing unambiguous when a token contains a raw
`TAB`, `LF` or `CR`, which a malformed token can and must: those bytes have to
reach `JSON.parse` rather than be pre-rejected here.

### Record framing (`--format=text`)

One line per record, the two raw tokens as written, for debugging. Same
records, same order, same emission path, still undecoded.

## Exit codes

| exit | stderr | shim action |
|---|---|---|
| 0 | empty | success |
| 1 | a usage message | `throw new Error(...)`, fatal, never retried |
| 2 | the exact parser message, then `\n` | `throw new Error(stderr.replace(/\n$/, ""))` |
| 3 | a short I/O description | `throw new Error(...)`, fatal, never retried |

On exit 2 every record completed before the failure has already been flushed
and no partial record has been written, so the entries the Node side has
dispatched are exactly the entries the original `onEntry` would have received.

The seven messages are the originals, verbatim:

| message | trigger |
|---|---|
| `updated JSON must be an object` | first non-whitespace code unit is not `{` |
| `expected JSON string` | in the `key` state the unit is neither `"` nor `}` |
| `expected ':' after account id` | in the `colon` state the unit is not `:` |
| `expected numeric timestamp` | not `"`, and the number pattern does not match |
| `expected ',' or '}' after timestamp` | after a complete value the unit is neither `,` nor `}` |
| `truncated or invalid updated JSON` | the `final` whole-state check failed |
| `unexpected data after JSON object` | non-whitespace remains after `}` |

## Whitespace

The full ECMAScript `\s` set, not the six ASCII bytes. `U+00A0`, `U+1680`,
`U+2000`–`U+200A`, `U+2028`, `U+2029`, `U+202F`, `U+205F`, `U+3000` and
`U+FEFF` are all accepted; `U+200B`, `U+0085` and `U+180E` are not. A
byte-oriented `skip_whitespace` that only skips `09 0A 0B 0C 0D 20` rejects
documents the original accepts, and the existing Node test suite does not
notice. See `src/whitespace.rs` for the byte table.

### A member split across a read boundary

The original is fed decoded text, so `TextDecoder({ stream: true })` **holds a
partial sequence** across a chunk boundary and its buffer never contains half a
character. A byte port has no decoder in front of it, so its buffer can end in
the middle of one — at a 64 KiB read boundary, or anywhere a caller chooses to
split.

Reporting that as "not whitespace" makes the port reject documents the original
accepts. `{` + 65 534 spaces + `U+00A0` + `"1":2}` has its `U+00A0` split by the
first read: the original sees nothing, waits for the next chunk, and parses the
document. So the scanner has three answers, not two:

| answer | meaning |
|---|---|
| `Run(n)` | a complete member, skip `n` bytes |
| `Partial(n)` | a proper prefix of a member running to the end of the buffer: wait for the rest |
| `None` | not whitespace, and no continuation could make it so |

`Partial` only applies to prefixes of **included** members, so the three
exclusions keep rejecting at every split. `U+200B` and `U+0085` wait on their
ambiguous first bytes, because those bytes really could complete an included
member, and reject on the byte that settles them. `U+180E` starts `E1 A0`, which
no member starts, so it rejects immediately without waiting.

At the end of the body the wait is suppressed: an incomplete trailing sequence
is not whitespace, which is the `U+FFFD` the decoder would have flushed.

## Long tokens

One unterminated string token spanning the whole body is scanned once, in
linear time. `readString` in the original restarts at the opening quote on every
call, which is fine at 1 MiB chunk sizes and quadratic at 64 KiB read sizes, so
the port carries a resume cursor across chunks. Measured on one machine, before
and after:

| input | before | after |
|---|---|---|
| 16 MiB | 0.80 s | 0.02 s |
| 64 MiB | 14.34 s | 0.07 s |
| 128 MiB | 66.96 s | 0.14 s |

`tests/fuzz.rs` enforces this with a timing assertion rather than asserting it
in a comment.

## Layout

```
rust/Cargo.toml                    workspace
rust/tarkovstats-feed/
  src/main.rs                      stdin loop, exit codes
  src/cli.rs                       argument parsing and --help
  src/lexer.rs                     the state machine
  src/error.rs                     the seven messages
  src/record.rs                    one entry, as raw bytes
  src/sink.rs                      binary and text output modes
  src/whitespace.rs                the ECMAScript \s set, and the split wait
  tests/state_machine.rs           the grammar and the seven messages
  tests/whitespace_split.rs        every member, every state, every split offset
  tests/process.rs                 the stdin/stdout contract and exit codes
  tests/fuzz.rs                    prefix sweeps, byte mutations, the linearity bound
```

```console
$ cargo test --manifest-path rust/Cargo.toml
$ cargo clippy --manifest-path rust/Cargo.toml --all-targets
$ cargo build --release --manifest-path rust/Cargo.toml
```
