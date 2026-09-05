import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
// @ts-expect-error node:sqlite types require a newer @types/node than the app uses.
const { DatabaseSync } = await import("node:sqlite");
// @ts-expect-error Node's direct TypeScript runner needs the explicit extension.
const publication = await import("../lib/leaderboard/publication.ts");
// @ts-expect-error Node's direct TypeScript runner needs the explicit extension.
const { createLeaderboardReader } = await import("../lib/leaderboard/service.ts");
// @ts-expect-error Node's direct TypeScript runner needs the explicit extension.
const { materializeCandidate } = await import("../lib/leaderboard/materialize.ts");

const db = new DatabaseSync(":memory:");
db.exec("CREATE TABLE excluded_players(aid INTEGER PRIMARY KEY)");
publication.initializeLeaderboardSchema(db);

const config = { scope: "regular", mode: "regular" as const, arenaMode: null, cycleId: null,
  primaryMetric: "performance" as const, minimumSample: 6, activityCutoffMs: 100,
  arpSeasonId: null, arpSourceConfirmed: false };
const formula = { kdWeight: .7, killsPerMatchWeight: .3, smoothing: 20,
  referenceKillsPerMatch: 1, referenceDeathsPerMatch: .5 };
const source = (aid: number, kills = 121 - aid, activityAt = 101) => ({
  aid, nickname: `P${aid}`, sourceUpdatedAt: 1, parserVersion: 0, activityAt,
  activitySource: "skill" as const, matches: 20, kills, deaths: 10, hours: aid,
  currentArp: null, bestArp: null,
});

function generation(rows = [...Array.from({ length: 119 }, (_, index) => source(index + 1)),
  { ...source(120), matches: 2 }]) {
  const candidates = rows.map((row) => materializeCandidate(row, { config, formula }));
  return { members: candidates.map((item) => item.member), orders: candidates.flatMap((item) => item.orders) };
}

test("publication assigns stable ordinals, swaps atomically, and keeps the previous generation on failure", () => {
  const first = generation();
  publication.publishLeaderboardScope(db, config.scope, { formulaVersion: 1, params: { ...config, formula }, meta: {} },
    first.members, first.orders, 90, 100);
  const current = db.prepare("SELECT generation FROM leaderboard_current WHERE scope='regular'").get().generation;
  assert.equal(db.prepare("SELECT ordinal FROM leaderboard_order WHERE sort='primary' AND aid=1").get().ordinal, 1);
  db.exec(`CREATE TRIGGER fail_leaderboard_order BEFORE INSERT ON leaderboard_order
    WHEN NEW.aid=999 BEGIN SELECT RAISE(ABORT,'fixture failure'); END`);
  const failed = generation([source(999)]);
  assert.throws(() => publication.publishLeaderboardScope(db, config.scope,
    { formulaVersion: 1, params: { ...config, formula }, meta: {} }, failed.members, failed.orders, 101, 102));
  assert.equal(db.prepare("SELECT generation FROM leaderboard_current WHERE scope='regular'").get().generation, current);
  assert.equal(db.prepare("SELECT 1 FROM temp.sqlite_temp_master WHERE name='leaderboard_rank_work'").get(), undefined);
  db.exec("DROP TRIGGER fail_leaderboard_order");
});

test("live bans compress ranks and focused view keeps two independent 100-row lists", () => {
  db.exec("INSERT INTO excluded_players VALUES (1),(20)");
  const reader = createLeaderboardReader(db, "excluded_players");
  const rank = reader.readRank(config, 21);
  assert.equal(rank?.subject.primaryRank, 19);
  const page = reader.readPage(config, "primary", 60, 100);
  assert.equal(page?.top.length, 100);
  assert.equal(page?.around?.length, 100);
  assert.equal(page?.top.some((row) => row.aid === 1 || row.aid === 20), false);
  assert.equal(page?.around?.filter((row) => row.selected).length, 1);
});

test("fresh overlay replaces old self once and removal-only overlay cannot resurrect it", () => {
  const reader = createLeaderboardReader(db, "excluded_players");
  const promoted = materializeCandidate({ ...source(60, 10_000), sourceUpdatedAt: 2 }, { config, formula });
  const page = reader.readPage(config, "primary", 60, 100, promoted);
  assert.equal(page?.subject?.primaryRank, 1);
  assert.equal(page?.around?.filter((row) => row.aid === 60).length, 1);
  assert.equal(page?.top.filter((row) => row.aid === 60).length, 1);

  const inactive = materializeCandidate({ ...source(60), sourceUpdatedAt: 3, activityAt: 99 }, { config, formula });
  const removed = reader.readPage(config, "primary", 60, 100, inactive);
  assert.equal(removed?.subject?.status, "inactive");
  assert.equal(removed?.subject?.primaryRank, null);
  assert.equal(removed?.around, null);
  assert.equal(removed?.top.some((row) => row.aid === 60), false);
});

