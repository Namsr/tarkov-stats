import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      return { shortCircuit: true, url: pathToFileURL(resolve(`${specifier.slice(2)}.ts`)).href };
    }
    // The seasonal openers import their siblings without an extension, which the
    // bundler resolves but the ESM resolver does not.
    if (/^\.{1,2}\//.test(specifier) && !/\.[cm]?[jt]sx?$/.test(specifier)) {
      return { shortCircuit: true, url: new URL(`${specifier}.ts`, context.parentURL).href };
    }
    return nextResolve(specifier, context);
  },
});

const directory = mkdtempSync(join(tmpdir(), "sqlite-handle-recovery-"));
const playersPath = join(directory, "players.db");
const progressionPath = join(directory, "progression.db");
const helperProgressionPath = join(directory, "helper-progression.db");
const leaderboardPath = join(directory, "leaderboards.db");
const bansPath = join(directory, "bans.db");
const adminPath = join(directory, "admin.db");

// Every opener under test reads its path at call time, so each case gets its own
// file. Sharing one would let a poisoned handle left cached by an earlier case
// decide a later case's outcome.
const environment = {
  SQLITE_PATH: playersPath,
  PROGRESSION_SQLITE_PATH: progressionPath,
  LEADERBOARD_SQLITE_PATH: leaderboardPath,
  BANS_SQLITE_PATH: bansPath,
  REPORTS_SQLITE_PATH: join(directory, "community-reports.db"),
  ADMIN_ANALYTICS_SQLITE_PATH: adminPath,
};
const previousEnvironment = Object.fromEntries(
  Object.keys(environment).map((key) => [key, process.env[key]]),
);
Object.assign(process.env, environment);

const { getArenaBackend } = await import("../lib/db.ts");
const { getSeasonalStore } = await import("../lib/seasonal/storage.ts");
const { getHelperStore } = await import("../lib/seasonal/helper-storage.ts");
const { openLeaderboardDatabase } = await import("../lib/leaderboard/publication.ts");
const { getBanStore } = await import("../lib/ban-db.ts");
const { getModerationStore } = await import("../lib/admin/moderation-db.ts");
const { getProgressionStore } = await import("../lib/progression-db.ts");
const { prepareLeaderboardCandidate, resetLeaderboardRuntimeForTests } = await import("../lib/leaderboard/runtime.ts");
const { LEADERBOARD_METRIC_VERSION } = await import("../lib/leaderboard/ranking.ts");

