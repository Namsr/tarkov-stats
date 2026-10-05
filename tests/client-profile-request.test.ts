/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- Node's direct TypeScript test runner requires explicit .ts imports.
import assert from "node:assert/strict";
import test from "node:test";
import { scheduleArenaRiskPoll } from "../lib/arena/client-risk.ts";
import {
  getCachedPlayerProfileResponse,
  loadPlayerProfileResponse,
  PlayerProfileResponseError,
  playerProfileRequestKey,
} from "../lib/client-profile-request.ts";

const flushPoll = () => new Promise<void>((resolve) => setImmediate(resolve));
const arenaRiskResponse = (risk = { aid: 1265971, score: 0, version: { upstream: 100 } }, identity = { aid: 1265971, mode: "arena", cycleId: "persistent" }) => Response.json({ identity, risk });

test("Arena polling gets a zero score after a pending response and stops after success", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const received = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "/api/player/risk?aid=1265971&mode=arena");
    assert.equal(options.cache, "no-store");
    calls++;
    return calls === 1 ? arenaRiskResponse(null) : arenaRiskResponse();
  });
  const stop = scheduleArenaRiskPoll(1265971, 100, (risk) => received.push(risk));
  t.after(stop);
  t.mock.timers.tick(1_500);
  await flushPoll();
  assert.equal(calls, 1);
  assert.equal(received.length, 0);
  t.mock.timers.tick(3_000);
  await flushPoll();
  assert.equal(received[0].score, 0);
  t.mock.timers.tick(30_000);
  await flushPoll();
  assert.equal(calls, 2);
  assert.equal(received.length, 1);
});

test("Arena polling bounds retries across network, HTTP and stale-result failures", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    if (calls === 1) throw new Error("network");
    if (calls === 2) return new Response(null, { status: 503 });
    return arenaRiskResponse({ aid: 1265971, score: 20, version: { upstream: 99 } });
  });
  const received = [];
  const stop = scheduleArenaRiskPoll(1265971, 100, (risk) => received.push(risk));
  t.after(stop);
  for (const delay of [1_500, 3_000, 5_000, 30_000]) {
    t.mock.timers.tick(delay);
    await flushPoll();
  }
  assert.equal(calls, 3);
  assert.deepEqual(received, []);
});

test("Arena polling never applies another account, mode or cycle", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const identity of [
    { aid: 1, mode: "arena", cycleId: "persistent" },
    { aid: 1265971, mode: "regular", cycleId: "persistent" },
    { aid: 1265971, mode: "arena", cycleId: "other" },
  ]) {
    t.mock.method(globalThis, "fetch", async () => arenaRiskResponse(undefined, identity));
    const stop = scheduleArenaRiskPoll(1265971, 100, () => assert.fail("wrong identity applied"));
    t.mock.timers.tick(1_500);
    await flushPoll();
    stop();
  }
});

test("leaving Arena cancels its timer and ignores an in-flight response", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let release;
  let signal;
  let calls = 0;
  t.mock.method(globalThis, "fetch", (_url, options) => {
    calls++;
    signal = options.signal;
    return new Promise((resolve) => { release = resolve; });
  });
  const onRisk = () => assert.fail("unmounted page updated");
  const cancelBeforeFetch = scheduleArenaRiskPoll(1265971, 100, onRisk);
  cancelBeforeFetch();
  t.mock.timers.tick(1_500);
  await flushPoll();
  assert.equal(calls, 0);

  const cancelInFlight = scheduleArenaRiskPoll(1265971, 100, onRisk);
  t.mock.timers.tick(1_500);
  cancelInFlight();
  assert.equal(signal.aborted, true);
  release(arenaRiskResponse());
  await flushPoll();
  t.mock.timers.tick(30_000);
  await flushPoll();
  assert.equal(calls, 1);
});

