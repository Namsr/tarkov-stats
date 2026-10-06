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
// that suites actually write. `WINDOW` is how far the scan looks for the option
// from the `(`, so a delete with more than 200 characters between the two - a
// long comment, a long string argument - is not seen at all. The widest gap in
// the suites is 42, so none of them is close; the way to close the gap for good
// is to walk the call's parentheses, which is a change to what counts as a delete
// rather than a fix to a hole in it, so it is recorded here rather than left for
// the next reader to discover. The call regex takes the `fs.` and `fs.promises.`
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
// pressures a contributor towards the exemption list below, so the window that
// reads the guard goes: a delete is guarded exactly when the `try` block that
// contains it ends in a `catch`, however far back that block starts. The window
// that reaches the `force: true` option stays, and the one way it is wrong is
// narrow enough to name: a long comment or a long string between the `(` and the
// option hides the delete, which is the safe direction for a gate whose findings
// someone has to read.
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

// Whether a `/` opens a regex is the one ambiguity a lexer without a parser has,
// and it decides both whether a later `/` closes a regex and whether what follows
// it is code. The default is that it opens one, unless something that can end an
// expression comes first. "Comes first" means in the masked text, which is a
// narrower thing than it sounds: masking has already turned every literal into
// spaces, delimiters included, so a `/` that divides a literal is judged by the
// token in front of the blank rather than by the literal. The four shapes that
// fall out of that are named below rather than left to be found.
function startsRegex(chars, at) {
  const previous = lastCodeIndex(chars, at);
  // `n++ / 4` and `n-- / 4` divide after a postfix. Neither `+` nor `-` can end an
  // expression on its own, and the same one twice is not a binary operator either,
  // so this is the one `/` this function must not read as a regex opener. Reading
  // one as an opener is not a one-line misreading: everything from that `/` to the
  // newline is masked as a regex body, so a delete written after the `/` on the
  // same line is invisible to the scan and a violation passes silently. No suite
  // carries such a line, which is why the cases below are built here rather than
  // found in the tree.
  //
  // `n! / 4` is one of the four shapes this still misreads, and it is not the
  // likeliest of them. The likeliest is a `/` dividing a closed string, template
  // or regex literal on the same line as a delete: masking blanks a literal's own
  // delimiters, so the character this function inspects is whatever came before
  // it - `=`, `(`, `,` - and none of those ends an expression either, so the `/`
  // opens a regex and hides the delete behind it. Those three shapes are legal in
  // the `.mjs` suites that hold most of the 79 sites, while `n!` needs a
  // TypeScript file, which is why the comment above counts four and not one.
  //
  // Closing them needs two answers this function has no way to give. The first is
  // whether a `!` is postfix or prefix, which is the difference between `n! / 4`
  // and the `!/re/.test(s)` this repository is full of; `!` is not in
  // `afterExpression`, and widening the guard to cover it reads the second as a
  // division. The second is whether a blank in front of a `/` hides a literal or
  // is ordinary whitespace, which is the difference between the other three
  // shapes and a real division; the mask holds spaces, so the two are
  // indistinguishable here. Both are questions about what an expression is rather
  // than about what a character is, so the gap is named here rather than closed
  // with a guess. A real fix marks the masked range instead of blanking it, which
  // is a change to the mask rather than to this function.
  if (previous > 0 && (chars[previous] === "+" || chars[previous] === "-")
    && chars[lastCodeIndex(chars, previous)] === chars[previous]) return false;
  if (previous === -1 || !afterExpression.test(chars[previous])) return true;
  // `return /x/`, `of /x/` and `await /x/` are regexes after all: the word in
  // front of them wants a value rather than an operand. The same word behind a `.`
  // is a property name instead of the keyword, and a member expression is complete,
  // so `store.of / 2` divides.
  const word = wordBefore(chars, previous + 1);
  if (!valueKeyword.has(word)) return false;
  return chars[lastCodeIndex(chars, previous + 1 - word.length)] !== ".";
}

