import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

// A collector cut off by systemd leaves a torn round: no SUMMARY line, no
// `stopped` reason, no coverage report, and the next hour repeats the work. The
// run budget in the collector script and the TimeoutStartSec window in the unit
// are two numbers in two files, and only the operator joining them keeps them
// honest. A unit that passes no budget falls back to the collector default, so
// the tests below read both sides and fail when they stop fitting together.

const UNITS_DIR = "ops/systemd";
const SYNC_UNIT = /(sync|queue)\.service$/;

// Past the budget checkpoint the collector still has to unwind: close SQLite,
// drop its lease row, write the SUMMARY, and the writer lock is only free once
// that is done. Two minutes is the reserve for one unwind, and it is spent in
// both directions: a holder keeps the lock while it spends its budget and
// unwinds, and a waiter has to fit its own unwind after the wait. It is a
// reserve, not a measurement - the work is local SQLite on the data volume,
// which is seconds in practice, but the repository holds no timing for it. The
// units below sit against this reserve with no slack of their own, so an unwind
// slower than two minutes is the one failure mode these tests would not catch.
const MIN_EXIT_MARGIN_MS = 120_000;

// Units that start a wrapper instead of a collector. The wrapper owns its own
// budgets (ops/profile-queue.sh) under a deliberately unbounded window; nothing
// here pins that TimeoutStartSec=infinity or the 3300s deadline, and
// tests/profile-queue-wrapper.test.mjs covers the ladder itself, not the unit.
const WRAPPER_UNITS = ["tarkovstats-profile-queue.service"];

// Units whose collector declares a run budget, so the unit has to state one.
// Every unit in the directory has to land in exactly one of the three lists
// below, which is the moment to decide what its window and its budget are.
const BUDGETED_UNITS = [
  "tarkovstats-arena-profile-sync.service",
  "tarkovstats-pve-profile-sync.service",
  "tarkovstats-regular-profile-sync.service",
  "tarkovstats-seasonal-profile-sync.service",
];

// The daily index collectors carry no run budget at all, so their 14h window is
// a backstop against a hang rather than a schedule to fit a budget into. They are
// listed so that giving one of them a budget is a change somebody has to make on
// purpose, here and in the unit.
const UNBUDGETED_UNITS = [
  "tarkovstats-arena-index-sync.service",
  "tarkovstats-player-index-sync.service",
  "tarkovstats-pve-index-sync.service",
  "tarkovstats-seasonal-index-sync.service",
];

// systemd time spans, per systemd.time(7). `infinity` and `0` never expire.
const DURATION_UNIT_MS = {
  us: 1e-3, usec: 1e-3, "µs": 1e-3, ms: 1, msec: 1,
  s: 1000, sec: 1000, second: 1000, seconds: 1000,
  m: 60_000, min: 60_000, minute: 60_000, minutes: 60_000,
  h: 3_600_000, hr: 3_600_000, hour: 3_600_000, hours: 3_600_000,
  d: 86_400_000, day: 86_400_000, days: 86_400_000,
  w: 604_800_000, week: 604_800_000, weeks: 604_800_000,
};
const DURATION_TERM = /^(\d+(?:\.\d+)?)(usec|us|µs|ms|msec|seconds|second|sec|s|minutes|minute|min|m|hours|hour|hr|h|days|day|d|weeks|week|w)$/;

function parseDurationMs(value) {
  const text = String(value).trim();
  if (text === "infinity" || text === "0") return Infinity;
  let total = 0;
  for (const term of text.split(/\s+/)) {
    const match = DURATION_TERM.exec(term);
    assert.ok(match, `unsupported TimeoutStartSec term "${term}" in "${text}"`);
    total += Number(match[1]) * DURATION_UNIT_MS[match[2]];
  }
  assert.ok(total > 0, `TimeoutStartSec="${text}" is not a positive span`);
  return total;
}

// Budget defaults are written as `50 * 60_000`. Only that arithmetic is
// evaluated, so a rewritten default can never smuggle code into this file.
function evaluateMilliseconds(expression) {
  const tokens = expression.match(/\d[\d_]*|[()+*]/g) ?? [];
  assert.equal(tokens.join(""), expression.replace(/\s+/g, ""), `unsupported budget expression: ${expression}`);
  let index = 0;
  const term = () => {
    if (tokens[index] === "(") {
      index += 1;
      const inner = sum();
      assert.equal(tokens[index++], ")", `unbalanced parentheses in ${expression}`);
      return inner;
    }
    const token = tokens[index++];
    assert.match(String(token), /^\d[\d_]*$/, `unsupported budget operand in ${expression}`);
    return Number(String(token).replaceAll("_", ""));
  };
  const product = () => {
    let value = term();
    while (tokens[index] === "*") { index += 1; value *= term(); }
    return value;
  };
  const sum = () => {
    let value = product();
    while (tokens[index] === "+") { index += 1; value += product(); }
    return value;
  };
  const total = sum();
  assert.equal(index, tokens.length, `trailing tokens in ${expression}`);
  assert.ok(Number.isInteger(total), `budget expression is not whole milliseconds: ${expression}`);
  return total;
}

