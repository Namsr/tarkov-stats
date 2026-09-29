// Differential harness for the crate's central claim.
//
// `tarkovstats-feed` is only worth anything if it is byte-exact with
// `createTimestampObjectParser` in `scripts/regular-profile-sync-core.mjs`. That
// claim is not checkable from inside Rust: it is a claim about a JavaScript
// function, so it needs a JavaScript process, the real bytes and the real
// binary. This file is that check, and it is the only thing in the repository
// that enforces it. `tests/state_machine.rs` asserts the grammar; nothing in
// `rust/` can notice an edit to the file it was ported from, and five live sync
// scripts import that file.
//
// Both sides see the same input bytes:
//
//   * the **reference** is the unmodified function, imported rather than
//     reimplemented so an edit to it is an edit to the oracle, fed through a
//     real `TextDecoder({ stream: true })` the way the live collectors feed it;
//   * the **binary** is spawned as a child process and written to through a
//     pipe, one write per planned chunk with a real inter-chunk gap, so the
//     splits are the ones its own 64 KiB reads create plus the ones the case
//     asks for.
//
// `proveStreaming()` runs before any comparison and fails the whole harness if
// the write pattern does not actually deliver a chunk in pieces. Handing a
// child the whole body at once is the failure mode that matters: the lexer is
// split-invariant, so a child that never sees a boundary produces the right
// answer for every case and the harness reports a pass it did not earn.
//
// For every case the harness compares acceptance, the number of entries each
// side dispatched, every key and value after the reader the crate README
// specifies (`JSON.parse` on a key, `Number` or `JSON.parse` on a value), and
// the message a caller would rethrow. Two things are allowed, and both are
// stated here rather than buried in a comparison:
//
//   * a document V8 rejects mid-token. The reference calls `JSON.parse` inside
//     `readString`, so it throws before `onEntry` and dispatches nothing; the
//     port emits the record and the reader raises the identical error. The
//     count may differ by exactly that one record, and the record must carry
//     the reference's message. A structural rejection has no such allowance:
//     the counts must match.
//   * the two-defect case documented in `rust/README.md`, where only the
//     message may differ.
//
// Run it with:  npm run test:feed-differential
//
// It is a separate script rather than part of `npm test` on purpose: it needs a
// Rust toolchain and a built binary, while the repository gate is `npm test`,
// which must stay fast and must not require cargo for a Node-side change. It is
// deliberately not named `*.test.mjs`, because
// `tests/test-registry.test.mjs` polices that anything matching that pattern is
// reachable from `npm test`.
//
// Environment:
//   TARKOVSTATS_FEED_BIN     path to the binary under test
//   TARKOVSTATS_FEED_GAP_MS  inter-chunk gap in ms, floor 15, raised to clear
//                            the binary's startup time
//   TARKOVSTATS_FEED_RANDOM  randomized document count, default 100
//   TARKOVSTATS_FEED_TIMEOUT_MS  per-run watchdog in ms, default 30000

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { createTimestampObjectParser } from "../../../scripts/regular-profile-sync-core.mjs";

// ---------------------------------------------------------------- the binary --

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const BIN_NAME = process.platform === "win32" ? "tarkovstats-feed.exe" : "tarkovstats-feed";
const BIN = process.env.TARKOVSTATS_FEED_BIN
  ? path.resolve(REPO_ROOT, process.env.TARKOVSTATS_FEED_BIN)
  : path.join(REPO_ROOT, "rust", "target", "release", BIN_NAME);

// The read size `src/main.rs` uses, repeated here because `proveStreaming()`
// has to feed a probe that reads the same way the binary does.
const READ_SIZE = 64 * 1024;

// A cut point the case chose has to be a cut point the child actually observes,
// and the only way to arrange that from outside the process is to let it take
// the bytes before the rest exist: write, wait, write. `TARKOVSTATS_FEED_GAP_MS`
// is the floor; `proveStreaming()` raises it to clear the binary's own startup
// time, and checks against a probe that the raise was enough.
const GAP_MS = readNumber("TARKOVSTATS_FEED_GAP_MS", 15);
let gapMs = GAP_MS;
const TIMEOUT_MS = readNumber("TARKOVSTATS_FEED_TIMEOUT_MS", 30000);
const RANDOM_DOCUMENTS = readNumber("TARKOVSTATS_FEED_RANDOM", 100);

function readNumber(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    process.stderr.write(`${name} must be a non-negative number, got ${JSON.stringify(raw)}\n`);
    process.exit(2);
  }
  return value;
}

// ------------------------------------------------------------------ readers --

const KIND_NUMBER = 0x4e;
const KIND_STRING = 0x53;

