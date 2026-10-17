import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "../types/comparison") {
      return { shortCircuit: true, url: pathToFileURL(resolve("types/comparison.ts")).href };
    }
    if (specifier === "../types/seasonal") {
      return { shortCircuit: true, url: pathToFileURL(resolve("types/seasonal.ts")).href };
    }
    if (specifier === "../types/arena") {
      return { shortCircuit: true, url: pathToFileURL(resolve("types/arena.ts")).href };
    }
    return nextResolve(specifier, context);
  },
});

const {
  adaptComparisonCohort,
  adaptComparisonProfile,
  buildComparisonCohortUrl,
  buildComparisonProfileUrl,
  parseComparisonScope,
} = await import("../lib/comparison-adapter.ts");

test("every Arena mode selects its own profile and cohort without falling back to totals", () => {
  const modes = ["overall", "teamFight", "lastHero", "checkpoint", "blastGang", "shootOutDuo"];
  const stats = index => ({ metrics: { kd_ratio: index, win_rate: index * 10, headshot_rate: null, kills_per_match: index, damage_per_match: index * 100 } });
  const payload = { identity: { aid: 42, mode: "arena", cycleId: "persistent" }, arena: {
    aid: 42, nickname: "Arena", overall: stats(0), modes: Object.fromEntries(modes.slice(1).map((mode, index) => [mode, stats(index + 1)])),
  } };
  for (const [index, mode] of modes.entries()) {
    const scope = { mode: "arena", cycleId: "persistent", arenaMode: mode };
    assert.deepEqual(parseComparisonScope(`mode=arena&arenaMode=${mode}`, null), { status: "available", scope });
    assert.equal(new URL(buildComparisonCohortUrl(scope, 42), "http://local").searchParams.get("arenaMode"), mode);
    const profile = adaptComparisonProfile(scope, 42, payload);
    assert.equal(profile?.identity.arenaMode, mode);
    assert.equal(profile?.metrics.kd_ratio, index);
    const cohort = { identity: { aid: 42, ...scope }, aid: 42, gameMode: "arena", mode, sampleN: 20, required: 20, percent: 30,
      strategy: "population", quality: "sufficient", reason: null, percentiles: null,
      metrics: Object.fromEntries(Object.entries(stats(index).metrics).map(([key, value]) => [key, { value, count: value === null ? 0 : 20 }])),
    };
    assert.equal(adaptComparisonCohort(scope, 42, cohort)?.benchmarks.kd_ratio.value, index);
    assert.equal(adaptComparisonCohort(scope, 42, { ...cohort, mode: "wrong" }), null);
    assert.equal(adaptComparisonCohort(scope, 42, { ...cohort, identity: { ...cohort.identity, arenaMode: "wrong" } }), null);
  }
  const teamFight = { mode: "arena", cycleId: "persistent", arenaMode: "teamFight" };
  assert.equal(adaptComparisonProfile(teamFight, 42, { ...payload, arena: { ...payload.arena, modes: {} } }), null);
  assert.equal(adaptComparisonProfile(teamFight, 42, { ...payload, identity: { ...payload.identity, arenaMode: "overall" } }), null);
});