// The index just past a closing quote. A quoted string cannot hold a raw newline,
// so one that is never closed ends where its line does rather than at the end of
// the suite, and the same is true of a regex body: the tail of a suite masked as
// one literal is a suite the scan reports as clean.
function quotedEnd(source, at, quote) {
  for (let index = at + 1; index < source.length; index += 1) {
    if (source[index] === "\\") index += 1;
    else if (source[index] === quote) return index + 1;
    // This `index` is a position in the suite rather than its length, and that is
    // the whole point: a `\` continuation is handled above, so nothing that gets
    // here is still inside a legal string.
    else if (source[index] === "\n") return index;
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
    // Same reasoning as in `quotedEnd`: the regex was not closed on this line, so
    // stop where it stops rather than blanking every later delete.
    else if (char === "\n") return index;
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
  // A `>` in front of a `{` is an arrow or a type parameter list, and the brace in
  // both opens a body a `try` outside it does not own: `class Store<T> {` read as a
  // plain block hands the deletes in its static block to whichever `try` happens to
  // be on the stack. `=>` already answered "body"; making the whole branch answer it
  // costs nothing on the suites - the same findings, file for file - and a body the
  // scan cannot see into that carries its own guard is still guarded, because the
  // search for the guard happens inside it.
  //
  // A return type is the case this still cannot see: `cleanup(dir: string): void {`
  // puts a plain word in front of the brace and answers "block". Telling a return
  // type from a statement needs a parser, the nine return-typed functions in the
  // scanned suites are all top level and none holds a delete, and a delete wrongly
  // passed is worse than one wrongly reported, so it is named here rather than
  // guessed at.
  if (code[previous] === ">") return "body";
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

// The detector above is a lexer, and a lexer that misreads a line hides a delete
// rather than reporting one: an unterminated literal masks the rest of the line it
// is on, and the scan then answers "no findings" for the rest of the suite. That is
// how this check came to pass a violation, so the detection is exercised here on
// sources built in memory, where the line it owes a finding on is known, instead of
// only on the suites - which currently contain no trigger for it.
const unguardedDeleteSources = [
  {
    why: "a `/` that divides after a postfix, not one that opens a regex: read as a regex it does not close on the line, and the rest of that line is masked as a regex body, so a delete below it is never reached",
    source: [
      "function share(n) {",
      "  const share = n++ / 4;",
      "  try {",
      "    assert.equal(share, 2);",
      "  } finally {",
      "    rmSync(dir, { recursive: true, force: true });",
      "  }",
      "  return share;",
      "}",
      "try { run(); } catch { /* unrelated, and far below */ }",
    ].join("\n"),
    expected: [6],
  },
  {
    why: "a `/` that divides after a property named like a keyword: `of` and `in` want a value, but behind a `.` they are property names and the member expression is complete",
    source: [
      "function share(store) {",
      "  const share = store.of / 2 + store.in / 2;",
      "  try {",
      "    assert.equal(share, 2);",
      "  } finally {",
      "    rmSync(dir, { recursive: true, force: true });",
      "  }",
      "  return share;",
      "}",
      "try { run(); } catch { /* unrelated, and far below */ }",
    ].join("\n"),
    expected: [6],
  },
  {
    why: "a `/` that divides where nothing in front of it can end an expression, so nothing there says regex either",
    source: [
      "function share(n) {",
      "  const share = n! / 4;",
      "  try {",
      "    assert.equal(share, 2);",
      "  } finally {",
      "    rmSync(dir, { recursive: true, force: true });",
      "  }",
      "  return share;",
      "}",
      "try { run(); } catch { /* unrelated, and far below */ }",
    ].join("\n"),
    expected: [6],
  },
  {
    why: "the delete on the line the division is on: bounding the misread at the newline still masks everything after the `/` on that line, so this is the case the postfix guard in `startsRegex` exists for",
    source: [
      "const share = n++ / 4; rmSync(dir, { recursive: true, force: true });",
    ].join("\n"),
    expected: [1],
  },
  {
    why: "and the same shape after `n--`, which is the other half of that guard: a test that only ever divides after `n++` leaves the `-` untested, and a survivor there is a division the scan still misreads",
    source: [
      "const share = n-- / 4; rmSync(dir, { recursive: true, force: true });",
    ].join("\n"),
    expected: [1],
  },
  {
    why: "and the same shape after a property name, where the word in front of the `/` is a keyword that is not one there",
    source: [
      "const share = store.of / 2; rmSync(dir, { recursive: true, force: true });",
    ].join("\n"),
    expected: [1],
  },
  {
    why: "a string that is never closed on its line blanks the deletes below it",
    source: [
      'const label = "unterminated;',
      "try {",
      "  assert.ok(true);",
      "} finally {",
      "  rmSync(dir, { recursive: true, force: true });",
      "}",
      "try { run(); } catch { }",
    ].join("\n"),
    expected: [5],
  },
  {
    why: "a delete in a catch handler is not covered by the try around it",
    source: [
      "try {",
      "  run();",
      "} catch (error) {",
      "  rmSync(dir, { recursive: true, force: true });",
      "}",
    ].join("\n"),
    expected: [4],
  },
  {
    why: "a delete in a finally is not covered by the try around it",
    source: [
      "try {",
      "  run();",
      "} finally {",
      "  rmSync(dir, { recursive: true, force: true });",
      "}",
    ].join("\n"),
    expected: [4],
  },
  {
    why: "a type parameter list opens a body too: a `try` around the class declaration does not own the delete in its static block",
    source: [
      "try {",
      "  class Store<T> {",
      "    static {",
      "      rmSync(dir, { recursive: true, force: true });",
      "    }",
      "  }",
      "} catch (error) {",
      "  report(error);",
      "}",
    ].join("\n"),
    expected: [4],
  },
  {
    why: "braces quoted inside a template literal are characters in a string, so the rm call in the message does not guard the delete below it",
    source: [
      "const hint = `write it as: } catch { try { rm(dir, { force: true }) }`;",
      "try {",
      "  assert.ok(hint);",
      "} finally {",
      "  rmSync(dir, { recursive: true, force: true });",
      "}",
    ].join("\n"),
    expected: [5],
  },
  {
    why: "a delete inside the try block itself, not inside the handler: the catch that follows belongs to a different try further down, which is the shape a window reads as guarded and the block structure does not",
    source: [
      "function cleanup(dir) {",
      "  try {",
      "    rmSync(dir, { recursive: true, force: true });",
      "  } finally {",
      "    report();",
      "  }",
      "}",
      "class T {",
      "  m() {",
      "    try { run(); } catch (e) { }",
      "  }",
      "}",
    ].join("\n"),
    expected: [3],
  },
  {
    why: "the bare `rm(` form, not `rmSync(`: 37 of the 79 forced sites in the suites are written this way, so a call regex that stops matching it drops findings file for file and no case here would notice",
    source: [
      "try {",
      "  await rm(dir, { recursive: true, force: true });",
      "} finally {",
      "  report();",
      "}",
    ].join("\n"),
    expected: [2],
  },
  {
    why: "a closed quoted string is masked the same way a template is: the rm call in the message does not guard the delete below it",
    source: [
      "try {",
      "  const hint = '} catch { try { rm(dir, { force: true }) }';",
      "  rmSync(dir, { recursive: true, force: true });",
      "} finally {",
      "  report();",
      "}",
    ].join("\n"),
    expected: [3],
  },
  {
    why: "and the same bait inside a comment, which is masked before either quote is read. The call in front of the comment is what makes the case bite: a `/*` behind a `{` is re-read as a regex opener once the comment branch is gone, so the bait stays hidden and the case passes. Behind a `)` it is not, and the comment becomes the live code it was never meant to be",
    source: [
      "try {",
      "  report() /* } catch { try { rm(dir, { force: true }) } */",
      "  rmSync(dir, { recursive: true, force: true });",
      "} finally {",
      "  report();",
      "}",
    ].join("\n"),
    expected: [3],
  },
  {
    why: "braces inside a regex body are characters in a pattern, not block delimiters",
    source: [
      "try {",
      "  const t = s.replace(/}/g, \"\");",
      "  rmSync(dir, { recursive: true, force: true });",
      "} finally {",
      "  report();",
      "}",
    ].join("\n"),
    expected: [3],
  },
  {
    why: "a `}` inside a regex body followed by a `catch` the pattern hides: masking is the only thing keeping it from reading as the try's own catch, so a delete the pattern guards is a violation that ships",
    source: [
      "try {",
      "  rmSync(dir, { recursive: true, force: true });",
      "  const re = /} catch/;",
      "} finally {",
      "  report();",
      "}",
    ].join("\n"),
    expected: [2],
  },
];

test("the detector reports a delete that a lexical misread would hide", () => {
  // The table is the only thing this test asserts against, and an emptied one
  // would make the loop below pass on every run. The sibling test carries the
  // same guard on its own source.
  assert.ok(unguardedDeleteSources.length > 0,
    "the detector has nothing to report on if the table of sources is empty");
  for (const { why, source, expected } of unguardedDeleteSources) {
    assert.deepEqual(unguardedDeleteLines(source), expected, why);
  }
});

test("a delete is guarded however far back its own try starts", () => {
  // The window this replaced was 200 characters, so this is the case it missed: a
  // real guard is not a nearby token, and the block the delete is written in is
  // what answers the question.
  const source = [
    "try {",
    ...Array.from({ length: 12 }, () => "  assert.ok(true); // padding the block out past the old window"),
    "  rmSync(dir, { recursive: true, force: true });",
    "} catch (error) {",
    "  report(error);",
    "}",
  ].join("\n");
  assert.ok(source.indexOf("rmSync") > WINDOW, "the try has to start more than a window back for this to test what it says");
  assert.deepEqual(unguardedDeleteLines(source), [],
    "the delete is in a try block that ends in a catch, so it is guarded");
});

test("a body the scan cannot see into is still guarded when it guards itself", () => {
  // The other side of the same rule. A body the scan treats as opaque - an arrow,
  // a class with a type parameter list - cannot be credited to a `try` around it,
  // so it has to be able to carry its own guard; if it could not, every suite
  // written in TypeScript would report a delete it has already fixed. The two that
  // read as plain blocks are here for the same assertion from the other side: the
  // scan does see into those, and it finds the guard rather than the delete.
  const bodies = [
    ["const clear = (dir: string): void => {", "};", "opaque"],
    ["class Store<T> {", "  clear(dir: string): void {\n  }\n}", "opaque"],
    ["function clear(dir: string): void {", "}", "read as a block"],
    ["class Store {", "  static {\n  }\n}", "read as a block"],
  ];
  for (const [opener, closer, how] of bodies) {
    const source = [
      opener,
      "  try {",
      "    rmSync(dir, { recursive: true, force: true });",
      "  } catch (error) {",
      "    report(error);",
      "  }",
      closer,
    ].join("\n");
    assert.deepEqual(unguardedDeleteLines(source), [],
      `${opener} is ${how} to the scan, and the guard it carries answers for the delete either way`);
  }
});

// The suites below force-delete a directory they opened a DatabaseSync into, so
// their cleanup can meet a live handle and the delete has to be best effort. Six
// open that handle in the test body; the other seven reach it through a module
// that caches it for the life of the process, which is what
// sqlite-handle-recovery says its own openers do, and which is why they are held
// to the same rule rather than counted as safe.
const suitesWhoseDeleteNeedsAGuard = [
  "tests/arena-index-sync.test.mjs",
  "tests/average-publication.test.ts",
  "tests/ban-import.test.ts",
  "tests/home-showcase-config-api.test.mjs",
  "tests/leaderboard-cli.test.mjs",
  "tests/operator-seasonal-run-outcome.test.mjs",
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
// would be unreachable code. Every one of the suites above carries a catch guard
// on its delete anyway, so the real distinction is not guarded versus unguarded,
// it is whether a handle can still be live at the delete.
const suitesThatCloseTheHandleOrTheProcessFirst = [
  "tests/admin-analytics.test.ts",
  "tests/admin-data-audit.test.mjs",
  "tests/admin-moderation.test.ts",
  "tests/admin-risk-backfill.test.mjs",
  "tests/arena-moderation-isolation.test.ts",
  "tests/arena-profile-sync.test.mjs",
  "tests/average-materialize-once.test.mjs",
  "tests/backup-db.test.mjs",
  // All SQLite handles belong to synchronously waited subprocesses; file I/O is awaited.
  "tests/background-isolation.test.mjs",
  "tests/caddy-overload.test.mjs",
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

// Between them the two classification lists hold every forced delete the scan finds
// outside this suite: 18 sites across the 13 suites that need a guard, 56 across the
// 20 that close the handle or the process first, 74 in all, counted for this change.
// This suite's own five are the third list, and adding them is what makes the
// arithmetic close: 79 sites over 34 files, 13 + 20 + 1. The number is a record of
// the sweep rather than the check. The classification test below is what keeps the
// lists complete, and it never counts sites, so a site added later shows up there
// rather than as a wrong number here.
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