test("reader rejects mismatched generations/config and refreshes on metric-version changes", () => {
  const reader = createLeaderboardReader(db, "excluded_players");
  assert.equal(reader.snapshot({ ...config, minimumSample: 7 }), null);
  assert.equal(reader.readPage(config, "primary", 60, 100, null, Date.now(), 999), null);

  const changedMetric = materializeCandidate(source(60), { config, formula });
  changedMetric.member.metricVersion += 1;
  changedMetric.member.status = "inactive";
  changedMetric.member.score = null;
  changedMetric.orders = [];
  const removed = reader.readPage(config, "primary", 60, 100, changedMetric);
  assert.equal(removed?.subject?.status, "inactive");
  assert.equal(removed?.subject?.primaryRank, null);
  assert.equal(removed?.top.some((row) => row.aid === 60), false);
});

test("an excluded focused subject is never restored from its saved member", () => {
  db.exec("INSERT INTO excluded_players VALUES (60)");
  const reader = createLeaderboardReader(db, "excluded_players");
  const page = reader.readPage(config, "primary", 60, 100, materializeCandidate(source(60, 10_000), { config, formula }));
  assert.equal(page?.subject?.status, "excluded");
  assert.equal(page?.subject?.primaryRank, null);
  assert.equal(page?.around, null);
  assert.equal(page?.top.some((row) => row.aid === 60), false);
  const rank = reader.readRank(config, 60, materializeCandidate(source(60, 10_000), { config, formula }));
  assert.equal(rank?.subject.status, "excluded");
  db.exec("DELETE FROM excluded_players WHERE aid=60");
});

test("a current-cycle confirmed ban is excluded immediately from a Seasonal publication", () => {
  db.exec(`CREATE TABLE seasonal_excluded(aid INTEGER PRIMARY KEY);
    CREATE TABLE seasonal_profiles(mode TEXT,cycle_id TEXT,aid INTEGER,confirmed_banned INTEGER,
      PRIMARY KEY(mode,cycle_id,aid));
    INSERT INTO seasonal_profiles VALUES ('seasonal','s1',201,0),('seasonal','s1',202,0)`);
  const seasonalConfig = { ...config, scope: "seasonal:s1", mode: "pvp-season" as const, cycleId: "s1" };
  const candidates = [source(201, 50), source(202, 40)].map((row) =>
    materializeCandidate(row, { config: seasonalConfig, formula }));
  publication.publishLeaderboardScope(db, seasonalConfig.scope,
    { formulaVersion: 1, params: { ...seasonalConfig, formula }, meta: {} },
    candidates.map((candidate) => candidate.member), candidates.flatMap((candidate) => candidate.orders), 90, 100);
  const reader = createLeaderboardReader(db, "excluded_players", "seasonal_excluded", "seasonal_profiles");
  assert.equal(reader.readRank(seasonalConfig, 201)?.subject.status, "ranked");
  db.prepare("UPDATE seasonal_profiles SET confirmed_banned=1 WHERE cycle_id='s1' AND aid=201").run();
  assert.equal(reader.readRank(seasonalConfig, 201)?.subject.status, "excluded");
  assert.equal(reader.readPage(seasonalConfig, "primary", null, 500)?.top.some((row) => row.aid === 201), false);
});

test("a saved low-sample player keeps the shared group label in an alternate sort", () => {
  const reader = createLeaderboardReader(db, "excluded_players");
  const page = reader.readPage(config, "hours", 120, 100);
  assert.equal(page?.subject?.status, "insufficient_sample");
  assert.equal(page?.subject?.groupStart, (page?.meta.rankedCount ?? 0) + 1);
});