test("comparison scope parsing is strict and pins Seasonal to the server cycle", () => {
  const cycleId = "season-2026-09";
  assert.deepEqual(parseComparisonScope("", cycleId), {
    status: "available",
    scope: { mode: "regular", cycleId: "persistent", arenaMode: null },
  });
  assert.deepEqual(parseComparisonScope("mode=pve", cycleId), {
    status: "available",
    scope: { mode: "pve", cycleId: "persistent", arenaMode: null },
  });
  assert.deepEqual(parseComparisonScope("mode=arena", cycleId), {
    status: "available",
    scope: { mode: "arena", cycleId: "persistent", arenaMode: "overall" },
  });
  assert.deepEqual(parseComparisonScope(`mode=seasonal&cycle=${cycleId}`, cycleId), {
    status: "available",
    scope: { mode: "seasonal", cycleId, arenaMode: null },
  });
  for (const query of [
    "mode=",
    "mode=regular&cycle=season-2026-09",
    "mode=regular&arenaMode=overall",
    "mode=arena&arenaMode=unknown",
    "mode=arena&arenaMode=teamFight&arenaMode=lastHero",
    "mode=arena&cycle=season-2026-09",
    `mode=seasonal&cycle=other&cycle=${cycleId}`,
    "mode=seasonal",
  ]) {
    assert.deepEqual(
      parseComparisonScope(query, query === "mode=seasonal" ? null : cycleId),
      { status: "unavailable", scope: null },
    );
  }
});

test("comparison URL builders select endpoint, identity, and optional refresh", () => {
  const regular = { mode: "regular", cycleId: "persistent", arenaMode: null };
  const arena = { mode: "arena", cycleId: "persistent", arenaMode: "overall" };
  const seasonal = { mode: "seasonal", cycleId: "season-2026-09", arenaMode: null };
  assert.equal(
    buildComparisonProfileUrl(regular, 42),
    "/api/player/profile?aid=42&mode=regular&cycle=persistent",
  );
  assert.match(buildComparisonProfileUrl(regular, 42, { refresh: true }), /&refresh=1$/);
  assert.match(buildComparisonCohortUrl(regular, 42), /^\/api\/average\/cohort\?/);
  assert.match(buildComparisonCohortUrl(regular, 42), /period=90d/);
  assert.match(buildComparisonCohortUrl(arena, 42), /mode=arena/);
  assert.match(buildComparisonCohortUrl(arena, 42), /arenaMode=overall/);
  assert.match(buildComparisonCohortUrl(seasonal, 42), /^\/api\/seasonal\/cohort\?/);
  assert.match(buildComparisonCohortUrl(seasonal, 42), /cycle=season-2026-09/);
});

test("comparison profile adapter enforces identity, source precedence, and Arena shape", () => {
  const regular = { mode: "regular", cycleId: "persistent", arenaMode: null };
  const payload = {
    identity: { aid: 42, mode: "regular", cycleId: "persistent" },
    comparisonStats: {
      kdRatio: 0,
      pmcKdRatio: null,
      killsPerRaid: 1.5,
      pmcSurvivalRate: 0,
      longestWinStreak: 0,
      level: null,
      pvpStatsKnown: false,
    },
    stats: {
      nickname: "Stats",
      kdRatio: 9,
      pmcKdRatio: 9,
      killsPerRaid: 9,
      pmcSurvivalRate: 9,
      longestWinStreak: 9,
      level: 9,
      pvpStatsKnown: true,
    },
  };
  const profile = adaptComparisonProfile(regular, 42, payload);
  assert.equal(profile?.nickname, "Stats");
  assert.deepEqual(profile?.metrics, {
    kd_ratio: 0,
    pmc_kd_ratio: null,
    kills_per_raid: 1.5,
    killed_pmc_per_raid: null,
    pmc_survival_rate: 0,
    longest_win_streak: 0,
    level: null,
  });
  assert.equal(adaptComparisonProfile(regular, 43, payload), null);
  assert.equal(adaptComparisonProfile(regular, 42, {
    ...payload,
    comparisonStats: undefined,
    identity: { aid: 42, mode: "regular", cycleId: "other" },
  }), null);

  const arena = { mode: "arena", cycleId: "persistent", arenaMode: "overall" };
  const arenaPayload = {
    identity: { aid: 42, mode: "arena", cycleId: "persistent" },
    stats: { kdRatio: 99 },
    arena: {
      aid: 42,
      nickname: "Arena",
      overall: {
        metrics: {
          kd_ratio: 0,
          win_rate: 50,
          headshot_rate: null,
          kills_per_match: 3,
          damage_per_match: 400,
        },
      },
    },
  };
  const arenaProfile = adaptComparisonProfile(arena, 42, arenaPayload);
  assert.equal(arenaProfile?.metrics.kd_ratio, 0);
  assert.equal(arenaProfile?.metrics.win_rate, 50);
  assert.equal(arenaProfile?.metrics.headshot_rate, null);
  assert.equal(adaptComparisonProfile(arena, 42, {
    ...arenaPayload,
    arenaStatus: "legacy_incomplete",
  }), null);
  assert.equal(adaptComparisonProfile(arena, 42, {
    ...arenaPayload,
    arena: { ...arenaPayload.arena, aid: 43 },
  }), null);
});