// The collector's own contract: which variable carries the run budget, what the
// fallback is when the unit passes nothing, and the range `envInteger` accepts.
// It throws outside that range, so a value the collector would refuse is a boot
// failure, not a clamped run.
function collectorBudget(source) {
  const match = /maxRunMs:\s*envInteger\(\s*"([A-Z0-9_]+)"\s*,\s*([^,]+),\s*([^,]+),\s*([^,)]+)/.exec(source);
  if (!match) return null;
  return {
    name: match[1],
    defaultMs: evaluateMilliseconds(match[2]),
    floorMs: evaluateMilliseconds(match[3]),
    capMs: evaluateMilliseconds(match[4]),
  };
}

function unitDirective(unit, name) {
  // A long command is continued with a trailing backslash; join it back so a
  // value split across lines is read as one value instead of half of one.
  const source = unit.source.replace(/\\\r?\n\s*/g, " ");
  const matches = [...source.matchAll(new RegExp(`^${name}=(.+)$`, "gm"))];
  // Exactly one, so a drop-in that appends a second TimeoutStartSec shows up as
  // a deployment problem instead of being silently ignored or silently preferred.
  assert.equal(matches.length, 1, `${unit.name} sets ${name} more than once`);
  return matches[0][1].trim();
}

// Only `docker compose exec -e` carries a run budget from a unit: the compose
// service declares no environment block, so a unit-level Environment= stops at
// the docker CLI and never reaches the collector.
function execEnvironment(execStart) {
  const values = new Map();
  for (const [, name, value] of execStart.matchAll(/(?:^|\s)-e\s+([A-Z0-9_]+)=(\S+)/g)) values.set(name, value);
  return values;
}

// `flock -n` skips the run when another writer holds the lock; a bare `flock`
// waits for it, and TimeoutStartSec keeps running while it waits. Null when the
// unit never takes the writer lock.
function writerLockMode(execStart) {
  const match = /\/usr\/bin\/flock\s+(-n\s+)?\/run\/tarkovstats-data-sync\.lock/.exec(execStart);
  if (!match) return null;
  assert.equal(match.index, execStart.indexOf("/usr/bin/flock"),
    "the data-sync lock is no longer the first flock on the ExecStart line");
  return match[1] ? "skips" : "waits";
}

// The timer field is what turns "these units share a lock" into arithmetic: the
// distance from one unit's tick to the next is how long it may be held. A `*`
// hour means every hour at that minute, and the daily cycle below only needs the
// minute of for. A weekday restriction would break that cycle - Friday to Monday
// is not 5 minutes - so it is refused rather than modelled wrong.
function tickMinuteOfDay(calendar) {
  const fields = calendar.trim().split(/\s+/);
  if (/^(hourly|daily)$/.test(fields[0])) return 0;
  assert.ok(!fields.some((field) => /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)/.test(field)),
    `OnCalendar=${calendar} restricts days of the week, which the daily lock cycle in this file cannot represent`);
  const clock = fields.map((field) => /^(?:\*|\d{1,2}):(\d{2})/.exec(field)).find(Boolean);
  assert.ok(clock, `unsupported OnCalendar=${calendar}: no HH:MM or *:MM field`);
  const hours = clock[0].split(":")[0];
  return (hours === "*" ? 0 : Number(hours)) * 60 + Number(clock[1]);
}

