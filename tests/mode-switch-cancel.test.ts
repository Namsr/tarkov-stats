/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- fixture provides minimal browser surface like client-average-request.test.ts
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const browser = {
  setTimeout,
  clearTimeout,
  requestIdleCallback(callback) { callback(); return 1; },
};
Object.defineProperty(globalThis, "window", { configurable: true, value: browser });
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: { connection: { effectiveType: "4g", saveData: false } },
});

const requests = await import("../lib/client-average-request.ts");
const profileRequests = await import("../lib/client-profile-request.ts");

test.afterEach(() => requests.resetAverageResponseCacheForTests());

test("mode switch aborts the underlying average fetch instead of only the consumer wait", async () => {
  let observedSignal = null;
  globalThis.fetch = (url, init) => {
    observedSignal = init?.signal ?? null;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        resolve(new Response(JSON.stringify({ total: 1 }), { status: 200 }));
      }, 80);
      observedSignal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      }, { once: true });
    });
  };

  const controller = new AbortController();
  const startedAt = Date.now();
  const pending = requests.loadAverageJson("/api/average?delayed-mode-switch", {
    signal: controller.signal,
    retryUnavailable: true,
  });
  const assertion = assert.rejects(pending, (error) => error?.name === "AbortError");
  setTimeout(() => controller.abort(), 10);
  await assertion;
  const elapsed = Date.now() - startedAt;

  assert.ok(observedSignal instanceof AbortSignal, "fetch must receive the navigation AbortSignal");
  assert.equal(observedSignal.aborted, true);
  // If only the consumer wait were cancelled, we would still wait ~80ms for the network.
  assert.ok(elapsed < 70, `abort must interrupt network quickly, took ${elapsed}ms`);
});

test("navigation cancels pending and active average prefetches", async () => {
  const signals = [];
  globalThis.fetch = (url, init) => {
    signals.push(init?.signal ?? null);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        resolve(new Response("{}", { status: 200 }));
      }, 40);
      const signal = init?.signal;
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      }, { once: true });
    });
  };

  requests.scheduleAveragePrefetch(["/prefetch-a", "/prefetch-b", "/prefetch-c"]);
  await new Promise((resolve) => setTimeout(resolve, 5));
  requests.cancelAveragePrefetches();
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.ok(signals.length >= 2, `expected active prefetches, got ${signals.length}`);
  for (const signal of signals) {
    assert.ok(signal instanceof AbortSignal, "prefetch fetch must be abortable");
    assert.equal(signal.aborted, true);
  }
});

test("concurrent signal loads of the same URL share one network request", async () => {
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return new Response(JSON.stringify({ total: 7 }), { status: 200 });
  };

  const firstController = new AbortController();
  const secondController = new AbortController();
  const [first, second] = await Promise.all([
    requests.loadAverageJson("/api/average?shared-signal", { signal: firstController.signal }),
    requests.loadAverageJson("/api/average?shared-signal", { signal: secondController.signal }),
  ]);

  assert.deepEqual(first, { total: 7 });
  assert.deepEqual(second, { total: 7 });
  assert.equal(fetches, 1);
});

test("aborting one signal consumer keeps the shared request alive for the other", async () => {
  let fetches = 0;
  globalThis.fetch = (url, init) => {
    fetches += 1;
    const signal = init?.signal ?? null;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        resolve(new Response(JSON.stringify({ total: 3 }), { status: 200 }));
      }, 30);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      }, { once: true });
    });
  };

  const firstController = new AbortController();
  const secondController = new AbortController();
  const first = requests.loadAverageJson("/api/average?shared-abort", { signal: firstController.signal });
  const second = requests.loadAverageJson("/api/average?shared-abort", { signal: secondController.signal });
  const firstAssertion = assert.rejects(first, (error) => error?.name === "AbortError");
  setTimeout(() => firstController.abort(), 5);
  const secondResult = await second;
  await firstAssertion;

  assert.deepEqual(secondResult, { total: 3 });
  assert.equal(fetches, 1);
});

test("prefetch and demand load of the same URL share one network request", async () => {
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return new Response(JSON.stringify({ total: 9 }), { status: 200 });
  };

  requests.scheduleAveragePrefetch(["/api/average?shared-prefetch"]);
  const demanded = await requests.loadAverageJson("/api/average?shared-prefetch");
  // Let a duplicate prefetch settle if it escaped dedup.
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.deepEqual(demanded, { total: 9 });
  assert.equal(fetches, 1);
});

