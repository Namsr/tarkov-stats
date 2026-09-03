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

test("mode navigation cancels stale average, warm and comparison requests", async () => {
  const client = await readFile("lib/client-average-request.ts", "utf8");
  const header = await readFile("components/AveragePageHeader.tsx", "utf8");
  const averagePage = await readFile("app/average/page.tsx", "utf8");
  const switcher = await readFile("components/ProfileModeSwitch.tsx", "utf8");
  const panel = await readFile("components/ProgressionPanel.tsx", "utf8");
  const arena = await readFile("components/ArenaAverage.tsx", "utf8");
  const profileClient = await readFile("lib/client-profile-request.ts", "utf8");

  // Real underlying average fetch is abortable.
  assert.match(client, /fetchJson\(url,\s*signal\)/);
  assert.match(client, /fetch\(url,\s*signal \? \{ cache: "default", signal \}/);
  assert.match(client, /function raceWithAbort/);
  assert.match(client, /cancelAveragePrefetches/);
  assert.match(client, /prefetchControllers/);

  // Prefetch queue does not survive navigation.
  assert.match(header, /cancelAveragePrefetches/);
  assert.match(header, /return \(\) => cancelAveragePrefetches\(\)/);
  assert.match(averagePage, /cancelAveragePrefetches\(\)/);
  assert.match(arena, /cancelAveragePrefetches\(\)/);

  // Warm requests keep only the last mode active.
  assert.match(switcher, /warmTimelineController\?\.abort\(\)/);
  assert.match(switcher, /warmProfileController\?\.abort\(\)/);
  assert.match(switcher, /signal:\s*controller\.signal/);
  assert.match(switcher, /cancelModeSwitchWarms/);
  assert.match(profileClient, /signal\?: AbortSignal/);
  assert.match(profileClient, /warmPlayerProfileResponse\(url:\s*string,\s*signal\?: AbortSignal\)/);

  // Comparison timeline is cancelled by navigation, like the main timeline.
  const secondaryEffect = panel.slice(panel.indexOf("secondaryController.current = controller"));
  assert.match(secondaryEffect, /profile-mode-navigate/);
  assert.match(secondaryEffect, /window\.addEventListener\("profile-mode-navigate", abortForNavigation/);
});