/**
 * One binary record, through the reader the crate README specifies:
 *
 *     key = JSON.parse(keyBytes);  value = Number| JSON.parse(valueBytes)
 *
 * A malformed token has to reach V8 so the caller sees V8's `SyntaxError` rather
 * than a Rust message, so neither call is guarded here; the resulting error is
 * folded into the outcome below, which is what makes the two sides comparable.
 * The key is read first, as the README's reader does, so a key V8 rejects wins
 * over a value it would also have rejected.
 */
function binaryEntry(record) {
  let key;
  try {
    key = JSON.parse(record.key.toString("utf8"));
  } catch (error) {
    return { key: null, value: null, error: messageOf(error) };
  }
  try {
    const text = record.value.toString("utf8");
    return { key, value: record.kind === KIND_NUMBER ? Number(text) : JSON.parse(text) };
  } catch (error) {
    return { key, value: null, error: messageOf(error) };
  }
}

/**
 * The `--format=binary` frame stream, decoded from the documented layout
 * rather than from the crate, so a change to the framing surfaces here.
 *
 *     kind u8 | key_len u32 le | key | value_len u32 le | value
 */
function decodeFrames(frames) {
  const records = [];
  let at = 0;
  while (at < frames.length) {
    const kind = frames[at];
    at += 1;
    if (kind !== KIND_NUMBER && kind !== KIND_STRING) {
      throw new Error(`unknown record kind 0x${kind.toString(16)} at byte ${at - 1}`);
    }
    const key = take(frames, at);
    const value = take(frames, key.next);
    at = value.next;
    records.push({ kind, key: key.bytes, value: value.bytes });
  }
  return records;

  function take(source, start) {
    if (start + 4 > source.length) {
      throw new Error(`truncated length prefix at byte ${start} of ${source.length}`);
    }
    const len = source.readUInt32LE(start);
    const from = start + 4;
    if (from + len > source.length) {
      throw new Error(`token of ${len} bytes runs past the end of the stream at byte ${from}`);
    }
    return { bytes: source.subarray(from, from + len), next: from + len };
  }
}

function messageOf(error) {
  return String(error?.message ?? error);
}

/** Canonical text for one entry, so a value difference is readable. */
function show(entry) {
  return JSON.stringify(entry, (_key, value) => {
    if (typeof value !== "number") return value;
    // JSON.stringify renders the interesting values as `null`, which would hide
    // exactly the divergences this harness exists to catch: 1e400, 1e-400, -0.
    if (Number.isNaN(value)) return "NaN";
    if (value === Infinity) return "Infinity";
    if (value === -Infinity) return "-Infinity";
    if (Object.is(value, -0)) return "-0";
    return value;
  });
}

// --------------------------------------------------------- one child, streamed --

/**
 * What the binary does with these bytes, over a pipe, at these cuts.
 *
 * Every failure path here is loud. The child can legitimately stop reading
 * before the last planned chunk is written, because a document it has already
 * rejected needs nothing more; the writes after that point are then dropped by
 * the closed pipe. Waiting for a `'drain'` that cannot arrive would leave the
 * process with no live handles, and Node reports that as an unsettled top-level
 * await and exits **zero** — a silent pass. So the child is fed through a
 * write that always settles, `stdin` carries an error listener, and a watchdog
 * timer is held for the whole run, which is a live handle precisely while the
 * run is pending.
 */
