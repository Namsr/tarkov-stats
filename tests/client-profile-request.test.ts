/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- Node's direct TypeScript test runner requires explicit .ts imports.
import assert from "node:assert/strict";
import test from "node:test";
import {
  getCachedPlayerProfileResponse,
  loadPlayerProfileResponse,
  PlayerProfileResponseError,
  playerProfileRequestKey,
} from "../lib/client-profile-request.ts";

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

test("profile request keys keep identities and modes separate", () => {
  const regular = playerProfileRequestKey("/api/player/profile?aid=9000005&mode=regular");
  const seasonal = playerProfileRequestKey("/api/player/profile?aid=9000005&mode=seasonal&cycle=s1");
  const anotherCycle = playerProfileRequestKey("/api/player/profile?aid=9000005&mode=seasonal&cycle=s2");
  const anotherAid = playerProfileRequestKey("/api/player/profile?aid=9000006&mode=regular");
  assert.notEqual(regular, seasonal);
  assert.notEqual(seasonal, anotherCycle);
  assert.notEqual(regular, anotherAid);
});
