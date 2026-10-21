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
  assert.deepEqual(db.prepare("PRAGMA table_info(audience_visitors)").all().map((row) => row.name), ["visitor_id", "host", "first_day", "first_at"]);
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


test("engagement separates first-time, returning, repeat and regular visitors at exact period boundaries", () => {
  const store = createAnalyticsStore(new DatabaseSync(":memory:"));
  const from = NOW - DAY;
  visit(store, "new-repeat", from);
  visit(store, "new-repeat", from + 10 * 60_000); // same session
  visit(store, "new-repeat", from + 41 * 60_000); // second session
  visit(store, "old-regular", NOW - 20 * DAY);
  visit(store, "old-regular", NOW - 10 * DAY);
  visit(store, "old-regular", NOW - 60_000);
  visit(store, "continued", from - 10 * 60_000);
  visit(store, "continued", from + 10 * 60_000);
  visit(store, "continued", from + 50 * 60_000); // continued + one new session
  visit(store, "old-single", from - 60_000);
  visit(store, "old-single", from + 40 * 60_000); // one new session, not two
  visit(store, "new-single", NOW - 60_000);
  visit(store, "at-end", NOW); // exclusive endpoint
  visit(store, "future", NOW + DAY);
  assert.deepEqual(store.visitorEngagement("24h", "all", NOW), {
    visitors: 5, newVisitors: 2, returningVisitors: 3, repeatVisitors: 2, regularVisitors: 1,
  });
  assert.equal(store.visitorEngagement("24h", "all", NOW).visitors, store.pageviewSummary("24h", "all", NOW).visitors);
});

test("engagement respects domain history, retention, empty ranges and 15-minute precision", () => {
  const store = createAnalyticsStore(new DatabaseSync(":memory:"));
  visit(store, "long-time", NOW - 120 * DAY);
  visit(store, "cross-domain", NOW - DAY, "tarkovstats.online");
  visit(store, "same-day", NOW - 16 * 60_000);
  visit(store, "same-day", NOW - 14 * 60_000);
  visit(store, "cross-domain", NOW - 60_000);
  visit(store, "long-time", NOW - 60_000);
  store.cleanup(NOW);
  assert.deepEqual(store.visitorEngagement("15m", "tarkovstats.ru", NOW), {
    visitors: 3, newVisitors: 1, returningVisitors: 2, repeatVisitors: 0, regularVisitors: 0,
  });
  assert.deepEqual(store.visitorEngagement("15m", "all", NOW), {
    visitors: 3, newVisitors: 0, returningVisitors: 3, repeatVisitors: 0, regularVisitors: 0,
  });
  assert.deepEqual(store.visitorEngagement("15m", "tarkovstats.online", NOW), {
    visitors: 0, newVisitors: 0, returningVisitors: 0, repeatVisitors: 0, regularVisitors: 0,
  });
});

test("regular visitors use distinct MSK days within the last 30 days and must be active in the selected period", () => {
  const store = createAnalyticsStore(new DatabaseSync(":memory:"));
  const midnight = Date.parse("2026-09-21T21:00:00Z");
  visit(store, "regular", midnight - 1);
  visit(store, "regular", midnight);
  visit(store, "regular", midnight - 2 * DAY);
  visit(store, "same-day", NOW - 60_000);
  visit(store, "same-day", NOW - 120_000);
  visit(store, "same-day", NOW - 180_000);
  for (const offset of [31, 32, 33]) visit(store, "too-old", NOW - offset * DAY);
  visit(store, "too-old", NOW - 60_000);
  for (const offset of [3, 4, 5]) visit(store, "inactive", NOW - offset * DAY);
  assert.equal(store.visitorEngagement("24h", "all", NOW).regularVisitors, 1);
  assert.equal(store.visitorEngagement("7d", "all", NOW).regularVisitors, 2);
});

test("Google aggregates separate active accounts, accounts signing in and repeat sign-in events, excluding future days", () => {
  const store = createAnalyticsStore(new DatabaseSync(":memory:"));
  store.recordAuth("signed", "sign_in", NOW - 60_000);
  store.recordAuth("signed", "sign_in", NOW - 30_000);
  store.recordAuth("saved-session", "activity", NOW - 60_000);
  store.recordAuth("before-window", "sign_in", NOW - 2 * DAY);
  store.recordAuth("future", "sign_in", NOW + DAY);
  assert.deepEqual(store.authSummary("15m", NOW), {
    activeUsers: 2, signInUsers: 1, signIns: 2, fromDay: day(NOW), toDay: day(NOW),
  });
});


test("returning visitors stay returning when retention deletes an earlier hit on the 90-day boundary", () => {
  const db = new DatabaseSync(":memory:");
  let store = createAnalyticsStore(db);
  const from = NOW - 90 * DAY;
  visit(store, "boundary-return", from - 1);
  visit(store, "boundary-return", from + 1);
  visit(store, "boundary-new", from + 2);
  store.cleanup(NOW);
  store = createAnalyticsStore(db);
  assert.deepEqual(store.visitorEngagement("90d", "all", NOW), {
    visitors: 2, newVisitors: 1, returningVisitors: 1, repeatVisitors: 0, regularVisitors: 0,
  });
  assert.equal(db.prepare("SELECT first_at FROM audience_visitors WHERE visitor_id = ?").get("boundary-return").first_at, from - 1);
});

test("first-time migration backfills surviving first hits once and preserves legacy daily history", () => {
  const db = new DatabaseSync(":memory:");
  let store = createAnalyticsStore(db);
  visit(store, "known", NOW - 60_000);
  db.exec("DROP TRIGGER track_first_visit_day; ALTER TABLE audience_visitors DROP COLUMN first_at; DELETE FROM analytics_meta WHERE key = 'audience_first_time_v1';");
  db.prepare("INSERT INTO audience_visitors (visitor_id, host, first_day) VALUES (?, ?, ?)").run("legacy", "tarkovstats.ru", day(NOW - 120 * DAY));
  store = createAnalyticsStore(db);
  assert.equal(db.prepare("SELECT first_at FROM audience_visitors WHERE visitor_id = 'known'").get().first_at, NOW - 60_000);
  assert.equal(db.prepare("SELECT first_at FROM audience_visitors WHERE visitor_id = 'legacy'").get().first_at, null);
  visit(store, "legacy", NOW - 30_000);
  visit(store, "known", NOW - 120_000); // Earlier, out of order, on the same day.
  assert.equal(db.prepare("SELECT first_at FROM audience_visitors WHERE visitor_id = 'known'").get().first_at, NOW - 120_000);
  assert.equal(store.visitorEngagement("15m", "all", NOW).returningVisitors, 1);
  store = createAnalyticsStore(db);
  assert.equal(store.visitorEngagement("15m", "all", NOW).returningVisitors, 1);
});


test("migration keeps day precision when retention may have removed earlier first-day events", () => {
  const db = new DatabaseSync(":memory:");
  let store = createAnalyticsStore(db);
  const from = NOW - 90 * DAY;
  visit(store, "pruned-first-day", from - 1);
  visit(store, "pruned-first-day", from + 1);
  store.cleanup(NOW);
  db.exec("DROP TRIGGER track_first_visit_day; ALTER TABLE audience_visitors DROP COLUMN first_at; DELETE FROM analytics_meta WHERE key = 'audience_first_time_v1';");
  store = createAnalyticsStore(db);
  assert.equal(db.prepare("SELECT first_at FROM audience_visitors").get().first_at, null);
  assert.equal(store.visitorEngagement("90d", "all", NOW).returningVisitors, 1);
});