async function readSyncUnits() {
  const names = (await readdir(UNITS_DIR)).filter((name) => SYNC_UNIT.test(name)).sort();
  assert.ok(names.length > 0, `no *-sync.service or *-queue.service unit found in ${UNITS_DIR}`);
  return Promise.all(names.map(async (name) => {
    const source = await readFile(path.join(UNITS_DIR, name), "utf8");
    const unit = { name, source };
    const windowText = unitDirective(unit, "TimeoutStartSec");
    const execStart = unitDirective(unit, "ExecStart");
    const collector = /scripts\/[\w.-]+\.mjs/.exec(execStart);
    const script = collector ? path.basename(collector[0]) : null;
    const budget = script ? collectorBudget(await readFile(path.join("scripts", script), "utf8")) : null;
    // The tick is what turns "these units share a lock" into arithmetic: the
    // distance from one unit's tick to the next is how long it may be held.
    const timerName = name.replace(/\.service$/, ".timer");
    const calendar = /^OnCalendar=(.+)$/m.exec(await readFile(path.join(UNITS_DIR, timerName), "utf8"));
    assert.ok(calendar, `${timerName} has no OnCalendar=`);
    const declaredBudget = budget ? execEnvironment(execStart).get(budget.name) : undefined;
    return {
      name,
      source,
      script,
      budget,
      declaredBudget,
      budgetMs: declaredBudget === undefined ? null : Number(declaredBudget),
      windowText,
      windowMs: parseDurationMs(windowText),
      execStart,
      lockMode: writerLockMode(execStart),
      tick: tickMinuteOfDay(calendar[1]),
    };
  }));
}

const describeMs = (ms) => `${ms} ms (${(ms / 60_000).toFixed(2)} min)`;
const at = (tick) => `:${String(tick % 60).padStart(2, "0")}`;

