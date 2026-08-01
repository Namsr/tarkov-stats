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
  store.record({ occurredAt: now - 1_000, host: "tarkovstats.ru", operation: "player_profile", aid: 42, nickname: "Bear", mode: "regular", cycleId: "persistent", outcome: "success", status: 200, force: true, source: "upstream", cache: "miss", latencyMs: 12.6 });
  store.record({ occurredAt: now - 2_000, host: "tarkovstats.online", operation: "average", outcome: "error", status: 503, latencyMs: 100 });
  store.record({ occurredAt: now - 8 * DAY, host: "tarkovstats.ru", operation: "player_profile", aid: 99, outcome: "success", status: 200, latencyMs: 1 });

  const summary = store.summary("7d", "all", now);
  assert.equal(summary.accountRequests, 1);
  assert.equal(summary.errors, 1);
  assert.equal(summary.health.p50Ms, 13);
  assert.equal(summary.health.p95Ms, 100);
  assert.equal(summary.freshness.lastProfileRequestAt, now - 1_000);

  const columns = db.prepare("PRAGMA table_info(request_events)").all().map((row) => row.name);
  assert.equal(columns.includes("ip"), false);
  assert.equal(columns.includes("email"), false);
  assert.equal(columns.includes("user_sub"), false);
  assert.equal(columns.includes("search_text"), false);
});

test("account analytics filters, sorts, and cursor-paginates", () => {
  const db = new DatabaseSync(":memory:");
  const store = createAnalyticsStore(db);
  const now = 300 * DAY;
  for (const event of [
    { occurredAt: now - 10, aid: 3, nickname: "Third", mode: "pve", outcome: "success", status: 200, source: "cache" },
    { occurredAt: now - 20, aid: 2, nickname: "Second", mode: "regular", outcome: "not_found", status: 404, source: "upstream" },
    { occurredAt: now - 30, aid: 1, nickname: "First", mode: "regular", outcome: "success", status: 200, source: "upstream" },
  ]) store.record({ operation: "player_profile", latencyMs: 1, ...event });

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