test("comparison cohort adapter normalizes endpoint shapes and capability", () => {
  const averageKeys = [
    "kd_ratio",
    "pmc_kd_ratio",
    "kills_per_raid",
    "killed_pmc_per_raid",
    "pmc_survival_rate",
    "longest_win_streak",
    "level",
  ];
  const averages = Object.fromEntries(averageKeys.map((key) => [key, { value: key === "kd_ratio" ? 0 : 2, count: 20 }]));
  const percentiles = Object.fromEntries(averageKeys.map((key) => [
    key,
    { percentile: 50, count: 20, below: 10, equal: 2 },
  ]));
  const regular = { mode: "regular", cycleId: "persistent", arenaMode: null };
  const persistentPayload = {
    identity: { aid: 42, mode: "regular", cycleId: "persistent" },
    twoDimensional: true,
    n: 20,
    required: 20,
    percent: 10,
    strategy: "matched",
    quality: "sufficient",
    reason: null,
    actualRanges: {
      hours: { min: 90, max: 110 },
      pmcRaids: { min: 18, max: 22 },
      raids: { min: 18, max: 22 },
    },
    averages,
    percentiles,
  };
  const cohort = adaptComparisonCohort(regular, 42, persistentPayload);
  assert.equal(cohort?.benchmarks.kd_ratio.value, 0);
  assert.equal(cohort?.benchmarks.killed_pmc_per_raid.value, 2);
  assert.equal(cohort?.percentiles.kd_ratio.percentile, 50);
  assert.deepEqual(cohort?.actualRanges.hours, { min: 90, max: 110 });
  const unavailable = adaptComparisonCohort(regular, 42, {
    ...persistentPayload,
    n: 2,
    quality: "unavailable",
    reason: "insufficient_cohort",
  });
  assert.equal(unavailable?.benchmarks.kd_ratio.value, null);
  assert.equal(unavailable?.percentiles.kd_ratio.percentile, null);
  assert.equal(adaptComparisonCohort(regular, 42, {
    ...persistentPayload,
    identity: { aid: 43, mode: "regular", cycleId: "persistent" },
  }), null);

  const seasonal = { mode: "seasonal", cycleId: "season-2026-09", arenaMode: null };
  const seasonalCohort = adaptComparisonCohort(seasonal, 42, {
    ...persistentPayload,
    identity: { aid: 42, mode: "seasonal", cycleId: "season-2026-09" },
    percentiles: null,
  });
  assert.equal(seasonalCohort?.percentiles, null);
  assert.equal(adaptComparisonCohort(seasonal, 42, persistentPayload), null);

  const arena = { mode: "arena", cycleId: "persistent", arenaMode: "overall" };
  const arenaCohort = adaptComparisonCohort(arena, 42, {
    identity: { aid: 42, mode: "arena", cycleId: "persistent", arenaMode: "overall" },
    gameMode: "arena",
    aid: 42,
    mode: "overall",
    sampleN: 20,
    required: 20,
    percent: 30,
    strategy: "population",
    quality: "sufficient",
    reason: null,
    metrics: {
      kd_ratio: { value: 0, count: 20 },
      win_rate: { value: 50, count: 20 },
      headshot_rate: { value: null, count: 0 },
      kills_per_match: { value: 3, count: 20 },
      damage_per_match: { value: 400, count: 20 },
    },
    percentiles: null,
  });
  assert.equal(arenaCohort?.n, 20);
  assert.equal(arenaCohort?.benchmarks.kd_ratio.value, 0);
  assert.equal(arenaCohort?.percentiles, null);
  assert.deepEqual(arenaCohort?.actualRanges, { hours: null, pmcRaids: null, raids: null });
});