test("twelve rapid mode returns share one automatic profile request", async () => {
  const plainUrl = "/api/player/profile?aid=9000001&mode=regular";
  const explicitCycleUrl = "/api/player/profile?mode=regular&cycle=persistent&aid=9000001";
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const request = async () => {
    calls += 1;
    await gate;
    return Response.json({
      identity: { aid: 9000001, mode: "regular", cycleId: "persistent" },
      stats: { nickname: "Cached" },
    });
  };

  const switches = Array.from({ length: 12 }, (_, index) =>
    loadPlayerProfileResponse(index % 2 === 0 ? plainUrl : explicitCycleUrl, { request }));
  assert.equal(calls, 1);
  release();
  const responses = await Promise.all(switches);

  assert.equal(calls, 1);
  assert.ok(responses.every((response) => response.body.stats.nickname === "Cached"));
  assert.equal(
    getCachedPlayerProfileResponse<{ stats: { nickname: string } }>(plainUrl)?.body.stats.nickname,
    "Cached",
  );
  await loadPlayerProfileResponse(plainUrl, { request: async () => { throw new Error("must not fetch"); } });
  assert.equal(calls, 1);
});

test("empty and malformed bodies never leak a JSON SyntaxError or poison retries", async () => {
  for (const [aid, payload] of [["9000002", ""], ["9000003", "{"]] as const) {
    const url = `/api/player/profile?aid=${aid}&mode=pve`;
    await assert.rejects(
      loadPlayerProfileResponse(url, { request: async () => new Response(payload, { status: 200 }) }),
      (error: unknown) => error instanceof PlayerProfileResponseError && !(error instanceof SyntaxError),
    );
    const retried = await loadPlayerProfileResponse(url, {
      request: async () => Response.json({ stats: { nickname: "Recovered" } }),
    });
    assert.equal(retried.body.stats.nickname, "Recovered");
  }
});

test("refresh requests always fetch and replace the canonical last-good cache", async () => {
  const refreshUrl = "/api/player/profile?aid=9000004&mode=arena&refresh=1";
  let calls = 0;
  const request = async () => {
    calls += 1;
    return Response.json({ stats: { nickname: `Refresh ${calls}` } });
  };

  await loadPlayerProfileResponse(refreshUrl, { force: true, request });
  assert.equal(getCachedPlayerProfileResponse<{ stats: { nickname: string } }>(refreshUrl)?.body.stats.nickname, "Refresh 1");
  await loadPlayerProfileResponse(refreshUrl, { force: true, request });
  assert.equal(calls, 2);
  assert.equal(getCachedPlayerProfileResponse<{ stats: { nickname: string } }>(refreshUrl)?.body.stats.nickname, "Refresh 2");
});

test("failed refreshes preserve the last-good response and non-2xx responses are not cached", async () => {
  const url = "/api/player/profile?aid=9000007&mode=pve";
  await loadPlayerProfileResponse(url, {
    request: async () => Response.json({ stats: { nickname: "Last good" } }),
  });
  await loadPlayerProfileResponse(`${url}&refresh=1`, {
    force: true,
    request: async () => Response.json({ error: "temporarily unavailable" }, { status: 503 }),
  });
  assert.equal(getCachedPlayerProfileResponse<{ stats: { nickname: string } }>(url)?.body.stats.nickname, "Last good");

  const missingUrl = "/api/player/profile?aid=9000008&mode=arena";
  await loadPlayerProfileResponse(missingUrl, {
    request: async () => Response.json({ code: "mode_profile_unavailable" }, { status: 404 }),
  });
  assert.equal(getCachedPlayerProfileResponse(missingUrl), null);
});

test("a consumer attaching after the last warmer aborts starts a fresh request", async () => {
  const url = "/api/player/profile?aid=9000009&mode=arena";
  const controller = new AbortController();
  let calls = 0;
  // The first call stays pending until aborted, exactly like a real fetch.
  const request = (_url: string, init: { signal: AbortSignal }) => {
    calls += 1;
    const call = calls;
    if (call > 1) return Promise.resolve(Response.json({ arena: { nickname: `Arena ${call}` } }));
    return new Promise<Response>((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    });
  };

  // A mode switch warms the destination profile, then unmounts in the same
  // React commit that mounts the destination page, which consumes without a
  // signal. React runs every cleanup before every effect in one synchronous
  // pass, so the consumer must attach in the same tick as the abort and must
  // not join the aborted request.
  const warm = loadPlayerProfileResponse(url, { request, signal: controller.signal });
  controller.abort();
  const mounted = loadPlayerProfileResponse(url, { request });

  await assert.rejects(warm, (error: unknown) => error.name === "AbortError");
  const response = await mounted;
  assert.equal(calls, 2);
  assert.equal(response.body.arena.nickname, "Arena 2");
});