test.after(() => {
  for (const [key, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  // The directories are left behind: the openers cache their handle for the life
  // of the process, and Windows refuses to delete an open database file.
});

// A file that is not a SQLite database: the constructor opens it lazily, so the
// handle is created and the failure lands in the schema initialization instead.
function poison(path) {
  writeFileSync(path, "this is not a sqlite database");
}

// Windows keeps a leaked poisoned handle locked, so replacing the file can fail
// with EPERM even where the opener is correct. Swallow the unlink failure so the
// assertion after it reports the real defect, a handle that never recovered,
// instead of the locked file.
function replace(path) {
  try {
    rmSync(path, { force: true });
  } catch {
    /* still locked: the retry is expected to keep failing */
  }
}

function useEnvironment(overrides) {
  const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

test("the player database opener retries initialization instead of serving a poisoned handle", async () => {
  poison(playersPath);
  assert.equal(await getArenaBackend(), null, "a failed schema init reports unavailable");

  replace(playersPath);
  const backend = await getArenaBackend();
  assert.ok(backend, "the next call reopens and initializes the database");
  const tables = backend.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => row.name);
  assert.ok(tables.includes("arena_mode_stats"), "the arena schema was applied on the retry");
  assert.ok(tables.includes("players"), "the player schema was applied on the retry");
});

test("the seasonal store opener retries initialization instead of serving a poisoned handle", async () => {
  poison(progressionPath);
  assert.equal(await getSeasonalStore(), null, "a failed schema init reports unavailable");

  replace(progressionPath);
  const store = await getSeasonalStore();
  assert.ok(store, "the next call reopens and initializes the database");
  assert.deepEqual(await store.getCycle("cycle-missing"), null, "the seasonal schema is queryable");
});

test("the leaderboard publication opener retries initialization instead of serving a poisoned handle", async () => {
  poison(leaderboardPath);
  await assert.rejects(() => openLeaderboardDatabase(), "a failed schema init is reported");

  replace(leaderboardPath);
  const db = await openLeaderboardDatabase();
  assert.ok(db, "the next call reopens and initializes the database");
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => row.name);
  assert.ok(tables.includes("leaderboard_current"), "the leaderboard schema was applied on the retry");
});

test("the seasonal helper store opener retries initialization instead of serving a poisoned handle", async () => {
  const restore = useEnvironment({ PROGRESSION_SQLITE_PATH: helperProgressionPath });
  try {
    poison(helperProgressionPath);
    assert.equal(await getHelperStore(), null, "a failed schema init reports unavailable");

    replace(helperProgressionPath);
    const store = await getHelperStore();
    assert.ok(store, "the next call reopens and initializes the database");
    store.touchSession("helper-recovery");
    assert.ok(store.getSession("helper-recovery"), "the helper schema was applied on the retry");
  } finally {
    restore();
  }
});

test("the ban store opener retries initialization instead of serving a poisoned handle", async () => {
  poison(bansPath);
  assert.equal(await getBanStore(), null, "a failed schema init reports unavailable");

  replace(bansPath);
  const store = await getBanStore();
  assert.ok(store, "the next call reopens and initializes the database");
  assert.equal(await store.isBanned(1), false, "the ban schema was applied on the retry");
});

test("the moderation store opener retries initialization instead of serving a poisoned handle", async () => {
  // The moderation store attaches the ban, player, progression and report
  // databases, so give this case its own copies and leave the other cases alone.
  const restore = useEnvironment({
    BANS_SQLITE_PATH: join(directory, "moderation-bans.db"),
    REPORTS_SQLITE_PATH: join(directory, "moderation-reports.db"),
    SQLITE_PATH: join(directory, "moderation-players.db"),
    PROGRESSION_SQLITE_PATH: join(directory, "moderation-progression.db"),
  });
  try {
    poison(adminPath);
    await assert.rejects(() => getModerationStore(), "a failed schema init is reported");

    replace(adminPath);
    const store = await getModerationStore();
    assert.ok(store, "the next call reopens and initializes the database");
    store.saveRisk({
      aid: 12345, mode: "regular", cycleId: "", score: 40, tier: "medium",
      factors: [], scoreVersion: 1, profileUpdatedAt: 1, evaluatedAt: 1,
    });
    assert.equal(store.riskFor({ aid: 12345, mode: "regular", cycleId: "" })?.aid, 12345,
      "the moderation schema was applied on the retry");
  } finally {
    restore();
  }
});

test("the progression store opener closes a handle whose initialization failed", async () => {
  // This store is asked for on every player profile request, so a handle left
  // open here is a leaked descriptor per request until the process hits EMFILE.
  const storeProgressionPath = join(directory, "progression-store.db");
  const restore = useEnvironment({
    PROGRESSION_SQLITE_PATH: storeProgressionPath,
    SQLITE_PATH: join(directory, "progression-store-players.db"),
  });
  try {
    poison(storeProgressionPath);
    // A poisoned database still reports unavailable whether its handle was closed
    // or leaked, so the leak has to be counted rather than inferred from the
    // return value. The openers reach node:sqlite through the same module this
    // file imports, so patching the prototype sees every handle they construct.
    // That keeps the real namespace intact for every other import, and it needs
    // no hook for a version the documentation does not promise.
    const { close, exec, prepare } = DatabaseSync.prototype;
    const seen = new WeakSet();
    const opened = [];
    const closed = [];
    const track = (handle) => {
      if (!seen.has(handle)) {
        seen.add(handle);
        opened.push(handle);
      }
    };
    // Any statement marks the handle live, so the open count does not depend on
    // which of the two the opener happens to reach first.
    DatabaseSync.prototype.close = function (...args) {
      closed.push(this);
      return close.apply(this, args);
    };
    DatabaseSync.prototype.exec = function (...args) {
      track(this);
      return exec.apply(this, args);
    };
    DatabaseSync.prototype.prepare = function (...args) {
      track(this);
      return prepare.apply(this, args);
    };
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        assert.equal(await getProgressionStore("regular"), null, "a failed schema init reports unavailable");
      }
      assert.equal(opened.length, 3, "each attempt opens a handle, the failed one being left uncached");
      assert.equal(closed.length, opened.length, "every handle a failed initialization opened is closed again");
    } finally {
      DatabaseSync.prototype.close = close;
      DatabaseSync.prototype.exec = exec;
      DatabaseSync.prototype.prepare = prepare;
    }

    replace(storeProgressionPath);
    const store = await getProgressionStore("regular");
    assert.ok(store, "the next call reopens and initializes the database");
    assert.equal(await store.latest(1), null, "the progression schema is queryable on the retry");
  } finally {
    restore();
  }
});

test("the leaderboard runtime source opener closes a handle whose player attach failed", async () => {
  // The runtime source opener reads both paths at call time and caches the handle
  // for the life of the process, so this case owns its own pair of files and
  // leaves every other case alone.
  const runtimeProgressionPath = join(directory, "runtime-progression.db");
  const runtimePlayersPath = join(directory, "runtime-players.db");
  const restore = useEnvironment({
    SQLITE_PATH: runtimePlayersPath,
    PROGRESSION_SQLITE_PATH: runtimeProgressionPath,
  });
  new DatabaseSync(runtimeProgressionPath).close();
  poison(runtimePlayersPath);
  // The library loads node:sqlite dynamically, which yields this same class
  // object, so wrapping the prototype counts the handles the opener closes.
  const nativeClose = DatabaseSync.prototype.close;
  let closed = 0;
  DatabaseSync.prototype.close = function countedClose(...args) {
    closed += 1;
    return nativeClose.apply(this, args);
  };
  // A pvp-season scope with no cycle still attaches the player database but
  // stops before reading a table, so the case needs no schema on either file.
  const config = {
    scope: "seasonal:recovery", mode: "pvp-season", arenaMode: null, cycleId: null,
    primaryMetric: "performance", minimumSample: 6, activityCutoffMs: 1,
    arpSeasonId: null, arpSourceConfirmed: false,
  };
  const reader = {
    snapshot: () => ({ generation: 1, generatedAt: 2, params: { metricVersion: LEADERBOARD_METRIC_VERSION } }),
  };
  try {
    await assert.rejects(
      () => prepareLeaderboardCandidate(reader, config, 1),
      "a failed player attach is reported",
    );
    assert.equal(closed, 1, "the source handle is closed when its attach fails");

    await assert.rejects(
      () => prepareLeaderboardCandidate(reader, config, 1),
      "the retry reports the failure again",
    );
    assert.equal(closed, 2, "the retry closes its own handle instead of reusing the failed one");

    replace(runtimePlayersPath);
    new DatabaseSync(runtimePlayersPath).close();
    assert.deepEqual(await prepareLeaderboardCandidate(reader, config, 1),
      { generation: 1, generatedAt: 2, candidate: null },
      "the next call reopens and attaches the player database");
  } finally {
    DatabaseSync.prototype.close = nativeClose;
    resetLeaderboardRuntimeForTests();
    restore();
  }
});
