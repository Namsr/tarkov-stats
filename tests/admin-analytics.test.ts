/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- Node's direct TypeScript runner requires explicit .ts imports.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createAnalyticsStore } from "../lib/admin/analytics-db.ts";

const DAY = 86_400_000;

test("analytics store retains only anonymous request/account facts and aggregates periods", () => {
  const db = new DatabaseSync(":memory:");
  const store = createAnalyticsStore(db);
  const now = 200 * DAY;
  store.record({ occurredAt: now - 1_000, host: "tarkovstats.ru", operation: "player_profile", aid: 42, nickname: "Bear", mode: "regular", cycleId: "persistent", outcome: "success", status: 200, force: true, source: "upstream", cache: "miss", latencyMs: 12.6, profileMs: 8, baselineMs: 2, metadataMs: 1, masteryMs: 4, cohortMs: 3, storeReadMs: 1, storeWriteMs: 2 });
  store.record({ occurredAt: now - 900, host: "tarkovstats.ru", operation: "player_search", aid: 42, nickname: "Bear", outcome: "success", status: 200, source: "index", latencyMs: 2 });
  store.record({ occurredAt: now - 2_000, host: "tarkovstats.online", operation: "average", outcome: "error", status: 503, latencyMs: 100 });
  store.record({ occurredAt: now - 8 * DAY, host: "tarkovstats.ru", operation: "player_profile", aid: 99, outcome: "success", status: 200, latencyMs: 1 });

  const summary = store.summary("7d", "all", now);
  assert.equal(summary.accountRequests, 1);
  assert.equal(summary.errors, 1);
  assert.equal(summary.health.p50Ms, 2);
  assert.equal(summary.health.p95Ms, 13);
  assert.equal(summary.health.p99Ms, 13);
  assert.equal(summary.health.status, "incident");
  assert.equal(summary.health.activeIssueCount, 1);
  assert.equal(summary.health.recentIssueCount, 1);
  assert.deepEqual(summary.health.issues.map((issue) => [issue.stage, issue.code, issue.active]), [["application", "average_error_503", true]]);
  assert.deepEqual(summary.health.operations.map((operation) => [operation.operation, operation.p99Ms]), [["average", null], ["player_profile", 13], ["player_search", 2]]);
  assert.deepEqual(summary.health.operations.find((operation) => operation.operation === "player_profile")?.variants,
    [{ source: "upstream", cache: "miss", force: true, requests: 1, p50Ms: 13, p95Ms: 13, p99Ms: 13 }]);
  assert.deepEqual(summary.health.operations.find((operation) => operation.operation === "player_profile")?.phases,
    [
      { phase: "profile", samples: 1, p50Ms: 8, p95Ms: 8, p99Ms: 8 },
      { phase: "baseline", samples: 1, p50Ms: 2, p95Ms: 2, p99Ms: 2 },
      { phase: "metadata", samples: 1, p50Ms: 1, p95Ms: 1, p99Ms: 1 },
      { phase: "mastery", samples: 1, p50Ms: 4, p95Ms: 4, p99Ms: 4 },
      { phase: "cohort", samples: 1, p50Ms: 3, p95Ms: 3, p99Ms: 3 },
      { phase: "store_read", samples: 1, p50Ms: 1, p95Ms: 1, p99Ms: 1 },
      { phase: "store_write", samples: 1, p50Ms: 2, p95Ms: 2, p99Ms: 2 },
    ]);
  assert.equal(summary.health.series.reduce((total, point) => total + point.requests, 0), 3);
  assert.equal(summary.freshness.lastProfileRequestAt, now - 1_000);
  assert.deepEqual(store.healthSignal("all", now), {
    status: "incident", activeIssueCount: 1, firstSeenAt: now - 2_000, lastSeenAt: now - 2_000,
  });

  const columns = db.prepare("PRAGMA table_info(request_events)").all().map((row) => row.name);
  assert.equal(columns.includes("ip"), false);
  assert.equal(columns.includes("email"), false);
  assert.equal(columns.includes("user_sub"), false);
  assert.equal(columns.includes("search_text"), false);
  assert.equal(columns.includes("failure_stage"), true);
  assert.equal(columns.includes("error_code"), true);
  for (const name of ["profile_ms", "baseline_ms", "metadata_ms", "mastery_ms", "cohort_ms", "store_read_ms", "store_write_ms"]) {
    assert.equal(columns.includes(name), true);
  }
  assert.deepEqual({ ...db.prepare(`SELECT profile_ms, baseline_ms, metadata_ms, mastery_ms, cohort_ms,
    store_read_ms, store_write_ms FROM request_events WHERE operation = 'player_profile' AND aid = 42`).get() },
  { profile_ms: 8, baseline_ms: 2, metadata_ms: 1, mastery_ms: 4, cohort_ms: 3, store_read_ms: 1, store_write_ms: 2 });
});

