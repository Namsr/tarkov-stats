/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- Node's direct TypeScript runner requires explicit .ts imports.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createAnalyticsStore } from "../lib/admin/analytics-db.ts";
import {
  isBotUserAgent,
  isValidPageviewPath,
  isValidVisitorId,
  normalizeReferrerHost,
} from "../lib/admin/pageviews.ts";

const DAY = 86_400_000;
const MINUTE = 60_000;

test("pageview store counts pageviews, visitors and 30-minute sessions", () => {
  const db = new DatabaseSync(":memory:");
  const store = createAnalyticsStore(db);
  const now = 200 * DAY;
  // Visitor A: two hits in one session, one more after a 40-minute gap.
  store.recordPageview({ occurredAt: now - 60 * MINUTE, host: "tarkovstats.ru", path: "/", visitorId: "visitor-a", referrerHost: "google.com" });
  store.recordPageview({ occurredAt: now - 50 * MINUTE, host: "tarkovstats.ru", path: "/player/:account", visitorId: "visitor-a", referrerHost: null });
  store.recordPageview({ occurredAt: now - 10 * MINUTE, host: "tarkovstats.ru", path: "/", visitorId: "visitor-a", referrerHost: null });
  // Visitor B on the other domain.
  store.recordPageview({ occurredAt: now - 5 * MINUTE, host: "tarkovstats.online", path: "/", visitorId: "visitor-b", referrerHost: "yandex.ru" });
  // Visitor D: session started just before the 24h window, continued inside it.
  store.recordPageview({ occurredAt: now - DAY - 10 * MINUTE, host: "tarkovstats.ru", path: "/", visitorId: "visitor-d", referrerHost: null });
  store.recordPageview({ occurredAt: now - DAY + 10 * MINUTE, host: "tarkovstats.ru", path: "/", visitorId: "visitor-d", referrerHost: null });
  // Stale hit outside the 24h window.
  store.recordPageview({ occurredAt: now - 2 * DAY, host: "tarkovstats.ru", path: "/", visitorId: "visitor-c", referrerHost: null });

  const all = store.pageviewSummary("24h", "all", now);
  assert.equal(all.available, true);
  assert.equal(all.pageviews, 5);
  assert.equal(all.visitors, 3);
  // A(2 sessions) + B(1) + D(continued session, not a new visit) = 3.
  assert.equal(all.visits, 3);
  assert.equal(all.series.reduce((total, point) => total + Object.values(point.domains).reduce((sum, value) => sum + value.pageviews, 0), 0), 5);
  assert.equal(all.series.reduce((total, point) => total + Object.values(point.domains).reduce((sum, value) => sum + value.visits, 0), 0), 3);
  assert.equal(all.pages[0].key, "/");
  assert.equal(all.pages[0].pageviews, 4);
  assert.deepEqual(all.referrers.map((row) => row.key).sort(), ["google.com", "yandex.ru"]);

  const ru = store.pageviewSummary("24h", "tarkovstats.ru", now);
  assert.equal(ru.pageviews, 4);
  assert.equal(ru.visitors, 2);
  assert.equal(ru.visits, 2);

  const totalsOnly = store.pageviewSummary("24h", "all", now, false);
  assert.equal(totalsOnly.pageviews, 5);
  assert.deepEqual(totalsOnly.series, []);
  assert.deepEqual(totalsOnly.pages, []);

  const previous = store.pageviewSummary("24h", "all", now - DAY, false);
  // Stale visitor-c hit plus visitor-d's pre-window session start.
  assert.equal(previous.pageviews, 2);
  assert.equal(previous.visitors, 2);
  assert.equal(previous.visits, 2);
});

test("pageview storage keeps only anonymous facts and expires with retention", () => {
  const db = new DatabaseSync(":memory:");
  const store = createAnalyticsStore(db);
  const now = 200 * DAY;
  store.recordPageview({ occurredAt: now - 100 * DAY, host: "tarkovstats.ru", path: "/", visitorId: "ancient", referrerHost: null });
  store.recordPageview({ occurredAt: now - MINUTE, host: "tarkovstats.ru", path: "/", visitorId: "fresh", referrerHost: null });
  const columns = db.prepare("PRAGMA table_info(page_views)").all().map((row) => row.name);
  for (const forbidden of ["ip", "user_agent", "email", "url", "query", "user_sub", "search_text"]) {
    assert.equal(columns.includes(forbidden), false);
  }
  for (const required of ["occurred_at", "host", "path", "visitor_id", "referrer_host"]) {
    assert.equal(columns.includes(required), true);
  }
  store.cleanup(now);
  const remaining = db.prepare("SELECT visitor_id AS id FROM page_views").all().map((row) => row.id);
  assert.deepEqual(remaining, ["fresh"]);
});

test("pageview helpers filter bots and validate intake", () => {
  assert.equal(isBotUserAgent("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"), true);
  assert.equal(isBotUserAgent("curl/8.0"), true);
  assert.equal(isBotUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"), false);
  assert.equal(isBotUserAgent(null), false);
  assert.equal(isValidVisitorId("550e8400-e29b-41d4-a716-446655440000"), true);
  assert.equal(isValidVisitorId("short"), false);
  assert.equal(isValidVisitorId("has space"), false);
  assert.equal(isValidPageviewPath("/player/regular/123"), true);
  assert.equal(isValidPageviewPath("https://example.com/"), false);
  assert.equal(normalizeReferrerHost("https://Google.com/search?q=tarkov"), "google.com");
  assert.equal(normalizeReferrerHost("yandex.ru"), "yandex.ru");
  assert.equal(normalizeReferrerHost("not a host"), null);
  assert.equal(normalizeReferrerHost("/relative/path"), null);
  assert.equal(normalizeReferrerHost(null), null);
});

test("pageview intake rate-limits on the trusted proxy IP, not a client-controlled header", () => {
  const route = readFileSync(
    new URL("../app/api/pageview/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(route, /import \{ getClientIp \} from "@\/lib\/client-ip"/);
  assert.match(route, /rateLimited\(getClientIp\(request\), now\)/);
  // The pre-fix route read cf-connecting-ip then x-real-ip then XFF, all of which
  // a client behind Caddy can choose, which let anyone mint a fresh rate-limit
  // bucket per request.
  assert.equal(/x-forwarded-for|cf-connecting-ip/.test(route), false);
});
