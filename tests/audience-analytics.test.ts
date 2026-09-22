/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- Node's direct TypeScript runner requires explicit .ts imports.
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { ADMIN_ANALYTICS_SCHEMA, createAnalyticsStore } from "../lib/admin/analytics-db.ts";

const DAY = 86_400_000;
const NOW = Date.parse("2026-09-22T12:00:00Z");
const day = (at: number) => new Date(at).toISOString().slice(0, 10);
const visit = (store, id: string, at: number, host = "tarkovstats.ru") =>
  store.recordPageview({ visitorId: id, occurredAt: at, host, path: "/" });

test("cumulative audiences count identities once, carry the baseline and fill inactive days", () => {
  const store = createAnalyticsStore(new DatabaseSync(":memory:"));
  store.recordAuth("old-user", "sign_in", NOW - 100 * DAY);
  visit(store, "old-visitor", NOW - 100 * DAY);
  store.recordAuth("new-user", "sign_in", NOW - 2 * DAY);
  store.recordAuth("new-user", "sign_in", NOW);
  store.recordAuth("old-user", "activity", NOW);
  visit(store, "new-visitor", NOW - 2 * DAY);
  visit(store, "new-visitor", NOW);
  visit(store, "old-visitor", NOW);
  store.recordAuth("future-user", "sign_in", NOW + DAY);
  visit(store, "future-visitor", NOW + DAY);

  const result = store.audienceSummary("7d", "all", NOW);
  for (const growth of [result.users, result.visitors]) {
    assert.equal(growth.total, 2);
    assert.equal(growth.series.length, 8);
    assert.deepEqual(growth.series[0], { day: day(NOW - 7 * DAY), total: 1, added: 0 });
    assert.deepEqual(growth.series.slice(-3), [
      { day: day(NOW - 2 * DAY), total: 2, added: 1 },
      { day: day(NOW - DAY), total: 2, added: 0 },
      { day: day(NOW), total: 2, added: 0 },
    ]);
    assert.ok(growth.series.every((point, index) => index === 0 || point.total >= growth.series[index - 1].total));
  }
  assert.equal(store.audienceSummary("24h", "all", NOW).users.total, 2);
  assert.equal(store.audienceSummary("90d", "all", NOW).visitors.total, 2);
});

test("visitor domain filters use each domain's first visit while Google totals stay global", () => {
  const store = createAnalyticsStore(new DatabaseSync(":memory:"));
  visit(store, "shared-visitor", NOW - 3 * DAY);
  visit(store, "shared-visitor", NOW - DAY, "tarkovstats.online");
  visit(store, "online-only", NOW, "tarkovstats.online");
  store.recordAuth("one-account", "activity", NOW - 2 * DAY);
  const all = store.audienceSummary("7d", "all", NOW);
  const ru = store.audienceSummary("7d", "tarkovstats.ru", NOW);
  const online = store.audienceSummary("7d", "tarkovstats.online", NOW);
  assert.equal(all.visitors.total, 2);
  assert.equal(ru.visitors.total, 1);
  assert.equal(online.visitors.total, 2);
  assert.equal(all.visitors.series.find((point) => point.day === day(NOW - DAY)).added, 0);
  assert.equal(online.visitors.series.find((point) => point.day === day(NOW - DAY)).added, 1);
  assert.deepEqual(all.users, ru.users);
  assert.deepEqual(all.users, online.users);
});

test("legacy history backfills earliest observed days once and survives retention and reopening", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(ADMIN_ANALYTICS_SCHEMA);
  for (const offset of [120, 110]) {
    db.prepare("INSERT INTO auth_activity_daily VALUES (?, ?, ?, ?)").run(day(NOW - offset * DAY), "known-account", 1, 3);
    db.prepare("INSERT INTO page_views (occurred_at, host, path, visitor_id) VALUES (?, ?, ?, ?)")
      .run(NOW - offset * DAY, "tarkovstats.ru", "/", "known-visitor");
  }
  let store = createAnalyticsStore(db);
  const before = store.audienceSummary("7d", "all", NOW);
  assert.equal(before.users.total, 1);
  assert.equal(before.visitors.total, 1);
  assert.equal(db.prepare("SELECT first_day FROM auth_users").get().first_day, day(NOW - 120 * DAY));
  assert.equal(db.prepare("SELECT first_day FROM audience_visitors").get().first_day, day(NOW - 120 * DAY));
  store.cleanup(NOW);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM auth_activity_daily").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM page_views").get().n, 0);
  store = createAnalyticsStore(db);
  assert.deepEqual(store.audienceSummary("7d", "all", NOW), before);
  store.recordAuth("known-account", "sign_in", NOW);
  visit(store, "known-visitor", NOW);
  assert.deepEqual(store.audienceSummary("7d", "all", NOW), before);
  store.recordAuth("another-account", "sign_in", NOW);
  visit(store, "another-visitor", NOW);
  assert.equal(store.audienceSummary("7d", "all", NOW).users.total, 2);
  assert.equal(store.audienceSummary("7d", "all", NOW).visitors.total, 2);
  assert.deepEqual(db.prepare("PRAGMA table_info(auth_users)").all().map((row) => row.name), ["subject_hash", "first_day"]);
  assert.deepEqual(db.prepare("PRAGMA table_info(audience_visitors)").all().map((row) => row.name), ["visitor_id", "host", "first_day"]);
});

test("UTC midnight, empty ranges and out-of-order events keep daily totals correct", () => {
  const store = createAnalyticsStore(new DatabaseSync(":memory:"));
  const empty = { total: 0, series: [{ day: day(NOW), total: 0, added: 0 }] };
  assert.deepEqual(store.audienceSummary("15m", "all", NOW), { users: empty, visitors: empty });
  const midnight = Date.parse("2026-09-22T00:00:00Z");
  for (const at of [midnight, midnight - 1]) {
    store.recordAuth("returning-account", "sign_in", at);
    visit(store, "returning-visitor", at);
  }
  store.recordAuth("today-account", "sign_in", midnight);
  visit(store, "today-visitor", midnight);
  const result = store.audienceSummary("24h", "all", NOW);
  const expected = { total: 2, series: [
    { day: "2026-09-21", total: 1, added: 1 },
    { day: "2026-09-22", total: 2, added: 1 },
  ] };
  assert.deepEqual(result, { users: expected, visitors: expected });
});

test("auth timestamp migration installs lifetime tracking on the rebuilt daily table", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE auth_activity_daily (
    day TEXT NOT NULL, subject_hash TEXT NOT NULL, sign_ins INTEGER NOT NULL,
    activities INTEGER NOT NULL, last_at INTEGER NOT NULL, PRIMARY KEY (day, subject_hash)
  )`);
  db.prepare("INSERT INTO auth_activity_daily VALUES (?, ?, 1, 0, ?)").run(day(NOW - DAY), "legacy", NOW - DAY);
  const store = createAnalyticsStore(db);
  store.recordAuth("new", "sign_in", NOW);
  assert.equal(store.audienceSummary("7d", "all", NOW).users.total, 2);
});