async function observeBinary(bytes, cuts) {
  const child = spawn(BIN, [], { stdio: ["pipe", "pipe", "pipe"] });
  const frames = collect(child.stdout);
  const errors = collect(child.stderr);
  const closed = new Promise((resolve, reject) => {
    child.once("error", (error) => reject(new Error(`could not run ${BIN}: ${messageOf(error)}`)));
    child.once("close", (code) => resolve(code));
  });
  // A write to a pipe the child has already closed fails, and that is expected
  // only when the child is known to have stopped reading. Any other write error
  // means a chunk was lost to something the harness did not model, which would
  // be a false pass, so it fails the run.
  const stdinErrors = [];
  child.stdin.on("error", (error) => stdinErrors.push(error));

  let timedOut = false;
  const watchdog = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, TIMEOUT_MS);

  const parts = split(bytes, cuts);
  let written = 0;
  try {
    for (const [index, part] of parts.entries()) {
      // The gap goes *between* parts: the child is blocked in `read()` and
      // takes the first part on its own, so the cut is real rather than
      // something the pipe coalesces away.
      if (index > 0) await sleep(gapMs);
      if (await writeChunk(child, part)) written += 1;
    }
  } finally {
    child.stdin.end();
  }

  let code;
  try {
    code = await closed;
  } finally {
    clearTimeout(watchdog);
  }
  const [raw, stderr] = await Promise.all([frames, errors]);

  if (timedOut) {
    throw new Error(`${BIN} did not close within ${TIMEOUT_MS} ms on cuts [${cuts.join(", ")}]`);
  }
  if (code === 1) {
    // Exit 1 is a usage error, which means the harness invoked the binary
    // wrongly. Never a property of the input.
    throw new Error(`${BIN} exited 1 (usage): ${stderr.toString().trim()}`);
  }
  if (stdinErrors.length > 0 && written === parts.length) {
    throw new Error(
      `every chunk was reported written but stdin raised ${stdinErrors.map((e) => e.code).join(", ")} ` +
        `on cuts [${cuts.join(", ")}]`,
    );
  }

  // The records completed before a failure are flushed on the failure path too,
  // and they are the entries the caller was handed, so they are decoded on both
  // exit codes.
  const records = decodeFrames(raw).map(binaryEntry);
  const failedAt = records.findIndex((entry) => entry.error !== undefined);
  // The shim rethrows `stderr.replace(/\n$/, "")`, and empty stderr is success,
  // so it is reported as the absence of a message rather than an empty one.
  const reported = stderr.toString().replace(/\n$/, "");
  return {
    code,
    written,
    total: parts.length,
    // A malformed token is not the lexer's to reject, so a record whose reader
    // call raises is a *caller-visible* failure, and it is the same one the
    // reference raises when its own `readString` calls `JSON.parse`.
    accepted: code === 0 && failedAt === -1,
    message: failedAt === -1
      ? (reported === "" ? null : reported)
      : records[failedAt].error,
    entries: failedAt === -1 ? records : records.slice(0, failedAt),
  };
}

/**
 * One planned chunk, reported as delivered or not.
 *
 * A settled `'drain'` is the normal case. A closed or destroyed pipe settles it
 * too, so a child that stopped reading early unblocks the loop instead of
 * parking it on an event that will never fire.
 */
function writeChunk(child, part) {
  if (child.stdin.destroyed || child.exitCode !== null) return Promise.resolve(false);
  const flushed = child.stdin.write(part);
  if (flushed) return Promise.resolve(true);
  return new Promise((resolve) => {
    const settle = () => {
      child.stdin.off("drain", settle);
      child.stdin.off("close", settle);
      child.stdin.off("error", settle);
      resolve(!child.stdin.destroyed);
    };
    child.stdin.once("drain", settle);
    child.stdin.once("close", settle);
    child.stdin.once("error", settle);
  });
}

function collect(stream) {
  const chunks = [];
  return new Promise((resolve, reject) => {
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.once("end", () => resolve(Buffer.concat(chunks)));
    stream.once("error", reject);
  });
}

/** The byte parts for a cut plan. No cuts means the body arrives whole. */
function split(bytes, cuts) {
  if (!cuts || cuts.length === 0) return [bytes];
  const parts = [];
  let at = 0;
  for (const cut of cuts) {
    if (!Number.isInteger(cut) || cut < at || cut > bytes.length) {
      throw new Error(`bad cut ${cut}: not an integer in [${at}, ${bytes.length}]`);
    }
    parts.push(bytes.subarray(at, cut));
    at = cut;
  }
  parts.push(bytes.subarray(at));
  return parts;
}

/** What the unmodified reference does with these bytes, split at `cuts`. */
function observeReference(bytes, cuts) {
  const entries = [];
  let accepted = true;
  let message = null;
  try {
    const parser = createTimestampObjectParser((key, value) => {
      entries.push({ key, value });
    });
    // The collectors make one decoder per body and finish with the flush, so a
    // trailing incomplete sequence becomes U+FFFD. Same here.
    const decoder = new TextDecoder();
    for (const part of split(bytes, cuts)) {
      parser.append(decoder.decode(part, { stream: true }));
    }
    parser.finish(decoder.decode());
  } catch (error) {
    accepted = false;
    message = messageOf(error);
  }
  return { accepted, message, entries };
}

// --------------------------------------------------- proving the splits are real --

// Reads fd 0 in `READ_SIZE` blocks, exactly as `src/main.rs` reads stdin, and
// prints the size of every read it got. It announces itself on stderr first, so
// the driver can hold the first write until the reader is already blocked —
// without the handshake a `node` probe spends longer starting up than the gap,
// which would fail the check for the wrong reason.
const PROBE_SOURCE = [
  'process.stderr.write("ready\\n");',
  'const sizes = [];',
  `const chunk = Buffer.alloc(${READ_SIZE});`,
  'for (;;) {',
  '  let read = 0;',
  '  try {',
  '    read = require("node:fs").readSync(0, chunk, 0, chunk.length, null);',
  '  } catch (error) {',
  '    if (error.code === "EAGAIN") continue;',
  '    if (error.code === "EOF") break;',
  '    throw error;',
  '  }',
  '  if (read === 0) break;',
  '  sizes.push(read);',
  '}',
  'process.stdout.write(JSON.stringify(sizes));',
].join("\n");

