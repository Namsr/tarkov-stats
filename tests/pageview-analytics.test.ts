/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- Node's direct TypeScript runner requires explicit .ts imports.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createAnalyticsStore } from "../lib/admin/analytics-db.ts";
import {
  isBotUserAgent,
  isValidPageviewPath,
  isValidVisitorId,
  normalizeReferrerHost,
} from "../lib/admin/pageviews.ts";

// The intake route imports `next/server` and `@/…`, which the bare runner cannot
// resolve. Registered at module top level so the hook is live before the dynamic
// imports below, the shape tests/arena-routes.test.ts uses.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "next/server") return nextResolve("next/server.js", context);
    if (specifier.startsWith("@/")) {
      return { shortCircuit: true, url: pathToFileURL(resolve(`${specifier.slice(2)}.ts`)).href };
    }
    return nextResolve(specifier, context);
  },
});

const intake = mkdtempSync(join(tmpdir(), "tarkov-pageview-intake-"));
process.env.ADMIN_ANALYTICS_SQLITE_PATH = join(intake, "admin-analytics.db");
// lib/client-ip.ts resolves the trusted header once at module load, so pin it
// before the route is imported. That is already the production default; setting
// it only removes an ambient override from the environment.
process.env.TRUSTED_IP_HEADER = "x-real-ip";

const { POST: postPageview } = await import("../app/api/pageview/route.ts");
const { NextRequest } = await import("next/server");

const DAY = 86_400_000;
const MINUTE = 60_000;
const MAX_HITS = 60;
// app/api/pageview/route.ts:30 denies at `hits.length > RATE_LIMIT_MAX_HITS`, so
// the 61st request in a window is the first one rejected — not the 60th.
const OVERFLOW = MAX_HITS + 1;
// isBotUserAgent rejects anything matching lib/admin/pageviews.ts:14, so the
// beacon has to look like a browser or intake drops it before recording.
const BEACON_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/** One accepted beacon. Only the headers under test change between calls. */
function beacon(headers) {
  return new NextRequest("http://web:3000/api/pageview", {
    method: "POST",
    headers: {
      "user-agent": BEACON_USER_AGENT,
      "content-type": "application/json",
      "x-forwarded-host": "tarkovstats.ru",
      ...headers,
    },
    body: JSON.stringify({
      path: "/player/regular/123",
      visitor: "550e8400-e29b-41d4-a716-446655440000",
    }),
  });
}

async function burst(headerFor) {
  const startedAt = Date.now();
  const responses = [];
  for (let index = 0; index < OVERFLOW; index += 1) {
    responses.push(await postPageview(beacon(headerFor(index))));
  }
  // Guards the premise: a burst that outlived the window would prove nothing.
  assert.ok(Date.now() - startedAt < MINUTE, "the burst must stay inside one window");
  return responses;
}

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

test("pageview intake ignores a rotating spoofed header and still caps the resolved IP", async () => {
  // The pre-fix route read cf-connecting-ip first, so rotating it gave every
  // request a fresh 60/min bucket and all 61 beacons were accepted.
  const responses = await burst((index) => ({
    "x-real-ip": "203.0.113.10",
    "cf-connecting-ip": `198.51.100.${index}`,
  }));
  assert.deepEqual(responses.slice(0, MAX_HITS).map((response) => response.status), Array(MAX_HITS).fill(204));

  const rejected = responses[MAX_HITS];
  assert.equal(rejected.status, 429);
  assert.deepEqual(await rejected.json(), { error: "rate_limited" });
  assert.equal(rejected.headers.get("cache-control"), "no-store");
});

test("pageview intake caps beacons that share the trusted header, and leaves other IPs alone", async () => {
  // Same trusted header, but the XFF entry rotates instead. XFF is equally
  // client-chosen behind Caddy, so it must not be part of the bucket key either.
  const responses = await burst((index) => ({
    "x-real-ip": "203.0.113.20",
    "x-forwarded-for": `198.51.100.${index}`,
  }));
  assert.deepEqual(responses.slice(0, MAX_HITS).map((response) => response.status), Array(MAX_HITS).fill(204));
  assert.equal(responses[MAX_HITS].status, 429);

  // A different resolved IP starts on its own budget, so the key really is the
  // resolved IP and not a process-wide counter.
  assert.equal((await postPageview(beacon({ "x-real-ip": "203.0.113.21" }))).status, 204);
});

test("pageview intake keeps the rate-limit key on the shared fail-closed helper", () => {
  // Two layers on purpose. The two tests above prove the cap actually holds;
  // this one pins the mechanism, so a later edit that reintroduces an inline
  // header read in the limiter fails with a pointed message instead of only
  // surfacing as a behavioural failure. It is scoped to the rate-limit key
  // expression on purpose: the header names themselves are not banned across
  // the file, so a legitimate non-rate-limit read (geo, say) still passes.
  const route = readFileSync(
    new URL("../app/api/pageview/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(route, /import \{ getClientIp \} from "@\/lib\/client-ip"/);
  const limitKey = route.match(/rateLimited\(([^,)]+)\)/);
  assert.ok(limitKey, "the intake handler must gate on the rate limiter");
  // The capture stops at the nested paren, so match the whole key expression.
  assert.match(limitKey[1], /^getClientIp\(request$/);
  // The pre-fix chain read cf-connecting-ip, then x-real-ip, then the first XFF
  // entry. All three are chosen by the client behind Caddy, so any of them in
  // the key minted a fresh bucket per request.
  assert.equal(/x-forwarded-for|cf-connecting-ip/.test(limitKey[1]), false);
});