test("incremental publication moves changed players both ways and skips ordinal work for a no-op", () => {
  const current = db.prepare("SELECT generation,generated_at FROM leaderboard_current WHERE scope='regular'").get();
  const high = materializeCandidate({ ...source(60, 10_000), sourceUpdatedAt: 2, sourceRevision: 1 }, { config, formula });
  const low = materializeCandidate({ ...source(2, 0), sourceUpdatedAt: 2, sourceRevision: 1 }, { config, formula });
  const updated = publication.updateLeaderboardScope(db, config.scope, Number(current.generation),
    { formulaVersion: 1, params: { ...config, formula }, meta: {} },
    [{ aid: 60, ...high }, { aid: 2, ...low }], 200);
  assert.equal(updated.changedMembers, 2);
  assert.equal(updated.touchedSorts, 3);
  assert.equal(db.prepare("SELECT ordinal FROM leaderboard_order WHERE scope='regular' AND sort='primary' AND aid=60").get().ordinal, 1);
  assert.ok(db.prepare("SELECT ordinal FROM leaderboard_order WHERE scope='regular' AND sort='primary' AND aid=2").get().ordinal > 2);
  const reader = createLeaderboardReader(db, "excluded_players");
  assert.equal(reader.snapshot(config, Date.now(), Number(current.generation), Number(current.generated_at)), null);

  const unchanged = materializeCandidate({ ...source(3), sourceRevision: 9 }, { config, formula });
  const beforeOrdinal = db.prepare("SELECT ordinal FROM leaderboard_order WHERE scope='regular' AND sort='primary' AND aid=3").get().ordinal;
  const noOp = publication.updateLeaderboardScope(db, config.scope, Number(current.generation),
    { formulaVersion: 1, params: { ...config, formula }, meta: {} }, [{ aid: 3, ...unchanged }], 201);
  assert.equal(noOp.changedMembers, 0);
  assert.equal(noOp.touchedSorts, 0);
  assert.equal(db.prepare("SELECT source_revision FROM leaderboard_members WHERE scope='regular' AND aid=3").get().source_revision, 9);
  assert.equal(db.prepare("SELECT ordinal FROM leaderboard_order WHERE scope='regular' AND sort='primary' AND aid=3").get().ordinal, beforeOrdinal);

  const beforeRename = db.prepare("SELECT sort,ordinal FROM leaderboard_order WHERE scope='regular' AND aid=4 ORDER BY sort").all();
  const renamed = materializeCandidate({ ...source(4), nickname: "Renamed", sourceRevision: 10 }, { config, formula });
  const rename = publication.updateLeaderboardScope(db, config.scope, Number(current.generation),
    { formulaVersion: 1, params: { ...config, formula }, meta: {} }, [{ aid: 4, ...renamed }], 202);
  assert.equal(rename.changedMembers, 1);
  assert.equal(rename.touchedSorts, 0);
  assert.deepEqual(db.prepare("SELECT sort,ordinal FROM leaderboard_order WHERE scope='regular' AND aid=4 ORDER BY sort").all(), beforeRename);
  const renamedRank = createLeaderboardReader(db, "excluded_players").readRank(config, 4);
  assert.equal(renamedRank?.subject.nickname, "Renamed");
  assert.ok(renamedRank?.subject.primaryRank != null);

  const beforeHours = db.prepare("SELECT ordinal FROM leaderboard_order WHERE scope='regular' AND sort='hours' AND aid=5").get().ordinal;
  const killsOnly = materializeCandidate({ ...source(5), kills: 50_000, sourceRevision: 11 }, { config, formula });
  const subset = publication.updateLeaderboardScope(db, config.scope, Number(current.generation),
    { formulaVersion: 1, params: { ...config, formula }, meta: {} }, [{ aid: 5, ...killsOnly }], 203);
  assert.equal(subset.touchedSorts, 3);
  assert.equal(db.prepare("SELECT ordinal FROM leaderboard_order WHERE scope='regular' AND sort='hours' AND aid=5").get().ordinal, beforeHours);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM leaderboard_order WHERE scope='regular' AND aid=5 AND ordinal IS NOT NULL").get().count, 4);
  const page = createLeaderboardReader(db, "excluded_players").readPage(config, "primary", 5, 100);
  assert.equal(page?.top.some((row) => row.aid === 5), true);

  publication.updateLeaderboardScope(db, config.scope, Number(current.generation),
    { formulaVersion: 1, params: { ...config, formula }, meta: {} }, [], 204, { mode: "pve", changeId: 0 });
  assert.deepEqual(publication.leaderboardSourceCursor(db, "pve"), { initialized: true, changeId: 0 });

  const removed = publication.updateLeaderboardScope(db, config.scope, Number(current.generation),
    { formulaVersion: 1, params: { ...config, formula }, meta: {} }, [{ aid: 120, member: null, orders: [] }], 205);
  assert.equal(removed.changedMembers, 1);
  assert.equal(db.prepare("SELECT 1 FROM leaderboard_members WHERE scope='regular' AND aid=120").get(), undefined);
  assert.equal(db.prepare("SELECT 1 FROM leaderboard_order WHERE scope='regular' AND aid=120").get(), undefined);
});