/**
 * Fail before any comparison unless a two-chunk plan really reaches a child as
 * two reads.
 *
 * The lexer is split-invariant by design, which is exactly the problem: a child
 * that is handed every byte in one go answers correctly for every case in this
 * corpus and the harness prints a clean run it never earned. The binary reports
 * nothing about its read boundaries, so the check is made against a probe that
 * does, driven by the identical write path — same pipe, same gap, same
 * `READ_SIZE` reads.
 *
 * The other half of the problem is the binary, which has no readiness signal to
 * wait for: it cannot consume its first chunk before it has started, so a gap
 * shorter than process startup puts the first two writes in the pipe together
 * and every split below becomes one read again. Startup is timed first and the
 * gap is raised above it, so a slow machine raises the gap instead of quietly
 * losing the property.
 */
async function proveStreaming() {
  const startup = await measureStartup();
  if (startup >= gapMs) gapMs = Math.ceil(startup) + 5;

  const child = spawn(process.execPath, ["-e", PROBE_SOURCE], { stdio: ["pipe", "pipe", "pipe"] });
  const sizes = collect(child.stdout).then((raw) => JSON.parse(raw.toString("utf8")));
  const errors = collect(child.stderr);
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  child.stdin.on("error", () => {});

  const watchdog = setTimeout(() => child.kill(), TIMEOUT_MS);
  const payload = Buffer.from('{"1":1,"2":"x"}', "utf8");
  const cut = 7;
  try {
    await announce(child.stderr);
    await writeChunk(child, payload.subarray(0, cut));
    await sleep(gapMs);
    await writeChunk(child, payload.subarray(cut));
    child.stdin.end();
    await closed;
  } finally {
    clearTimeout(watchdog);
  }

  const [reads, stderr] = await Promise.all([sizes, errors]);
  const total = reads.reduce((sum, size) => sum + size, 0);
  if (reads.length < 2 || total !== payload.length) {
    process.stderr.write(
      "the harness cannot deliver a chunk in pieces: the probe read " +
        `${JSON.stringify(reads)} of ${payload.length} bytes.\n` +
        "Every chunk-split case below would be a pass that was never tested.\n" +
        `The gap is ${gapMs} ms; raise TARKOVSTATS_FEED_GAP_MS above that and try again.\n` +
        (stderr.length > 0 ? `probe stderr: ${stderr.toString().trim()}\n` : ""),
    );
    process.exit(2);
  }
  return { reads, startup };
}

/** Resolves once the probe has written its readiness line. */
function announce(stderr) {
  return new Promise((resolve) => {
    const watchdog = setTimeout(resolve, TIMEOUT_MS);
    const onData = (chunk) => {
      if (!chunk.toString("utf8").includes("ready")) return;
      clearTimeout(watchdog);
      stderr.off("data", onData);
      resolve();
    };
    stderr.on("data", onData);
  });
}

/**
 * Wall time from `spawn` to `close` for a trivial one-write body. The first
 * read happens before the process exits, so this is an upper bound on how long a
 * chunk can sit in the pipe unwatched.
 */
async function measureStartup() {
  let slowest = 0;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const started = process.hrtime.bigint();
    const observed = await observeBinary(Buffer.from('{"1":1}'), []);
    if (observed.code !== 0 || observed.entries.length !== 1) {
      throw new Error(`the binary did not parse {"1":1}: exit ${observed.code}`);
    }
    slowest = Math.max(slowest, Number(process.hrtime.bigint() - started) / 1e6);
  }
  return slowest;
}

// ------------------------------------------------------------------ corpus ---

const at = (codePoint) => String.fromCodePoint(codePoint);

// The full ECMAScript `\s` set: six single-byte members and nineteen multi-byte
// ones. Spelled as code points because a literal U+00A0 or U+FEFF in source is
// invisible, and a reviewer's eye would be the only check on it otherwise.
const SPACES = [
  0x0009, 0x000a, 0x000b, 0x000c, 0x000d, 0x0020,
  0x00a0, 0x1680,
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009,
  0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
];

// The three exclusions: not whitespace, and they keep rejecting at every split.
const NOT_SPACES = [0x200b, 0x0085, 0x180e];