test("an abort with a remaining consumer keeps the shared request alive", async () => {
  const url = "/api/player/profile?aid=9000010&mode=seasonal&cycle=persistent";
  let calls = 0;
  const request = async () => {
    calls += 1;
    return Response.json({ profile: { nickname: "Shared" } });
  };

  const controller = new AbortController();
  const warm = loadPlayerProfileResponse(url, { request, signal: controller.signal });
  const mounted = loadPlayerProfileResponse(url, { request });
  controller.abort();
  await assert.rejects(warm, (error: unknown) => error.name === "AbortError");

  const response = await mounted;
  assert.equal(calls, 1);
  assert.equal(response.body.profile.nickname, "Shared");
});

test("profile request keys keep identities and modes separate", () => {
  const regular = playerProfileRequestKey("/api/player/profile?aid=9000005&mode=regular");
  const seasonal = playerProfileRequestKey("/api/player/profile?aid=9000005&mode=seasonal&cycle=s1");
  const anotherCycle = playerProfileRequestKey("/api/player/profile?aid=9000005&mode=seasonal&cycle=s2");
  const anotherAid = playerProfileRequestKey("/api/player/profile?aid=9000006&mode=regular");
  assert.notEqual(regular, seasonal);
  assert.notEqual(seasonal, anotherCycle);
  assert.notEqual(regular, anotherAid);
});

test("a cached 200 with a foreign identity is only recoverable by forcing", async () => {
  const url = "/api/player/profile?aid=9000007&mode=regular&allowStaleRisk=1";
  let calls = 0;
  const request = async () => {
    calls += 1;
    return Response.json({ identity: { aid: calls === 1 ? 9999999 : 9000007 }, viewModel: {} });
  };

  // The first response is a 200, so the response cache keeps it for its whole
  // TTL. The showcase treats the mismatched identity as unusable and shows the
  // retry button...
  const first = await loadPlayerProfileResponse<{ identity: { aid: number }; viewModel: unknown }>(url, { request });
  assert.equal(first.ok, true);
  assert.equal(calls, 1);
  const usable = (body: { identity: { aid: number } }) => body.identity.aid === 9000007;
  assert.equal(usable(first.body), false);

  // ...but re-reading it without force hands back the same unusable body, so the
  // button would stay useless until the TTL expires.
  const cached = await loadPlayerProfileResponse<{ identity: { aid: number } }>(url, { request });
  assert.equal(calls, 1);
  assert.equal(usable(cached.body), false);

  // Forcing is what the retry does, and it reaches the network.
  const retried = await loadPlayerProfileResponse<{ identity: { aid: number } }>(url, { request, force: true });
  assert.equal(calls, 2);
  assert.equal(usable(retried.body), true);
  // The fresh body replaces the poisoned cache entry, so later readers are fine.
  const afterRetry = await loadPlayerProfileResponse<{ identity: { aid: number } }>(url, {
    request: async () => { throw new Error("must not fetch"); },
  });
  assert.equal(calls, 2);
  assert.equal(usable(afterRetry.body), true);
});

test("a throttled forced request is not cached, so the next retry reaches the network", async () => {
  const url = "/api/player/profile?aid=9000011&mode=regular&allowStaleRisk=1";
  let calls = 0;
  const throttled = async () => {
    calls += 1;
    return Response.json({ error: "rate_limited" }, { status: 429 });
  };

  // The showcase retry has to keep working after a throttled attempt, which is
  // the common failure once the 10/min profile bucket is spent. Nothing about a
  // 429 is cached, so every later click is a real request instead of a re-read
  // of the failed body.
  assert.equal((await loadPlayerProfileResponse(url, { request: throttled, force: true })).status, 429);
  assert.equal(getCachedPlayerProfileResponse(url), null);
  assert.equal((await loadPlayerProfileResponse(url, { request: throttled, force: true })).status, 429);
  assert.equal(calls, 2);

  // The retry that finally gets through becomes the cached body.
  const recovered = await loadPlayerProfileResponse<{ identity: { aid: number } }>(url, {
    force: true,
    request: async () => Response.json({ identity: { aid: 9000011 }, viewModel: {} }),
  });
  assert.equal(calls, 2);
  assert.equal(recovered.body.identity.aid, 9000011);
  assert.equal(getCachedPlayerProfileResponse<{ identity: { aid: number } }>(url)?.body.identity.aid, 9000011);
});
