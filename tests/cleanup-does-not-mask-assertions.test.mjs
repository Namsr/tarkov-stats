import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

// SQLite opens its files without FILE_SHARE_DELETE, so on Windows a handle that
// is still live when a suite cleans up makes the forced delete throw. Because the
// delete sits in a `finally`, that throw replaces the assertion failure that
// caused the cleanup: the report shows a locked temp path and no diff, and the
// real defect has to be found a second time. POSIX unlink(2) has no such rule, so
// off Windows the same delete succeeds and the assertion failure is the one that
// surfaces. Both branches are asserted, so a platform that starts behaving like
// the other fails here instead of silently skipping.

const isWindows = process.platform === "win32";
// Windows names the lock EPERM, and EBUSY when an on-access scanner or an indexer
// is holding the file. rmSync defaults to maxRetries: 0, so either one surfaces
// on the first attempt, and a gate whose whole job is to run on Windows would
// flake on a locked CI worker if it accepted only the code measured here.
const lockCodes = new Set(["EPERM", "EBUSY"]);

function lockedDeleteCode() {
  const directory = mkdtempSync(join(tmpdir(), "cleanup-lock-"));
  const db = new DatabaseSync(join(directory, "live.db"));
  db.exec("CREATE TABLE t (a)");
  let code = null;
  try {
    rmSync(directory, { recursive: true, force: true });
  } catch (error) {
    code = error.code;
  } finally {
    // The handle goes first, so the directory is removable and nothing is left
    // locked for the rest of the run.
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
  return code;
}

const locked = lockedDeleteCode();

test("a live SQLite handle makes a forced delete throw on Windows and succeed on POSIX", () => {
  assert.ok(isWindows ? lockCodes.has(locked) : locked === null,
    isWindows
      ? `this suite is the regression gate for the Windows lock the guard exists for, got ${locked}`
      : "unlink(2) removes an open file, so the delete succeeds here and there is no lock to mask a failure with");
});

test("an unguarded cleanup delete loses the failure that caused it", () => {
  const directory = mkdtempSync(join(tmpdir(), "cleanup-mask-"));
  const db = new DatabaseSync(join(directory, "live.db"));
  db.exec("CREATE TABLE t (a)");
  try {
    // The bare form. On Windows the finally throws and the assertion is
    // discarded; on POSIX the delete succeeds and the assertion is what the
    // report carries, which is the only reason the guard is not visible there.
    assert.throws(() => {
      try {
        assert.fail("no such column: OLD.prestige");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
      // The code the probe above observed, rather than a hardcoded one, so the
      // two tests cannot disagree about which code Windows reports.
    }, isWindows ? { code: locked } : { message: "no such column: OLD.prestige" });

    // The guarded form the suite uses: the cleanup stays best effort, so the
    // real failure is what the report carries on either platform.
    assert.throws(() => {
      try {
        assert.fail("no such column: OLD.prestige");
      } finally {
        try { rmSync(directory, { recursive: true, force: true }); } catch { /* SQLite keeps the adapter open. */ }
      }
    }, { message: "no such column: OLD.prestige" });
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

// A forced delete is an rm call with a `force: true` next to it. Both halves are
// matched through one window rather than one line, because an options object
// spread over several lines is ordinary formatting, and because a whitespace
// literal like "force: true" misses the `rm(dir,{recursive:true,force:true})`
// that suites actually write. The call regex takes the `fs.` and `fs.promises.`
// forms as well, which are the most likely way a violating suite names the
// delete. It cannot tell those from a `store.rm(` on an object of the caller's
// own and does not try to; what keeps a domain option such as
// getPublicProfile({ force: true }) out is that no rm call opens the window.
const WINDOW = 200;
const rmCall = /(?<![\w$])(?:\w+\.)*rm(?:Sync)?\(/y;
const forcedOption = /\bforce\s*:\s*true\b/;

// Whether a delete is guarded is a property of the block it is written in, so it
// is read from the structure and not from the text around the call. A window is
// wrong in both directions. Paired with a forward `catch` it passes a delete
// whose own handler is a `finally`, because an unrelated `catch` happens to land
// inside the same window; and it calls a real guard unguarded once the delete
// sits more than `WINDOW` characters from its own `try`. The first direction
// ships a violation and the second manufactures false alarms, which is what
// pressures a contributor towards the exemption list below, so the window goes:
// a delete is guarded exactly when the `try` block that contains it ends in a
// `catch`, however far back that block starts.
const identifier = /[\w$]/;
const space = /\s/;
const afterExpression = /[\w$)\]}]/;
const valueKeyword = new Set([
  "await", "case", "delete", "do", "else", "in", "instanceof", "new", "of", "return",
  "throw", "typeof", "void", "yield",
]);
const controlKeyword = new Set(["for", "if", "switch", "while", "with"]);
const loopKeyword = new Set(["await", "in", "of"]);

// The last code character before `at`, or -1 when there is none.
function lastCodeIndex(code, at) {
  for (let index = at - 1; index >= 0; index -= 1) {
    if (!space.test(code[index])) return index;
  }
  return -1;
}

// The first code character at or after `at`, or the end of the suite.
function nextCodeIndex(code, at) {
  for (let index = at; index < code.length; index += 1) {
    if (!space.test(code[index])) return index;
  }
  return code.length;
}

// The word that ends at `at`, empty when no word does. The masked characters are
// an array while the lexer is still filling them in and a string once it is done,
// and this is the one lookup that has to answer for both.
function wordBefore(code, at) {
  let start = at;
  while (start > 0 && identifier.test(code[start - 1])) start -= 1;
  return Array.isArray(code) ? code.slice(start, at).join("") : code.slice(start, at);
}

// A `/` opens a regex unless something that can end an expression comes first.
// This is the one ambiguity a lexer without a parser has, and it decides both
// whether a later `/` closes a regex and whether what follows it is code.
function startsRegex(chars, at) {
  const previous = lastCodeIndex(chars, at);
  if (previous === -1 || !afterExpression.test(chars[previous])) return true;
  // `return /x/`, `of /x/` and `await /x/` are regexes after all: the word in
  // front of them wants a value rather than an operand.
  return valueKeyword.has(wordBefore(chars, previous + 1));
}

// The index just past a closing quote, or the end of the suite when the literal
// is unterminated.
function quotedEnd(source, at, quote) {
  for (let index = at + 1; index < source.length; index += 1) {
    if (source[index] === "\\") index += 1;
    else if (source[index] === quote) return index + 1;
    else if (source[index] === "\n") break;
  }
  return source.length;
}

// The index just past the closing `/` of a regex, where a backslash escape and a
// character class count as content, so `/\//` and `/[a/]b/` end where they should.
function regexEnd(source, at) {
  let inClass = false;
  for (let index = at + 1; index < source.length; index += 1) {
    const char = source[index];
    if (char === "\\") index += 1;
    else if (char === "[") inClass = true;
    else if (char === "]") inClass = false;
    else if (char === "/" && !inClass) return index + 1;
    else if (char === "\n") break;
  }
  return source.length;
}

// Every comment, string, template and regex body is replaced by a space in place,
// so a brace inside a failure message is not a brace and an offset here is the
// same offset in the suite. A template literal is the one construct that mixes
// text with code, so one stack entry per open template carries the state: the
// text itself, or the brace depth of the substitution it is in, where a `}` at
// depth zero turns the entry back into text. Nothing else is touched: braces are
// what the scan below is reading.
function maskLiterals(source) {
  const chars = source.split("");
  const literals = [];
  const blank = (from, to) => {
    for (let index = from; index < to && index < chars.length; index += 1) chars[index] = " ";
  };
  let at = 0;
  while (at < source.length) {
    const from = at;
    const char = source[at];
    const frame = literals[literals.length - 1];
    const pair = source.slice(at, at + 2);
    if (frame === "template") {
      // Template text is not code, and neither are the delimiters around it.
      if (char === "`") { blank(at, at + 1); literals.pop(); at += 1; continue; }
      if (pair === "${") { blank(at, at + 2); literals[literals.length - 1] = 0; at += 2; continue; }
      if (char === "\\") { blank(at, at + 2); at += 2; continue; }
      blank(at, at + 1);
      at += 1;
      continue;
    }
    if (pair === "//" || pair === "/*") {
      const stop = source.indexOf(pair === "//" ? "\n" : "*/", at + 2);
      at = stop === -1 ? source.length : stop + (pair === "/*" ? 2 : 0);
      blank(from, at);
      continue;
    }
    if (char === '"' || char === "'") {
      at = quotedEnd(source, at, char);
      blank(from, at);
      continue;
    }
    if (char === "`") {
      blank(at, at + 1);
      literals.push("template");
      at += 1;
      continue;
    }
    if (char === "/" && startsRegex(chars, at)) {
      at = regexEnd(source, at);
      blank(from, at);
      continue;
    }
    if (typeof frame === "number") {
      // Inside a substitution every brace is real, so the depth finds the one
      // that ends it and the braces stay for the block scan.
      if (char === "{") literals[literals.length - 1] = frame + 1;
      else if (char === "}" && frame > 0) literals[literals.length - 1] = frame - 1;
      else if (char === "}") { blank(at, at + 1); literals[literals.length - 1] = "template"; }
    }
    at += 1;
  }
  return chars.join("");
}

// What a `{` opens, from the token in front of it. Two of the answers decide the
// result: a `try` is the guard, and a handler or a function body ends the search
// outwards. Everything else - a plain block, an object literal, a type annotation
// - still sits inside the `try` around it.
function blockKind(code, at) {
  const previous = lastCodeIndex(code, at);
  if (previous === -1) return "block";
  const word = wordBefore(code, previous + 1);
  if (word === "try") return "try";
  if (word === "catch" || word === "finally") return "handler";
  if (code[previous] === ">") return code[lastCodeIndex(code, previous)] === "=" ? "body" : "block";
  if (code[previous] === ")") return parenthesesKind(code, previous);
  return "block";
}

// A `{` after a `)` opens a plain block only when the parentheses were a control
// condition. `catch (error) {` is a handler, and `function f() {`, `async () => {`
// and `reset() {` open a body that a `try` outside it does not own.
function parenthesesKind(code, close) {
  let depth = 0;
  let index = close;
  while (index >= 0) {
    if (code[index] === ")") depth += 1;
    else if (code[index] === "(") {
      depth -= 1;
      if (depth === 0) break;
    }
    index -= 1;
  }
  let end = lastCodeIndex(code, index) + 1;
  let word = wordBefore(code, end);
  // `for await (const row of rows) {` reaches its loop through a second word.
  while (loopKeyword.has(word)) {
    end = lastCodeIndex(code, end - word.length) + 1;
    word = wordBefore(code, end);
  }
  if (word === "catch") return "handler";
  return controlKeyword.has(word) ? "block" : "body";
}

// Whether a `catch` is the next token after a block. Comments are already blanked,
// so this only has to step over whitespace.
function catchFollows(code, at) {
  const index = nextCodeIndex(code, at + 1);
  return code.startsWith("catch", index) && !identifier.test(code[index + 5] ?? "");
}

// Whether the delete is guarded: the innermost `try` that contains it has to end
// in a `catch`. The walk stops at a handler or a function body, because a delete
// in a `catch` or a `finally` is not covered by that same try, and a `try` that
// merely surrounds a function does not own the deletes written inside it. Both
// refusals are the safe direction: a delete reported here is one a reader has to
// look at, and one wrongly passed is a violation that ships.
function guardedBy(containing) {
  for (let index = containing.length - 1; index >= 0; index -= 1) {
    const block = containing[index];
    if (block.kind === "block") continue;
    if (block.kind === "try") return block.catches;
    return false;
  }
  return false;
}

// The lines each unguarded forced delete is written on, empty when the suite has
// none. A domain option such as getPublicProfile({ force: true }) never reaches
// this: it is not inside the window of an rm call. One pass records the block
// every brace opens and the blocks every forced delete sits in, so the question
// a delete asks - which block owns it - is answered from the structure, and gets
// the same answer however far away that block starts.
function unguardedDeleteLines(source) {
  const code = maskLiterals(source);
  const open = [];
  const forced = [];
  for (let at = 0; at < code.length; at += 1) {
    if (code[at] === "{") {
      open.push({ kind: blockKind(code, at), catches: false });
    } else if (code[at] === "}") {
      const block = open.pop();
      if (block !== undefined && block.kind === "try") block.catches = catchFollows(code, at);
    } else if (code[at] === "r") {
      rmCall.lastIndex = at;
      if (!rmCall.test(code)) continue;
      if (!forcedOption.test(code.slice(at, at + WINDOW))) continue;
      forced.push({ at, containing: open.slice() });
    }
  }
  return forced
    .filter(({ containing }) => !guardedBy(containing))
    .map(({ at }) => source.slice(0, at).split(/\r?\n/).length);
}

// The suites below force-delete a directory they opened a DatabaseSync into, so
// their cleanup can meet a live handle and the delete has to be best effort. Six
// open that handle in the test body; the other seven reach it through a module
// that caches it for the life of the process, which is what
// sqlite-handle-recovery says its own openers do, and which is why they are held
// to the same rule rather than counted as safe.
const suitesWhoseDeleteNeedsAGuard = [
  "tests/arena-index-sync.test.mjs",
  "tests/average-publication.test.ts",
  "tests/home-showcase-config-api.test.mjs",
  "tests/leaderboard-cli.test.mjs",
  "tests/player-index-sync.test.mjs",
  "tests/pve-index-sync.test.mjs",
  "tests/seasonal-average-buckets.test.ts",
  "tests/seasonal-average-materialize.test.ts",
  "tests/seasonal-average.test.ts",
  "tests/seasonal-cohort.test.ts",
  "tests/seasonal-index-sync.test.mjs",
  "tests/seasonal-progression.test.ts",
  "tests/sqlite-handle-recovery.test.mjs",
];

// The other suites that force-delete a temp directory close every handle, or
// wait for the child process that owns it, before the delete runs: a guard there
// would be unreachable code. Seven of the suites above carry one anyway, so the
// real distinction is not guarded versus unguarded, it is whether a handle can
// still be live at the delete.
const suitesThatCloseTheHandleOrTheProcessFirst = [
  "tests/admin-analytics.test.ts",
  "tests/admin-data-audit.test.mjs",
  "tests/admin-moderation.test.ts",
  "tests/admin-risk-backfill.test.mjs",
  "tests/arena-moderation-isolation.test.ts",
  "tests/arena-profile-sync.test.mjs",
  "tests/deploy-wrapper.test.mjs",
  "tests/leaderboard-publication.test.ts",
  "tests/leaderboard-warmup.test.mjs",
  "tests/profile-mastery.test.ts",
  "tests/profile-queue-wrapper.test.mjs",
  "tests/progression-timeline.test.ts",
  "tests/pve-profile-sync.test.mjs",
  "tests/regular-profile-sync.test.mjs",
  "tests/regular-progression.test.ts",
  "tests/seasonal-profile-sync.test.mjs",
  "tests/seasonal-storage.test.ts",
  "tests/showcase-store.test.mjs",
  "tests/system-metrics.test.ts",
  "tests/tarkov-json-api.test.mjs",
];

// This suite has to leave the handle live at the delete, because reproducing the
// masking is what it is for, so it cannot follow the rule it enforces.
const suitesThatReproduceTheMasking = [
  "tests/cleanup-does-not-mask-assertions.test.mjs",
];

// Between them the two classification lists hold every forced delete the scan
// finds in the suite directories: 18 sites across the 13 suites that need a guard,
// 56 across the 20 that close the handle or the process first, 74 in all, counted
// for this change. The number is a record of the sweep rather than the check. The
// classification test below is what keeps the lists complete, and it never counts
// sites, so a site added later shows up there rather than as a wrong number here.
const classified = new Set([
  ...suitesWhoseDeleteNeedsAGuard,
  ...suitesThatCloseTheHandleOrTheProcessFirst,
  ...suitesThatReproduceTheMasking,
]);

test("every cleanup delete that can meet a live SQLite handle is guarded", () => {
  const unguarded = [];
  for (const name of suitesWhoseDeleteNeedsAGuard) {
    for (const line of unguardedDeleteLines(readFileSync(name, "utf8"))) {
      unguarded.push(`${name}:${line}`);
    }
  }
  assert.deepEqual(unguarded, [],
    "put the delete on one line inside try/catch, as in "
    + "`try { await rm(directory, { recursive: true, force: true }); } catch { }`, "
    + "so a locked database cannot replace a real assertion failure");
});

// A guarded delete and an unguarded one look the same to a scan of the text, so
// a blanket scan over every suite would report a suite that closes the handle on
// the line above the delete, as arena-profile-sync does, next to a real
// violation. What the scan can enforce is classification instead: a suite with a
// forced delete has to say which side it is on. The directories are the two
// `npm test` runs suites from, and a new one has to be added here or it is
// invisible. A walk of the whole tree is not an option: `.next/standalone/tests`
// is a build copy of the same suites. `tests/fixtures` is left out on purpose: it
// holds the shims and JSON that suites import, and readdirSync is not recursive,
// so a suite dropped in there would be run by nothing and seen by nothing. The
// test below says that out loud rather than trusting it.
const suiteDirectories = ["tests", "lib/seasonal"];
const fixtureDirectory = "tests/fixtures";

test("every suite that force-deletes a temp directory is classified", () => {
  const unclassified = [];
  for (const directory of suiteDirectories) {
    for (const name of readdirSync(directory)) {
      if (!/\.test\.(?:mjs|ts)$/.test(name)) continue;
      const suite = `${directory}/${name}`;
      if (classified.has(suite)) continue;
      if (unguardedDeleteLines(readFileSync(suite, "utf8")).length === 0) continue;
      unclassified.push(suite);
    }
  }
  assert.deepEqual(unclassified, [],
    "classify the suite: guard the delete if a handle can be live when it runs, "
    + "or record why no handle can be");
  assert.deepEqual(readdirSync(fixtureDirectory).filter((name) => /\.test\.(?:mjs|ts)$/.test(name)), [],
    `${fixtureDirectory} is a fixture directory, not a suite directory: npm test does not run it, `
    + "and the scan above never looks inside it, so a suite placed there would be invisible");
});