test("every timer-driven sync unit leaves its collector room to stop inside TimeoutStartSec", async () => {
  const units = await readSyncUnits();
  const budgeted = [];
  const unbudgeted = [];
  const wrappers = [];
  // Reported together: an operator applying units wants the whole list of gaps
  // in one pass, not the first one found.
  const problems = [];

  for (const { name, script, budget, declaredBudget, budgetMs, windowText, windowMs, source } of units) {
    if (!script) {
      // A wrapper owns its own budgets, which is a decision somebody has to
      // write down rather than something this file can infer.
      wrappers.push(name);
      continue;
    }
    if (!budget) {
      unbudgeted.push(name);
      continue;
    }

    budgeted.push(name);
    if (/^Environment=[A-Z0-9_]*(?:MAX_RUN_MS|DEADLINE_MS)/m.test(source)) problems.push(
      `${name} states a run budget with Environment=: the compose service passes no environment, so the collector would never see it. Pass it as \`-e ${budget.name}=...\` on the ExecStart line`);

    if (declaredBudget === undefined) {
      const fits = budget.defaultMs + MIN_EXIT_MARGIN_MS <= windowMs;
      problems.push(
        `${name} starts ${script} without -e ${budget.name}=..., so the collector falls back to its default of ${describeMs(budget.defaultMs)}` +
        (fits
          ? `; that default happens to fit TimeoutStartSec=${windowText}, but a unit that leans on a collector default states no budget of its own`
          : ` and TimeoutStartSec=${windowText} cuts the run off before that budget`));
      continue;
    }
    if (!Number.isInteger(budgetMs)) {
      problems.push(`${name} passes ${budget.name}=${declaredBudget}, which is not a whole number of milliseconds`);
    } else if (budgetMs < budget.floorMs || budgetMs > budget.capMs) {
      problems.push(`${name} passes ${budget.name}=${budgetMs}, outside the ${describeMs(budget.floorMs)}-${describeMs(budget.capMs)} range scripts/${script} accepts: envInteger throws and the run dies at boot`);
    } else if (budgetMs + MIN_EXIT_MARGIN_MS > windowMs) {
      problems.push(`${name} leaves ${budget.name}=${describeMs(budgetMs)} inside a TimeoutStartSec of ${describeMs(windowMs)}: the collector is killed mid-round instead of stopping itself and reporting it. Budget + ${describeMs(MIN_EXIT_MARGIN_MS)} of headroom has to fit`);
    }
  }

  // Every unit has to be classified, so a new one cannot be added without a
  // decision, and a parser that stops matching cannot pass by checking nothing:
  // the feed units would move out of `budgeted` and out of `unbudgeted` at once.
  assert.deepEqual(budgeted.sort(), [...BUDGETED_UNITS].sort(),
    "the set of sync units that carry a run budget changed: give the new unit a budget and a window, or say here why it has none");
  assert.deepEqual(unbudgeted.sort(), [...UNBUDGETED_UNITS].sort(),
    "the set of sync units whose collector carries no run budget changed: an index collector that grows a budget has to state it in its unit");
  assert.deepEqual(wrappers.sort(), [...WRAPPER_UNITS].sort(),
    "the set of units that start a wrapper instead of a collector changed: say here why the wrapper needs no budget of its own");
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("a sync unit does not claim more run budget than the hourly queue gives the same mode", async () => {
  // Enabling a timer must not put a mode on a larger budget than the one that
  // already runs it every hour in production. A unit may claim a smaller one:
  // its window is 14m, while the queue runs four modes inside one shared 3300s
  // deadline. This pins the run budget the two paths share, not their whole
  // configuration - the queue also pins concurrency and RPS that units do not.
  const queue = await readFile("ops/profile-queue.sh", "utf8");
  const queueBudgets = new Map();
  for (const [, line] of queue.matchAll(/^(run_mode \w+ .*)$/gm)) {
    for (const [, name, value] of line.matchAll(/-e ([A-Z0-9_]+)=(\d+)/g)) queueBudgets.set(name, Number(value));
  }
  assert.ok(queueBudgets.size > 0, "ops/profile-queue.sh no longer passes a run budget with `run_mode ... -e`");

  const problems = [];
  for (const { name, script, budget, budgetMs } of (await readSyncUnits()).filter((unit) => unit.budget)) {
    const queued = queueBudgets.get(budget.name);
    if (queued === undefined) {
      problems.push(`${name} runs ${script} with ${budget.name}, which ops/profile-queue.sh no longer passes to the same mode: the two paths drift apart without a test noticing`);
      continue;
    }
    if (budgetMs > queued) {
      problems.push(`${name} runs ${script} with ${budget.name}=${budgetMs} while ops/profile-queue.sh gives the same mode ${queued}`);
    }
  }
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("a unit that waits for the writer lock still has window left to finish", async () => {
  // The feed units share one writer lock and their timers sit minutes apart, and
  // TimeoutStartSec covers the whole ExecStart, lock wait included. A unit that
  // waits therefore has to fit `wait + budget + unwind` inside its own window.
  // The wait is whatever the earlier run can still be holding, and a run keeps
  // the lock past its budget: the collector unwinds before it exits. So a holder
  // holds `budget + unwind`, capped by its own window, and only a unit that takes
  // a bare flock pays the wait term - a `-n` unit skips instead.
  //
  // Both sides of the sum are unit configuration. An unbudgeted unit has no
  // number to schedule against - its 14h window is a hang backstop, and that is
  // exactly the number a waiter would sit behind, so the daily index sweeps and
  // the profile-queue wrapper (which holds the lock for its own 3300s deadline
  // while running these same modes) are separate questions from whether a feed
  // unit's budget fits its window. Neither depends on the values checked here.
  const units = (await readSyncUnits()).filter((unit) => unit.budget);
  assert.ok(units.length > 1, "expected more than one budgeted sync unit to compare");
  assert.ok(units.some((unit) => unit.lockMode === "waits"), "no unit waits on the writer lock: the grid is not being exercised");
  // A unit with no stated budget holds nothing on paper; test one reports that
  // separately, and here it would otherwise vanish from the comparison silently.
  assert.ok(units.every((unit) => Number.isInteger(unit.budgetMs)),
    `units in the lock grid that state no run budget: ${units.filter((unit) => !Number.isInteger(unit.budgetMs)).map((unit) => unit.name).join(", ")}`);

  const problems = [];
  for (const holder of units) {
    const heldMs = holder.lockMode === null || !Number.isInteger(holder.budgetMs)
      ? 0
      : Math.min(holder.windowMs, holder.budgetMs + MIN_EXIT_MARGIN_MS);
    for (const waiter of units) {
      if (waiter === holder || waiter.lockMode !== "waits") continue;
      // Forward distance between the two ticks on the daily cycle, so a run that
      // ends before the next tick contributes no wait at all.
      const gapMs = ((waiter.tick - holder.tick + 1440) % 1440) * 60_000;
      const waitMs = Math.max(0, heldMs - gapMs);
      const neededMs = waitMs + waiter.budgetMs + MIN_EXIT_MARGIN_MS;
      if (neededMs > waiter.windowMs) {
        problems.push(
          `${waiter.name} starts at ${at(waiter.tick)} and waits on the writer lock, while ${holder.name} at ${at(holder.tick)} can hold it for ${describeMs(heldMs)}: that is ${describeMs(waitMs)} of waiting, and wait + ${waiter.budget.name}=${describeMs(waiter.budgetMs)} + ${describeMs(MIN_EXIT_MARGIN_MS)} of unwind does not fit ${waiter.name}'s TimeoutStartSec=${describeMs(waiter.windowMs)}`);
      }
    }
  }
  assert.deepEqual(problems, [], problems.join("\n"));
});