test("15 minute analytics period excludes older events", () => {
  const db = new DatabaseSync(":memory:");
  const store = createAnalyticsStore(db);
  const now = 275 * DAY;
  store.record({ occurredAt: now - 14 * 60_000, operation: "average", outcome: "success", status: 200, latencyMs: 1 });
  store.record({ occurredAt: now - 16 * 60_000, operation: "average", outcome: "success", status: 200, latencyMs: 2 });
  assert.equal(store.summary("15m", "all", now).health.requests, 1);
});

test("diagnostic columns migrate in place and p99 uses the nearest-rank definition", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE request_events (
    id INTEGER PRIMARY KEY, occurred_at INTEGER NOT NULL, host TEXT, operation TEXT NOT NULL,
    aid INTEGER, nickname TEXT, mode TEXT, cycle_id TEXT, outcome TEXT NOT NULL,
    status INTEGER NOT NULL, force INTEGER, source TEXT, cache TEXT, latency_ms INTEGER NOT NULL
  );`);
  const store = createAnalyticsStore(db);
  const now = 250 * DAY;
  for (let latencyMs = 1; latencyMs <= 101; latencyMs += 1) {
    store.record({ occurredAt: now - latencyMs, operation: "average", outcome: "success", status: 200, latencyMs });
  }
  const summary = store.summary("24h", "all", now);
  assert.equal(summary.health.p50Ms, 51);
  assert.equal(summary.health.p95Ms, 96);
  assert.equal(summary.health.p99Ms, 100);
  assert.equal(summary.health.operations[0].p99Ms, 100);
  const columns = db.prepare("PRAGMA table_info(request_events)").all().map((row) => row.name);
  assert.equal(columns.includes("storage"), true);
  assert.equal(columns.includes("failure_stage"), true);
  assert.equal(columns.includes("error_code"), true);
});

test("account analytics filters, sorts, and cursor-paginates", () => {
  const db = new DatabaseSync(":memory:");
  const store = createAnalyticsStore(db);
  const now = 300 * DAY;
  for (const event of [
    { occurredAt: now - 10, aid: 3, nickname: "Third", mode: "pve", outcome: "success", status: 200, source: "cache" },
    { occurredAt: now - 20, aid: 2, nickname: "Second", mode: "regular", outcome: "not_found", status: 404, source: "upstream" },
    { occurredAt: now - 30, aid: 1, nickname: "First", mode: "regular", outcome: "success", status: 200, source: "upstream" },
  ]) {
    store.record({ operation: "player_search", latencyMs: 1, ...event, outcome: "success", status: 200 });
    store.record({ operation: "player_profile", latencyMs: 1, ...event });
  }

  const first = store.accounts({ period: "24h", domain: "all", limit: 2, now });
  assert.deepEqual(first.accounts.map((row) => row.aid), [3, 2]);
  assert.ok(first.nextCursor);
  const second = store.accounts({ period: "24h", domain: "all", limit: 2, cursor: first.nextCursor, now });
  assert.deepEqual(second.accounts.map((row) => row.aid), [1]);
  assert.deepEqual(store.accounts({ period: "24h", domain: "all", mode: "pve", now }).accounts.map((row) => row.aid), [3]);
  assert.deepEqual(store.accounts({ period: "24h", domain: "all", search: "second", now }).accounts.map((row) => row.aid), [2]);
  const suspicious = store.accounts({ period: "24h", domain: "all", aids: [1, 3], limit: 1, now });
  assert.deepEqual(suspicious.accounts.map((row) => row.aid), [3]);
  assert.ok(suspicious.nextCursor);
  assert.deepEqual(store.accounts({ period: "24h", domain: "all", aids: [1, 3], limit: 1, cursor: suspicious.nextCursor, now }).accounts.map((row) => row.aid), [1]);
  assert.deepEqual(store.accounts({ period: "24h", domain: "all", aids: [], now }).accounts, []);
});

test("account requests count successful nickname searches once and keep profile metadata separate", () => {
  const db = new DatabaseSync(":memory:");
  const store = createAnalyticsStore(db);
  const now = 350 * DAY;
  store.record({ occurredAt: now - 40, operation: "player_profile", aid: 42, nickname: "Bear", mode: "regular", outcome: "success", status: 200, force: true, source: "upstream", latencyMs: 1 });
  store.record({ occurredAt: now - 30, operation: "player_profile", aid: 42, nickname: "Bear", mode: "pve", outcome: "success", status: 200, force: false, source: "stored", latencyMs: 1 });
  store.record({ occurredAt: now - 20, operation: "player_search", aid: 42, nickname: "Bear", outcome: "success", status: 200, source: "index", latencyMs: 1 });
  store.record({ occurredAt: now - 15, operation: "player_search", aid: 42, nickname: "Bear", outcome: "success", status: 200, source: "index", latencyMs: 1 });
  // Prefix results are intentionally not assigned to any one account.
  store.record({ occurredAt: now - 10, operation: "player_search", outcome: "success", status: 200, source: "index", latencyMs: 1 });
  store.record({ occurredAt: now - 5, operation: "player_search", outcome: "not_found", status: 200, source: "index", latencyMs: 1 });

  assert.equal(store.summary("24h", "all", now).accountRequests, 2);
  const accounts = store.accounts({ period: "24h", domain: "all", now }).accounts;
  assert.equal(accounts.length, 1);
  assert.deepEqual(accounts[0], {
    aid: 42,
    nickname: "Bear",
    modes: ["regular", "pve"],
    requestCount: 2,
    lastRequestedAt: now - 15,
    outcomes: { success: 2 },
    refreshCount: 1,
    sources: ["upstream", "stored"],
    snapshotCount: 0,
  });
});

test("account analytics exposes and sorts progression snapshot totals", () => {
  const db = new DatabaseSync(":memory:");
  const store = createAnalyticsStore(db, { progressionDbPath: ":memory:" });
  db.exec(`
    CREATE TABLE progression_db.player_profiles (
      mode TEXT NOT NULL, aid INTEGER NOT NULL, snapshot_count INTEGER NOT NULL
    );
    CREATE TABLE progression_db.progression_snapshots (
      mode TEXT NOT NULL, aid INTEGER NOT NULL
    );
    INSERT INTO progression_db.player_profiles VALUES
      ('regular', 42, 3), ('seasonal', 42, 1), ('regular', 7, 1);
    INSERT INTO progression_db.progression_snapshots VALUES
      ('regular', 42), ('regular', 42), ('regular', 7), ('seasonal', 42);
  `);
  const now = 600 * DAY;
  for (const event of [
    { aid: 7, nickname: "Seven", mode: "regular" },
    { aid: 42, nickname: "Forty Two", mode: "regular" },
    { aid: 42, nickname: "Forty Two", mode: "seasonal" },
  ]) {
    store.record({ occurredAt: now - event.aid, operation: "player_search", outcome: "success", status: 200, latencyMs: 1, ...event });
    store.record({ occurredAt: now - event.aid, operation: "player_profile", outcome: "success", status: 200, latencyMs: 1, ...event });
  }

  const allModes = store.accounts({ period: "24h", domain: "all", sort: "snapshots", now });
  assert.deepEqual(allModes.accounts.map((row) => [row.aid, row.snapshotCount]), [[42, 4], [7, 1]]);
  const regular = store.accounts({ period: "24h", domain: "all", mode: "regular", sort: "snapshots", now });
  assert.deepEqual(regular.accounts.map((row) => [row.aid, row.snapshotCount]), [[42, 3], [7, 1]]);
});

test("auth aggregates persist only day-level HMAC counts without exact timestamps or raw Google sub", async () => {
  const db = new DatabaseSync(":memory:");
  const store = createAnalyticsStore(db);
  const now = 400 * DAY + 12_345;
  const rawSub = "109876543210987654321";
  const hash = createHmac("sha256", "test-analytics-secret").update(rawSub).digest("hex");
  store.recordAuth(hash, "sign_in", now);
  store.recordAuth(hash, "activity", now + 9_999);
  store.recordAuth("another-hmac", "activity", now + 20_000);

  const columns = db.prepare("PRAGMA table_info(auth_activity_daily)").all().map((row) => row.name);
  assert.deepEqual(columns, ["day", "subject_hash", "sign_ins", "activities"]);
  const rows = db.prepare("SELECT * FROM auth_activity_daily ORDER BY subject_hash").all();
  assert.equal(JSON.stringify(rows).includes(rawSub), false);
  assert.deepEqual(store.summary("24h", "all", now + 30_000).auth, { activeUsers: 2, signIns: 1 });

  const source = await readFile("lib/admin/request-events.ts", "utf8");
  assert.match(source, /createHmac\("sha256", secret\)\.update\(sub\)/);
  assert.match(source, /recordAuth\(subjectHash, kind\)/);
  assert.doesNotMatch(source, /recordAuth\(sub, kind\)/);
});

test("legacy auth activity migration removes last_at and preserves daily aggregates", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE auth_activity_daily (
    day TEXT NOT NULL, subject_hash TEXT NOT NULL, sign_ins INTEGER NOT NULL,
    activities INTEGER NOT NULL, last_at INTEGER NOT NULL,
    PRIMARY KEY (day, subject_hash)
  );`);
  db.prepare("INSERT INTO auth_activity_daily VALUES (?, ?, ?, ?, ?)")
    .run("1971-02-05", "legacy-hmac", 3, 7, 34_567_890_123);

  createAnalyticsStore(db);

  const columns = db.prepare("PRAGMA table_info(auth_activity_daily)").all().map((row) => row.name);
  assert.deepEqual(columns, ["day", "subject_hash", "sign_ins", "activities"]);
  assert.deepEqual({ ...db.prepare("SELECT * FROM auth_activity_daily").get() }, {
    day: "1971-02-05", subject_hash: "legacy-hmac", sign_ins: 3, activities: 7,
  });
});

test("cleanup removes detailed events older than 90 days", () => {
  const db = new DatabaseSync(":memory:");
  const store = createAnalyticsStore(db);
  const now = 500 * DAY;
  store.record({ occurredAt: now - 91 * DAY, operation: "average", outcome: "success", status: 200, latencyMs: 1 });
  store.record({ occurredAt: now - DAY, operation: "average", outcome: "success", status: 200, latencyMs: 1 });
  store.recordAuth("old-hmac", "activity", now - 91 * DAY);
  store.recordAuth("recent-hmac", "activity", now - DAY);
  assert.equal(store.cleanup(now), 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM request_events").get().n, 1);
  assert.deepEqual(db.prepare("SELECT subject_hash FROM auth_activity_daily").all().map((row) => ({ ...row })), [{ subject_hash: "recent-hmac" }]);
});