test("incremental failure rolls back member, order, publication token, and cursor for retry", () => {
  const current = db.prepare("SELECT generation,generated_at FROM leaderboard_current WHERE scope='regular'").get();
  const candidate = materializeCandidate({ ...source(61, 20_000), sourceUpdatedAt: 2, sourceRevision: 4 }, { config, formula });
  db.exec(`CREATE TRIGGER fail_incremental_order BEFORE INSERT ON leaderboard_order
    WHEN NEW.aid=61 BEGIN SELECT RAISE(ABORT,'incremental fixture failure'); END`);
  assert.throws(() => publication.updateLeaderboardScope(db, config.scope, Number(current.generation),
    { formulaVersion: 1, params: { ...config, formula }, meta: {} }, [{ aid: 61, ...candidate }], 300,
    { mode: "regular", changeId: 44 }));
  db.exec("DROP TRIGGER fail_incremental_order");
  assert.equal(db.prepare("SELECT generated_at FROM leaderboard_current WHERE scope='regular'").get().generated_at, current.generated_at);
  assert.equal(db.prepare("SELECT source_revision FROM leaderboard_members WHERE scope='regular' AND aid=61").get().source_revision, 0);
  assert.deepEqual(publication.leaderboardSourceCursor(db, "regular"), { initialized: false, changeId: 0 });
  assert.equal(db.prepare("SELECT 1 FROM temp.sqlite_temp_master WHERE name='leaderboard_rank_work'").get(), undefined);
});

test("a stale publisher cannot overwrite a newer revision or advance its cursor", () => {
  const stale = db.prepare("SELECT generation,generated_at FROM leaderboard_current WHERE scope='regular'").get();
  const newer = materializeCandidate({ ...source(62, 30_000), nickname: "Newer", sourceUpdatedAt: 3,
    sourceRevision: 20 }, { config, formula });
  publication.updateLeaderboardScope(db, config.scope, Number(stale.generation),
    { formulaVersion: 1, params: { ...config, formula }, meta: {} }, [{ aid: 62, ...newer }], 400,
    { mode: "regular", changeId: 50 }, Number(stale.generated_at));
  const current = db.prepare("SELECT generation,generated_at FROM leaderboard_current WHERE scope='regular'").get();

  const older = materializeCandidate({ ...source(62), nickname: "Older", sourceUpdatedAt: 2,
    sourceRevision: 19 }, { config, formula });
  assert.throws(() => publication.updateLeaderboardScope(db, config.scope, Number(stale.generation),
    { formulaVersion: 1, params: { ...config, formula }, meta: {} }, [{ aid: 62, ...older }], 401,
    { mode: "regular", changeId: 51 }, Number(stale.generated_at)), /publication changed/);
  const staleFull = generation([{ ...source(62), nickname: "Older", sourceUpdatedAt: 2 }]);
  assert.throws(() => publication.publishLeaderboardScope(db, config.scope,
    { formulaVersion: 1, params: { ...config, formula }, meta: {} }, staleFull.members, staleFull.orders,
    402, undefined, { mode: "regular", changeId: 52 },
    { generation: Number(stale.generation), generatedAt: Number(stale.generated_at) }), /publication changed/);

  assert.deepEqual({ ...db.prepare("SELECT generation,generated_at FROM leaderboard_current WHERE scope='regular'").get() },
    { ...current });
  assert.equal(db.prepare("SELECT nickname FROM leaderboard_members WHERE scope='regular' AND aid=62").get().nickname, "Newer");
  assert.deepEqual(publication.leaderboardSourceCursor(db, "regular"), { initialized: true, changeId: 50 });
});