test("comparison profile adapter carries exact PMC kills per raid and preserves known zero", () => {
  const scope = { mode: "pve", cycleId: "persistent", arenaMode: null };
  const identity = { aid: 42, ...scope };
  const stats = { pmcRaids: 10, pmcKilledPmc: 5, killedPmc: 999, pmcKillsPerRaid: 99, pvpStatsVersion: 1 };
  assert.equal(adaptComparisonProfile(scope, 42, { identity, stats }).metrics.killed_pmc_per_raid, .5);
  for (const [patch, expected] of [[{ pmcKilledPmc: 0 }, 0], [{ pmcKilledPmc: null }, null],
    [{ pvpStatsVersion: 0 }, null], [{ pmcRaids: 0 }, null]]) {
    assert.equal(adaptComparisonProfile(scope, 42, { identity, stats: { ...stats, ...patch } }).metrics.killed_pmc_per_raid, expected);
  }
  assert.equal(adaptComparisonProfile(scope, 42, { identity, comparisonStats: { killedPmcPerRaid: 0 } }).metrics.killed_pmc_per_raid, 0);
  assert.equal(adaptComparisonProfile(scope, 42, { identity, comparisonStats: { killedPmcPerRaid: null }, stats }).metrics.killed_pmc_per_raid, null);
});


const selectionStore = await import("../lib/comparison-selection.ts");

test("profile comparison fills slots, avoids duplicates, and replaces only the second full slot", () => {
  const regular = { mode: "regular", cycleId: "persistent", arenaMode: null };
  const { addComparisonPlayer } = selectionStore;
  const first = addComparisonPlayer(regular, 42, null);
  assert.deepEqual(first, { scope: regular, primary: 42, secondary: null });
  assert.deepEqual(addComparisonPlayer(regular, 42, first), first);
  const pair = addComparisonPlayer(regular, 43, first);
  assert.deepEqual(pair, { scope: regular, primary: 42, secondary: 43 });
  assert.deepEqual(addComparisonPlayer(regular, 43, pair), pair);
  assert.deepEqual(addComparisonPlayer(regular, 44, pair), { ...pair, secondary: 44 });
  assert.deepEqual(addComparisonPlayer(regular, 44, { ...pair, primary: null }), { ...pair, primary: 44 });
  for (const aid of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => addComparisonPlayer(regular, aid, first), TypeError);
  }
});

