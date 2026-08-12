/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- node:sqlite types are not present in the project's Node 20 type package.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { resolveSeasonalProfile } from "../lib/seasonal/profile-service.ts";
import { createSqliteSeasonalStore } from "../lib/seasonal/storage.ts";
import { LEGACY_IDENTITY, normalizeCycleId } from "../types/seasonal.ts";
import { loadSeasonalCycleConfig } from "../lib/seasonal/config.ts";
import { validateSeasonalProfile } from "../lib/seasonal-upstream.ts";

const env = {
  SEASONAL_ENABLED: "true",
  SEASONAL_CYCLE_ID: "season-2026-01",
  SEASONAL_STARTS_AT: "2026-07-01T00:00:00Z",
  SEASONAL_ENDS_AT: "2026-08-01T00:00:00Z",
  SEASONAL_UPSTREAM_CONTRACT: "game_mode",
};

async function fixture(): Promise<unknown> {
  return JSON.parse(await readFile(new URL("./fixtures/seasonal-game-mode.json", import.meta.url), "utf8"));
}

const cycleDependencies = {
  loadCycle: () => loadSeasonalCycleConfig(env),
  validatePayload: (payload: unknown, cycle: ReturnType<typeof loadSeasonalCycleConfig>) =>
    validateSeasonalProfile(payload, {
      enabled: cycle!.enabled,
      confirmedContract: cycle!.upstreamContract,
      cycleId: cycle!.cycleId,
      seasonStartsAt: cycle!.startsAt,
      seasonEndsAt: cycle!.endsAt,
    }),
};

test("legacy profile identity remains regular/persistent when mode and cycle are omitted", () => {
  assert.deepEqual(LEGACY_IDENTITY, { mode: "regular", cycleId: "persistent" });
  assert.equal(normalizeCycleId(null, "regular"), "persistent");
  assert.equal(normalizeCycleId(null, "seasonal"), null);
});

test("Seasonal profile fails closed without a confirmed network adapter", async () => {
  const result = await resolveSeasonalProfile(
    { aid: 730001, cycleId: "season-2026-01", force: false },
    { ...cycleDependencies, getStore: async () => null }
  );
  assert.deepEqual(result, {
    ok: false,
    status: 503,
    error: "Seasonal upstream endpoint is not configured",
  });
});

test("JSON collector may use a valid disabled cycle without exposing public Seasonal", async () => {
  const disabledDependencies = {
    ...cycleDependencies,
    loadCycle: () => loadSeasonalCycleConfig({ ...env, SEASONAL_ENABLED: "false" }),
    allowDisabledCycle: true,
    getStore: async () => null,
  };
  const denied = await resolveSeasonalProfile(
    { aid: 730001, cycleId: "season-2026-01", force: true },
    { ...disabledDependencies, allowDisabledCycle: false },
  );
  const allowed = await resolveSeasonalProfile(
    { aid: 730001, cycleId: "season-2026-01", force: true },
    disabledDependencies,
  );
  assert.equal(!denied.ok && denied.error, "Seasonal profile unavailable");
  assert.equal(!allowed.ok && allowed.error, "Seasonal upstream endpoint is not configured");
});

test("canonical Seasonal pipeline upserts and deduplicates capture by profile timestamp", async (t) => {
  let DatabaseSync: typeof import("node:sqlite").DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    t.skip("node:sqlite unavailable");
    return;
  }
  const store = createSqliteSeasonalStore(new DatabaseSync(":memory:"));
  const dependencies = {
    ...cycleDependencies,
    fetchPayload: async () => fixture(),
    getStore: async () => store,
    now: () => 1_783_600_000_000,
  };

  const linkedPayload = await fixture();
  const linked = validateSeasonalProfile(linkedPayload, {
    enabled: true,
    confirmedContract: "game_mode",
    cycleId: "season-2026-01",
    seasonStartsAt: loadSeasonalCycleConfig(env)!.startsAt,
    seasonEndsAt: loadSeasonalCycleConfig(env)!.endsAt,
  });
  assert.equal(linked.ok, true);
  if (linked.ok) {
    linked.profile.lifetimePvpHours = 321;
    await store.upsertProfile(linked.profile, 1_783_500_000_000);
  }

  const first = await resolveSeasonalProfile(
    { aid: 730001, cycleId: "season-2026-01", force: true },
    dependencies
  );
  const duplicate = await resolveSeasonalProfile(
    { aid: 730001, cycleId: "season-2026-01", force: true },
    dependencies
  );

  assert.equal(first.ok && first.capture.status, "baseline");
  assert.equal(first.ok && first.profile.lifetimePvpHours, 321);
  assert.equal(duplicate.ok && duplicate.capture.status, "duplicate");
  assert.equal((await store.snapshotHistory({ mode: "seasonal", cycleId: "season-2026-01", aid: 730001 })).length, 1);
});

test("normal profile loads use the latest stored capture without waiting for upstream", async (t) => {
  let DatabaseSync: typeof import("node:sqlite").DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    t.skip("node:sqlite unavailable");
    return;
  }
  const store = createSqliteSeasonalStore(new DatabaseSync(":memory:"));
  const first = await resolveSeasonalProfile(
    { aid: 730001, cycleId: "season-2026-01", force: true },
    { ...cycleDependencies, fetchPayload: async () => fixture(), getStore: async () => store },
  );
  assert.equal(first.ok, true);

  let upstreamCalls = 0;
  const fallback = await resolveSeasonalProfile(
    { aid: 730001, cycleId: "season-2026-01", force: false },
    {
      ...cycleDependencies,
      fetchPayload: async () => {
        upstreamCalls += 1;
        throw Object.assign(new Error("upstream 404"), { status: 404 });
      },
      getStore: async () => store,
    },
  );

  assert.equal(fallback.ok, true);
  assert.equal(upstreamCalls, 0);
  assert.equal(fallback.ok && fallback.capture.status, "stored");
  assert.equal(fallback.ok && fallback.profile.profileUpdatedAt, first.ok && first.profile.profileUpdatedAt);
  assert.deepEqual(fallback.ok && fallback.profile.seasonalAchievements, [{ id: "first_raid", unlockedAt: 1_783_495_000_000 }]);
});

test("expected-version captures do not treat a stored profile as a confirmed upstream response", async (t) => {
  let DatabaseSync: typeof import("node:sqlite").DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    t.skip("node:sqlite unavailable");
    return;
  }
  const store = createSqliteSeasonalStore(new DatabaseSync(":memory:"));
  await resolveSeasonalProfile(
    { aid: 730001, cycleId: "season-2026-01", force: true },
    { ...cycleDependencies, fetchPayload: async () => fixture(), getStore: async () => store },
  );
  const result = await resolveSeasonalProfile(
    { aid: 730001, cycleId: "season-2026-01", force: true, expectedUpdatedAt: 1_783_501_200_000 },
    {
      ...cycleDependencies,
      fetchPayload: async () => { throw Object.assign(new Error("upstream 404"), { status: 404 }); },
      getStore: async () => store,
    },
  );
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.status, 404);
});

test("canonical Seasonal pipeline rejects an upstream aid mismatch before persistence", async () => {
  let writes = 0;
  const result = await resolveSeasonalProfile(
    { aid: 999, cycleId: "season-2026-01", force: true },
    {
      ...cycleDependencies,
      fetchPayload: async () => fixture(),
      getStore: async () => {
        writes += 1;
        return null;
      },
    }
  );
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.status, 502);
  assert.equal(writes, 0);
});