test("the implicit revision guard rejects a commit between the entry read and write lock", () => {
  const directory = mkdtempSync(join(tmpdir(), "leaderboard-cas-"));
  const path = join(directory, "publication.db");
  const primary = new DatabaseSync(path);
  const concurrent = new DatabaseSync(path);
  try {
    publication.initializeLeaderboardSchema(primary);
    const initial = generation([source(70)]);
    publication.publishLeaderboardScope(primary, config.scope,
      { formulaVersion: 1, params: { ...config, formula }, meta: {} }, initial.members, initial.orders, 90, 100);
    const generationId = Number(primary.prepare("SELECT generation FROM leaderboard_current WHERE scope='regular'").get().generation);
    let injected = false;
    const wrapped = new Proxy(primary, {
      get(target, property) {
        if (property !== "prepare") {
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (injected || sql !== "SELECT generation,generated_at FROM leaderboard_current WHERE scope=?") return statement;
          return new Proxy(statement, {
            get(statementTarget, statementProperty) {
              if (statementProperty !== "get") {
                const value = Reflect.get(statementTarget, statementProperty);
                return typeof value === "function" ? value.bind(statementTarget) : value;
              }
              return (...args: unknown[]) => {
                const row = statementTarget.get(...args);
                concurrent.prepare("UPDATE leaderboard_current SET generated_at=generated_at+1 WHERE scope=?").run(...args);
                injected = true;
                return row;
              };
            },
          });
        };
      },
    });
    const stale = materializeCandidate({ ...source(70), nickname: "Stale" }, { config, formula });
    assert.throws(() => publication.updateLeaderboardScope(wrapped, config.scope, generationId,
      { formulaVersion: 1, params: { ...config, formula }, meta: {} }, [{ aid: 70, ...stale }]), /publication changed/);
    assert.equal(primary.prepare("SELECT nickname FROM leaderboard_members WHERE aid=70").get().nickname, "P70");
  } finally {
    concurrent.close();
    primary.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the predecessor lookup uses the comparator index", () => {
  const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT ordinal FROM leaderboard_order
    WHERE scope=? AND generation=? AND sort=?
      AND (k1,k2,k3,k4,k5,stable_key)>(?,?,?,?,?,?)
    ORDER BY k1 ASC,k2 ASC,k3 ASC,k4 ASC,k5 ASC,stable_key ASC LIMIT 1`)
    .all("regular", 100, "primary", 10, -1, -1, -1, -1, -60)
    .map((row: { detail: unknown }) => String(row.detail)).join("\n");
  assert.match(plan, /idx_leaderboard_order_comparator/);
  const memberOrders = db.prepare(`EXPLAIN QUERY PLAN SELECT * FROM leaderboard_order WHERE scope=? AND generation=?
    AND sort IN ('primary','kd','killsPerMatch','hours') AND aid=?`).all("regular", 100, 60)
    .map((row: { detail: unknown }) => String(row.detail)).join("\n");
  assert.match(memberOrders, /sqlite_autoindex_leaderboard_order_1/);
  assert.doesNotMatch(memberOrders, /SCAN leaderboard_order/);
  const liveExclusions = db.prepare(`EXPLAIN QUERY PLAN SELECT o.ordinal FROM (
      SELECT aid FROM excluded_players UNION SELECT aid FROM seasonal_excluded
      UNION SELECT aid FROM seasonal_profiles WHERE mode='seasonal' AND cycle_id='s1' AND confirmed_banned=1
    ) x CROSS JOIN leaderboard_order o
      ON o.scope=? AND o.generation=? AND o.sort=? AND o.aid=x.aid ORDER BY o.ordinal`)
    .all("seasonal:s1", 100, "primary").map((row: { detail: unknown }) => String(row.detail)).join("\n");
  assert.match(liveExclusions, /scope=\? AND generation=\? AND sort=\? AND aid=\?/);
  assert.doesNotMatch(liveExclusions, /SCAN o/);
  const liveCounts = db.prepare(`EXPLAIN QUERY PLAN SELECT COUNT(*) FROM (
      SELECT aid FROM excluded_players UNION SELECT aid FROM seasonal_excluded
      UNION SELECT aid FROM seasonal_profiles WHERE mode='seasonal' AND cycle_id='s1' AND confirmed_banned=1
    ) x CROSS JOIN leaderboard_members m
      ON m.scope=? AND m.generation=? AND m.aid=x.aid`).all("seasonal:s1", 100)
    .map((row: { detail: unknown }) => String(row.detail)).join("\n");
  assert.match(liveCounts, /scope=\? AND generation=\? AND aid=\?/);
  assert.doesNotMatch(liveCounts, /SCAN m/);
});

test.after(() => db.close());