test("comparison cookies round-trip each profile scope and preserve IDs across the clicked mode", () => {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  let cookie = "";
  Object.defineProperty(globalThis, "document", { configurable: true, value: { get cookie() { return cookie; }, set cookie(value) { cookie = value; } } });
  Object.defineProperty(globalThis, "location", { configurable: true, value: { protocol: "https:" } });
  try {
    const { addComparisonPlayer, readComparisonSelection, saveComparisonSelection, comparisonSelectionParams } = selectionStore;
    let saved = null;
    const scopes = [
      { mode: "regular", cycleId: "persistent", arenaMode: null },
      { mode: "pve", cycleId: "persistent", arenaMode: null },
      { mode: "seasonal", cycleId: "season-2026", arenaMode: null },
      ...["overall", "teamFight", "lastHero", "checkpoint", "blastGang", "shootOutDuo"].map(arenaMode => ({ mode: "arena", cycleId: "persistent", arenaMode })),
    ];
    for (const [index, scope] of scopes.entries()) {
      saved = addComparisonPlayer(scope, 42 + index, saved);
      saveComparisonSelection(saved);
      assert.match(cookie, /Max-Age=15552000; Path=\/; SameSite=Lax; Secure$/);
      assert.deepEqual(readComparisonSelection(), saved);
      const params = comparisonSelectionParams(saved);
      assert.deepEqual(parseComparisonScope(params, scope.mode === "seasonal" ? scope.cycleId : null).scope, scope);
      assert.equal(params.get("aid"), "42");
      assert.equal(params.get("vs"), index === 0 ? null : String(42 + index));
    }
    for (const query of ["mode=unknown&aid=42", "mode=seasonal&cycle=persistent&aid=42", "mode=regular&aid=-1", "mode=regular&aid=1e2", "mode=regular&aid=9007199254740992", "mode=regular&aid=42&aid=43", "mode=arena&arenaMode=axis&aid=42", "mode=pve&vs=NaN", "x".repeat(513)]) {
      cookie = `comparison_selection=${encodeURIComponent(query)}`;
      assert.equal(readComparisonSelection(), null, query);
    }
    cookie = "comparison_selection=%broken";
    assert.equal(readComparisonSelection(), null);
    Object.defineProperty(globalThis, "document", { configurable: true, value: { get cookie() { throw new Error("blocked"); }, set cookie(_) { throw new Error("blocked"); } } });
    assert.equal(readComparisonSelection(), null);
    assert.doesNotThrow(() => saveComparisonSelection(saved));
  } finally {
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument); else delete globalThis.document;
    if (previousLocation) Object.defineProperty(globalThis, "location", previousLocation); else delete globalThis.location;
  }
});

test("the profile button carries its player, mode, seasonal cycle and Arena submode into navigation", async () => {
  const { readFile } = await import("node:fs/promises");
  const { createRequire } = await import("node:module");
  const { default: ts } = await import("typescript");
  const { dict } = await import("../lib/i18n/dictionary.ts");
  const require = createRequire(import.meta.url);
  const source = await readFile("components/ProfileCompareButton.tsx", "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const cases = [
    [{ aid: 42, mode: "regular" }, "mode=regular&aid=42"],
    [{ aid: 42, mode: "pve" }, "mode=pve&aid=42"],
    [{ aid: 42, mode: "seasonal", cycleId: "season-2026" }, "mode=seasonal&cycle=season-2026&aid=42"],
    [{ aid: 42, mode: "arena", arenaMode: "teamFight" }, "mode=arena&arenaMode=teamFight&aid=42"],
  ];
  for (const lang of ["ru", "en"]) {
    for (const [props, query] of cases) {
      let destination;
      let saved;
      const exports = {};
      const mockedRequire = id => id === "next/navigation" ? { useRouter: () => ({ push: url => { destination = url; } }) }
        : id === "@/lib/i18n/context" ? { useI18n: () => ({ t: key => dict[lang][key] }) }
          : id === "@/lib/comparison-selection" ? { ...selectionStore, readComparisonSelection: () => null, saveComparisonSelection: value => { saved = value; } }
            : require(id);
      new Function("require", "exports", compiled)(mockedRequire, exports);
      const button = exports.default(props);
      assert.equal(button.props.type, "button");
      assert.equal(button.props["aria-label"], dict[lang]["compare.button"]);
      assert.equal(button.props.title, dict[lang]["compare.button"]);
      assert.equal(button.props.children.type, "svg");
      assert.equal(button.props.children.props["aria-hidden"], "true");
      assert.equal(button.props.disabled, false);
      button.props.onClick();
      assert.equal(destination, `/compare?${query}`);
      assert.equal(saved.primary, 42);
      assert.equal(saved.scope.mode, props.mode);
      const unavailable = exports.default({ aid: 42, mode: "seasonal" });
      assert.equal(unavailable.props.disabled, true);
    }
  }
});
