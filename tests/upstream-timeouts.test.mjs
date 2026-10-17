import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { registerHooks } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { fetchTarkovJson, loadPlayerLevels, expToLevel } from "../lib/tarkov-api.ts";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      return { shortCircuit: true, url: pathToFileURL(resolve(specifier.slice(2) + ".ts")).href };
    }
    try { return nextResolve(specifier, context); } catch (error) {
      if (specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier)) return nextResolve(specifier + ".ts", context);
      throw error;
    }
  },
});
const { fetchSeasonalPayload, SeasonalFetchError } = await import("../lib/seasonal/fetch.ts");

const realTimeout = AbortSignal.timeout.bind(AbortSignal);

test("profile dependencies bound both response headers and body without losing fallbacks", async (t) => {
  const oldTemplate = process.env.SEASONAL_PROFILE_URL_TEMPLATE;
  process.env.SEASONAL_PROFILE_URL_TEMPLATE = "https://players.tarkov.dev/pvp-season/{aid}.json";
  t.after(() => {
    if (oldTemplate === undefined) delete process.env.SEASONAL_PROFILE_URL_TEMPLATE;
    else process.env.SEASONAL_PROFILE_URL_TEMPLATE = oldTemplate;
  });
  for (const dependency of ["levels", "seasonal"]) {
    for (const stage of ["headers", "body"]) {
      await t.test(dependency + " aborts while waiting for " + stage, { timeout: 5000 }, async (t) => {
        let received = false;
        let bodyStarted = false;
        const server = http.createServer((req, res) => {
          received = true;
          assert.equal(req.headers["user-agent"], "tarkovstats.ru");
          if (stage === "body") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.write('{"aid":');
            bodyStarted = true;
          }
          // Deliberately never finish headers/body: fetch must obey its signal.
        });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        t.after(async () => {
          const closed = new Promise((resolve) => server.close(resolve));
          server.closeAllConnections();
          await closed;
        });
        let deadlines = 0;
        t.mock.method(AbortSignal, "timeout", (ms) => {
          assert.equal(ms, 8000, "keep the same explicit dependency budget as profile fetches");
          deadlines++;
          return realTimeout(500);
        });
        const request = (_url, init) => fetchTarkovJson("http://127.0.0.1:" + server.address().port, init);
        if (dependency === "levels") {
          const levels = await loadPlayerLevels(request);
          assert.equal(expToLevel(2935114, levels), 36, "timeout must preserve the known-good XP table");
          assert.equal(levels.at(-1).level, 79);
        } else {
          await assert.rejects(fetchSeasonalPayload(730001, { request }), (error) =>
            error.name === "TimeoutError" || error.name === "AbortError");
        }
        assert.equal(deadlines, 1);
        assert.equal(received, true);
        assert.equal(bodyStarted, stage === "body");
      });
    }
  }
});

test("Seasonal timeout leaves versioned refresh requests and HTTP error classification intact", async (t) => {
  const oldTemplate = process.env.SEASONAL_PROFILE_URL_TEMPLATE;
  process.env.SEASONAL_PROFILE_URL_TEMPLATE = "https://players.tarkov.dev/pvp-season/{aid}.json";
  t.after(() => {
    if (oldTemplate === undefined) delete process.env.SEASONAL_PROFILE_URL_TEMPLATE;
    else process.env.SEASONAL_PROFILE_URL_TEMPLATE = oldTemplate;
  });
  const payload = { aid: 730001, updated: 1783000000000 };
  const request = async (input, init) => {
    const url = new URL(input);
    assert.equal(url.pathname, "/pvp-season/730001.json");
    assert.equal(url.searchParams.get("v"), String(payload.updated));
    assert.equal(init.cache, "no-store");
    assert.ok(init.signal instanceof AbortSignal);
    return Response.json(payload);
  };
  assert.deepEqual(await fetchSeasonalPayload(payload.aid, {
    force: true, expectedUpdatedAt: payload.updated, request,
  }), payload);
  for (const status of [404, 503]) {
    await assert.rejects(fetchSeasonalPayload(payload.aid, {
      request: async () => new Response(null, { status }),
    }), (error) => error instanceof SeasonalFetchError && error.status === status);
  }
});