const hex = (codePoint) => `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
const text = (source) => Buffer.from(source, "utf8");

const CASES = [];

/**
 * @param {string} name
 * @param {string} why           why the case earns its place, in one line
 * @param {Buffer} input
 * @param {object} [options]
 * @param {number[][]} [options.plans]    cut plans to run the body under
 * @param {string|null} [options.expect]   "accepted", a message both sides must
 *                                         report, or null to compare messages
 * @param {boolean} [options.deviation]    the one allowed message divergence
 */
function addCase(name, why, input, { plans = [[]], expect = null, deviation = false } = {}) {
  CASES.push({ name, why, input, plans, expect, deviation });
}

const object = (entries) => `{${entries.map(([key, value]) => `"${key}":${value}`).join(",")}}`;

// -- acceptance and the values a caller ends up holding ------------------------

addCase("the ordinary document", "keys and numeric values, one chunk", text(object([
  ["15", "1755979243867"], ["42", "1720000001"],
])));

addCase("string values", "a string value is carried verbatim and read back with JSON.parse", text(object([
  ["1", '"1720000001"'], ["2", '""'], ["3", '"a\\tb"'], ["4", '"\\u00e9"'],
])));

addCase(
  "numeric token spellings",
  "the raw token has to reach Number, so 007, 1E+5, 1e400, 1e-400, -0 and an inexact integer all survive",
  text(object([
    ["1", "007"], ["2", "1E+5"], ["3", "1e400"], ["4", "-0"],
    ["5", "-12.5e-3"], ["6", "9007199254740993"], ["7", "1e-400"],
  ])),
);

addCase(
  "leading zeros and a trailing comma",
  "two deviations from JSON the original accepts, preserved",
  text('{ "1":0, "2":00, "3":1,}'),
);

addCase("duplicate keys", "every duplicate is dispatched, in document order, not last-wins", text(object([
  ["1", "1"], ["1", "2"], ["1", "3"],
])));

addCase("an empty object", "no entries, accepted", text("{}"));

addCase(
  "an empty body is truncated, not an object",
  "there is no first code unit, so this is the final whole-state check",
  Buffer.alloc(0),
  { expect: "truncated or invalid updated JSON" },
);

addCase(
  "a key is never validated as a number",
  "the original only string-parses the key, so \"1.5\", \"1e3\" and \"\" are ordinary keys",
  text(object([["1.5", "1"], ["1e3", "2"], ["", "3"]])),
);

addCase(
  "an invalid UTF-8 byte in a value reaches the reader as U+FFFD",
  "the lexer never decodes; the reference decoder already replaced it, so both sides agree",
  Buffer.concat([text('{"1":"a'), Buffer.from([0xff]), text('b"}')]),
);

addCase(
  "an invalid UTF-8 byte in the key position is not whitespace",
  "neither side decodes before lexing, so a lead byte with no continuation is not a member prefix",
  Buffer.concat([text("{"), Buffer.from([0xc3]), text('"1":2}')]),
  { expect: "expected JSON string" },
);

// -- the whitespace set ---------------------------------------------------------

for (const codePoint of SPACES) {
  addCase(
    `${hex(codePoint)} is whitespace`,
    "every member of the ECMAScript \\s set on its own, wrapped around a document",
    Buffer.from(`${at(codePoint)}{"1":2}${at(codePoint)}`, "utf8"),
    { expect: "accepted" },
  );
}

addCase(
  "a run of all twenty-five members",
  "all of them in one document, so a gap in the table shows up as a rejection",
  Buffer.from(`${SPACES.map(at).join("")}{"1":2}${SPACES.map(at).join("")}`, "utf8"),
  { expect: "accepted" },
);

for (const codePoint of NOT_SPACES) {
  addCase(
    `${hex(codePoint)} is not whitespace`,
    "an exclusion in the value position, the state that names it",
    Buffer.from(`{"1":${at(codePoint)}2}`, "utf8"),
    { expect: "expected numeric timestamp" },
  );
}

addCase(
  "an incomplete member at the end of the body is not whitespace",
  "the wait is suppressed at EOF, so a trailing U+00A0 prefix is the U+FFFD the decoder would have flushed",
  Buffer.concat([text('{"1":2}'), Buffer.from([0xc2])]),
  { expect: "unexpected data after JSON object" },
);

// -- the seven messages ---------------------------------------------------------

const MESSAGES = [
  ["updated JSON must be an object", ["null", "[1]", '"1"', "0x1", " true", "1"]],
  ["expected JSON string", ["{1:2}", "{,}", '{"1":2,,}', '{"1":2,[}']],
  ["expected ':' after account id", ['{"1" 2}', '{"1" x}', '{"1",2}', '{"1"  , "2":2}']],
  ["expected numeric timestamp", ['{"1":x}', '{"1":+1}', '{"1":.5}', '{"1":tru}', '{"1":--1}', '{"1":-}']],
  ["expected ',' or '}' after timestamp", ['{"1":1 2}', '{"1":1;}', '{"1":1.2.3}', '{"1":1e}']],
  ["truncated or invalid updated JSON", ["{", '{"1"', '{"1":', '{"1":1', '{"1":1,', '{"1":"1', '{"1":1, "2"', '{\v"1":2']],
  ["unexpected data after JSON object", ['{"1":1}{"2":2}', '{"1":1} null', '{"1":1}}', '{"1":1}\v1']],
];

for (const [index, [message, inputs]] of MESSAGES.entries()) {
  for (const [position, input] of inputs.entries()) {
    addCase(
      `message ${index + 1}, input ${position}`,
      `the message the original owns, and the state that raises it: ${JSON.stringify(message)}`,
      text(input),
      { expect: message },
    );
  }
}

// -- malformed tokens, which have to reach V8 unchanged -------------------------

addCase(
  "a malformed string value reaches JSON.parse",
  "the lexer must not pre-reject a token; V8 raises, and the message is V8's",
  text('{"1":"\\q"}'),
);

addCase(
  "a malformed string value, split three ways",
  "the token spans a chunk boundary, and the wait must not swallow it",
  text('{"1":"\\q"}'),
  { plans: [[], [5], [7], [5, 7]] },
);

addCase(
  "a lone surrogate escape is text, not a code point",
  "a \\ud83d escape is six ASCII bytes and must not be re-encoded on the way through",
  text('{"1":"\\ud83d","2":"a\\ud800b"}'),
);

addCase(
  "a raw newline inside a value stays framed",
  "length prefixes are what keep a raw control byte from desynchronising the reader",
  text('{"1":"a\nb"}'),
);

addCase(
  "a raw newline inside a key stays framed too",
  "and on the key side, which the reader JSON.parses first",
  text('{"a\nb":1}'),
);

// -- splits ---------------------------------------------------------------------

addCase(
  "an explicit two-chunk split inside a number",
  "the value is completed by the second chunk, and both sides must agree on it",
  text('{"1":1234567890}'),
  { plans: [[], [4], [8]] },
);

addCase(
  "an explicit two-chunk split between two entries",
  "the comma and the next key land in different chunks, so the second entry only exists if the second chunk arrived",
  text('{"1":1,"2":2}'),
  { plans: [[6], [7], [6, 7]] },
);

addCase(
  "an explicit split before the closing brace",
  "the last chunk is a single byte, and the document is only accepted if it arrived",
  text('{"1":1}'),
  { plans: [[5], [6]], expect: "accepted" },
);

addCase(
  "an exponent split across a boundary",
  "1e5 is a number, and the two chunks hold 1e and 5",
  text('{"1":1e5}'),
  { plans: [[5], [6], [5, 6]] },
);

addCase(
  "a number cut short of EOF stays incomplete",
  "the final flag is what separates a complete number from a prefix of one",
  text('{"1":12'),
  { plans: [[4], []], expect: "truncated or invalid updated JSON" },
);

addCase(
  "an escape cut across a boundary",
  "a backslash at the end of a chunk must not look like the end of the token",
  text('{"1":"a\\"}'),
  { plans: [[5], [6], [5, 6]] },
);

addCase(
  "a string token longer than one read",
  "the resume cursor has to carry the scan across chunks, or the port goes quadratic",
  Buffer.from(`{"1":"${"a".repeat(70000)}"}`, "utf8"),
  { plans: [[], [8], [40000]] },
);

// The cases that prove delivery on their own. Every plan leaves the first chunk
// incomplete, so a child that never read the second one would reject; the
// reference accepts, so a mismatch here means the split did not happen. The
// entry count does the same job for the plans that add an entry in chunk two.
addCase(
  "delivery proof: the closing brace is the whole second chunk",
  "chunk one is truncated, so exit 0 is only reachable if chunk two was read",
  text('{"1":1}'),
  { plans: [[6]], expect: "accepted" },
);

addCase(
  "delivery proof: a key split down the middle",
  "chunk one holds half a string token, so nothing can be dispatched without chunk two",
  text('{"1":"abc"}'),
  { plans: [[4], [5], [7]], expect: "accepted" },
);

addCase(
  "delivery proof: a second entry that exists only in chunk two",
  "the record count is one without chunk two and two with it",
  text('{"1":1,"2":2}'),
  { plans: [[6], [8]], expect: "accepted" },
);

// Every member, cut at every offset that can split it. This is the property the
// three-answer scanner exists for, driven through the real binary and the real
// pipe rather than in process.
for (const codePoint of SPACES) {
  const head = text('{"1":1,');
  const member = Buffer.from(at(codePoint), "utf8");
  const plans = [[]];
  for (let offset = 1; offset < member.length; offset += 1) {
    plans.push([head.length + offset]);
  }
  addCase(
    `a cut inside ${hex(codePoint)}`,
    "a member split across chunks, at every offset that can split it",
    Buffer.concat([head, member, text('"2":2}')]),
    { plans, expect: "accepted" },
  );
}

// A real 64 KiB read boundary. The binary reads 64 KiB at a time, so a body of
// this size is split by the binary itself at 65536; the member is placed to
// straddle 65535/65536. The explicit plans put the same straddle under a
// guaranteed gap, so the case holds even where one `write` is not split by the
// operating system. What follows the member is an entry, not a second object:
// a second `{` would be rejected by both sides in the `key` state and the
// whitespace wait would never be reached.
function boundaryBody(codePoint) {
  const head = Buffer.from(`{${" ".repeat(READ_SIZE - 2)}`, "utf8");
  if (head.length !== READ_SIZE - 1) throw new Error(`boundary head is ${head.length} bytes`);
  return Buffer.concat([head, Buffer.from(at(codePoint), "utf8"), text('"1":2}')]);
}

for (const codePoint of [0x00a0, 0x3000, 0xfeff, 0x200b, 0x0085, 0x180e]) {
  const included = SPACES.includes(codePoint);
  addCase(
    `a 64 KiB boundary inside ${hex(codePoint)}`,
    included
      ? "a member straddling the binary's own read boundary, which has to be waited for"
      : "an exclusion straddling the boundary, which still has to reject",
    boundaryBody(codePoint),
    {
      plans: [[], [READ_SIZE - 1], [READ_SIZE]],
      expect: included ? "accepted" : "expected JSON string",
    },
  );
}

// -- the one accepted deviation -------------------------------------------------

addCase(
  "two defects: a malformed key and a structural one",
  "the only document the two implementations may report differently, and only in the message",
  text('{"\\q";2}'),
  { deviation: true },
);

// -- randomized documents --------------------------------------------------------

/** A fixed seed, so a red run reproduces and a green run is a fact. */
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

const RANDOM_KEYS = ["1", "42", "007", "1.5", "1e3", "a\\tb", "", "\\u00e9", '""', "0", "null"];
const RANDOM_VALUES = [
  "0", "1", "007", "1e5", "1E+5", "1e400", "1e-400", "-0", "-12.5e-3", "9007199254740993",
  '"x"', '""', '"a\\tb"', '"\\ud83d"', '"\\q"', "x", "1.2.3", "1e", "", " ", "+1", "0x1", "1.",
];
const RANDOM_NOISE = ["", " ", "\n", "\t", "\r\n", at(0x00a0), at(0x3000), at(0xfeff), at(0x200b), "  "];

function randomDocument(random) {
  const pick = (list) => list[Math.floor(random() * list.length)];
  const count = 1 + Math.floor(random() * 3);
  const parts = [];
  for (let index = 0; index < count; index += 1) {
    parts.push(`"${pick(RANDOM_KEYS)}"${pick(RANDOM_NOISE)}:${pick(RANDOM_NOISE)}${pick(RANDOM_VALUES)}`);
    if (index < count - 1) parts.push(`${pick(RANDOM_NOISE)}${random() < 0.25 ? "," : ""}`);
  }
  const open = random() < 0.75 ? "{" : pick(["[", " ", "", "{\v"]);
  const close = random() < 0.75 ? "}" : pick(["", "]", "}", "}\v"]);
  return Buffer.from(open + parts.join("") + close, "utf8");
}

for (let index = 0; index < RANDOM_DOCUMENTS; index += 1) {
  const random = mulberry32(0xfeed0000 + index);
  const input = randomDocument(random);
  const plans = [[]];
  // Three cut points at pseudo-random offsets, so the sweep sees cuts inside
  // keys, values, whitespace and escapes rather than one lucky position.
  for (let cut = 0; cut < 3 && input.length > 2; cut += 1) {
    const offset = 1 + Math.floor(random() * (input.length - 1));
    if (!plans.some((plan) => plan.length === 1 && plan[0] === offset)) plans.push([offset]);
  }
  addCase(
    `randomized ${index}`,
    "a seeded document, run whole and at three cut points, for the long tail neither the curated cases nor the Rust tests enumerate",
    input,
    { plans },
  );
}

// ---------------------------------------------------------------- comparing ---

/** Entry lists have to match exactly, in order, value for value. */
function entriesAgree(left, right) {
  if (left.length !== right.length) return false;
  return left.every((entry, index) => show(entry) === show(right[index]));
}

function compare(testCase, reference, binary) {
  if (reference.accepted !== binary.accepted) {
    return `${binary.label}: the reference ${reference.accepted ? "accepted" : "rejected"} ` +
      `but the binary ${binary.accepted ? "accepted" : "rejected"} ` +
      `(exit ${binary.code}, ${binary.written}/${binary.total} chunks written)`;
  }

  if (!entriesAgree(reference.entries, binary.entries)) {
    const left = reference.entries.map(show).join(" | ") || "(none)";
    const right = binary.entries.map(show).join(" | ") || "(none)";
    return `${binary.label}: entries differ\n      reference ${left}\n      binary    ${right}`;
  }

  if (testCase.deviation) {
    // Checked rather than assumed: both sides must still reject, and only the
    // message may differ. A deviation that stopped diverging means the
    // documentation is stale, which is a failure of this harness too.
    if (reference.accepted) return "the two-defect case was accepted; the deviation it allows is stale";
    if (reference.message === binary.message) {
      return "the two-defect case no longer diverges; the documented deviation is gone";
    }
    return null;
  }

  if (testCase.expect !== null) {
    if (testCase.expect === "accepted") {
      if (!reference.accepted) {
        return `corpus error: the reference rejected with ${JSON.stringify(reference.message)}`;
      }
      return null;
    }
    if (reference.message !== testCase.expect) {
      return `corpus error: the reference reports ${JSON.stringify(reference.message)}, ` +
        `not ${JSON.stringify(testCase.expect)}`;
    }
    if (binary.message !== testCase.expect) {
      return `${binary.label}: expected ${JSON.stringify(testCase.expect)}, ` +
        `got ${JSON.stringify(binary.message)}`;
    }
    return null;
  }

  if (reference.message !== binary.message) {
    return `${binary.label}: messages differ\n` +
      `      reference ${JSON.stringify(reference.message)}\n` +
      `      binary    ${JSON.stringify(binary.message)}`;
  }
  return null;
}

// ------------------------------------------------------------------ running ---

async function main() {
  if (!existsSync(BIN)) {
    process.stderr.write(
      `missing ${BIN}\n` +
        "build it with:  cargo build --release --locked --manifest-path rust/Cargo.toml\n" +
        "or run the whole thing with:  npm run test:feed-differential\n" +
        "or point TARKOVSTATS_FEED_BIN at a binary.\n",
    );
    process.exit(2);
  }

  const proof = await proveStreaming();
  process.stdout.write(
    `streaming: the probe read ${proof.reads.length} chunks ${JSON.stringify(proof.reads)} for one ` +
      `two-chunk plan; the binary runs in ${proof.startup.toFixed(1)} ms against a ${gapMs} ms gap\n`,
  );

  const failures = [];
  let runs = 0;
  let cutRuns = 0;
  let incomplete = 0;
  let allowances = 0;

  for (const testCase of CASES) {
    for (const cuts of testCase.plans) {
      runs += 1;
      if (cuts.length > 0) cutRuns += 1;
      const reference = observeReference(testCase.input, cuts);
      const binary = await observeBinary(testCase.input, cuts);
      if (binary.written < binary.total) incomplete += 1;
      const problem = compare(testCase, reference, {
        ...binary,
        label: cuts.length === 0 ? "whole" : `split at ${cuts.join("+")}`,
      });
      if (problem) {
        failures.push(
          `${testCase.name} (${cuts.length === 0 ? "whole" : `split at ${cuts.join("+")}`})\n` +
            `    why:   ${testCase.why}\n` +
            `    input: ${JSON.stringify(testCase.input.toString("utf8")).slice(0, 160)}\n` +
            `    ${problem}`,
        );
      } else if (testCase.deviation) {
        allowances += 1;
      }
    }
  }

  if (failures.length > 0) {
    for (const failure of failures) process.stderr.write(`\nFAIL ${failure}\n`);
    process.stderr.write(
      `\ndifferential: ${failures.length} divergence(s) in ${runs} runs ` +
        `(${cutRuns} of them split).\n`,
    );
    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    `differential: ${CASES.length} documents, ${runs} runs (${cutRuns} split), ` +
      `0 divergences (${allowances} documented deviation)\n` +
      `${incomplete} run(s) ended before the last planned chunk, which the ` +
      "reference rejects at the same point.\n",
  );
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exit(1);
});
