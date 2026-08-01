/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- Node's direct TypeScript runner requires explicit .ts imports.
import assert from "node:assert/strict";
import test from "node:test";
import { fetchCloudflareTrafficRange, normalizeTrafficPath, parseCloudflareTraffic } from "../lib/admin/cloudflare-analytics.ts";

const group = (count, visits, dimensions, sampleInterval = 1) => ({ count, sum: { visits }, avg: { sampleInterval }, dimensions });

test("Cloudflare RUM parser restricts domains, bots via query filter, admin paths, and dynamic account paths", () => {
  const account = {
    domains: [group(9, 4, { requestHost: "www.tarkovstats.ru" }), group(100, 50, { requestHost: "other.example" })],
    series: [group(5, 2, { requestHost: "tarkovstats.ru", requestPath: "/", datetimeHour: "2026-08-01T10:00:00Z" })],
    pages: [
      group(3, 1, { requestHost: "tarkovstats.ru", requestPath: "/player/123" }),
      group(2, 1, { requestHost: "tarkovstats.ru", requestPath: "/player/regular/456" }),
      group(7, 3, { requestHost: "tarkovstats.ru", requestPath: "/admin" }),
    ],
    referrers: [group(2, 1, { requestHost: "tarkovstats.ru", refererHost: "google.com" })],
    countries: [], devices: [], browsers: [],
  };
  const parsed = parseCloudflareTraffic(account, "all", 0, 8 * 86_400_000);
  assert.equal(parsed.pageviews, 9);
  assert.equal(parsed.sampled, true);
  assert.deepEqual(parsed.pages, [{ key: "/player/:account", pageviews: 5, visits: 2 }]);
  assert.equal(normalizeTrafficPath("/admin/stats"), "/admin");
});

test("Cloudflare provider sends a JSON GraphQL request and degrades safely", async () => {
  let body;
  const traffic = await fetchCloudflareTrafficRange(0, 1_000, "all", {
    accountId: "account",
    token: "secret",
    fetch: async (_url, init) => {
      body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ data: { viewer: { accounts: [{ domains: [], series: [], pages: [], referrers: [], countries: [], devices: [], browsers: [] }] } } }));
    },
  });
  assert.equal(body.variables.filter.AND[0].bot, 0);
  assert.equal(body.variables.filter.AND[1].OR.length, 4);
  assert.equal(body.variables.accountTag, "account");
  assert.equal(traffic.available, true);

  const unavailable = await fetchCloudflareTrafficRange(0, 1_000, "all", { accountId: "", token: "" });
  assert.equal(unavailable.reason, "not_configured");
});