test("second mode aborts the first request while completing itself", async () => {
  globalThis.fetch = (url, init) => {
    const signal = init?.signal ?? null;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        resolve(new Response(JSON.stringify({ url }), { status: 200 }));
      }, 30);
      if (signal) {
        if (signal.aborted) {
          clearTimeout(timer);
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("Aborted", "AbortError"));
        }, { once: true });
      }
    });
  };

  const firstController = new AbortController();
  const first = requests.loadAverageJson("/api/average?mode=regular", { signal: firstController.signal });
  const firstAssertion = assert.rejects(first, (error) => error?.name === "AbortError");
  await new Promise((resolve) => setTimeout(resolve, 5));
  firstController.abort();

  const secondController = new AbortController();
  const second = await requests.loadAverageJson("/api/average?mode=pve", { signal: secondController.signal });

  await firstAssertion;
  assert.deepEqual(second, { url: "/api/average?mode=pve" });
});

test("cancelAveragePrefetches never aborts a demand load that took over a prefetch", async () => {
  let fetches = 0;
  globalThis.fetch = (url, init) => {
    fetches += 1;
    const signal = init?.signal ?? null;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        resolve(new Response(JSON.stringify({ total: 5 }), { status: 200 }));
      }, 30);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      }, { once: true });
    });
  };

  requests.scheduleAveragePrefetch(["/api/average?takeover"]);
  const demanded = requests.loadAverageJson("/api/average?takeover");
  // Navigation cancels best-effort prefetches while the demand is in flight.
  requests.cancelAveragePrefetches();
  const result = await demanded;

  assert.deepEqual(result, { total: 5 });
  assert.equal(fetches, 1);
});

test("concurrent profile signal loads share one network request", async () => {
  const stamp = Date.now();
  const url = `/api/player/profile?aid=9100001&mode=regular&probe=${stamp}`;
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const customRequest = async () => {
    calls += 1;
    await gate;
    return Response.json({ stats: { nickname: "Shared" } });
  };

  const firstController = new AbortController();
  const secondController = new AbortController();
  const first = profileRequests.loadPlayerProfileResponse(url, {
    signal: firstController.signal,
    request: customRequest,
  });
  const second = profileRequests.loadPlayerProfileResponse(url, {
    signal: secondController.signal,
    request: customRequest,
  });
  assert.equal(calls, 1);
  release();
  const [firstResponse, secondResponse] = await Promise.all([first, second]);

  assert.equal(calls, 1);
  assert.equal(firstResponse.body.stats.nickname, "Shared");
  assert.equal(secondResponse.body.stats.nickname, "Shared");
});

test("mode navigation wiring keeps only the last request alive", async () => {
  const header = await readFile("components/AveragePageHeader.tsx", "utf8");
  const averagePage = await readFile("app/average/page.tsx", "utf8");
  const switcher = await readFile("components/ProfileModeSwitch.tsx", "utf8");
  const panel = await readFile("components/ProgressionPanel.tsx", "utf8");

  // Prefetch queue does not survive navigation, demand loads take over prefetches.
  assert.match(header, /scheduleAveragePrefetch/);
  assert.match(header, /cancelAveragePrefetches/);
  assert.match(averagePage, /cancelAveragePrefetches/);
  assert.match(averagePage, /averageRequestRef\.current\?\.abort/);

  // Warm controllers are per-instance and cleaned up on unmount.
  assert.match(switcher, /warmProfileRef/);
  assert.match(switcher, /warmTimelineRef/);
  assert.match(switcher, /useRef<AbortController \| null>/);
  assert.doesNotMatch(switcher, /let warmProfileController/);
  assert.doesNotMatch(switcher, /let warmTimelineController/);
  assert.doesNotMatch(switcher, /cancelModeSwitchWarms/);
  assert.match(switcher, /warmPlayerProfileResponse\(`\/api\/player\/profile\?\$\{params\}`/);

  // Timelines are cancelled by navigation.
  assert.match(panel, /profile-mode-navigate/);
  assert.match(panel, /secondaryController\.current\?\.abort/);
});
