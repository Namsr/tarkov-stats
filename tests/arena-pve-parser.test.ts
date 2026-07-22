/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- Node's direct TypeScript test runner requires explicit .ts imports.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import type { PlayerProfile } from "../types/tarkov.ts";

const source = await readFile(new URL("../lib/tarkov-api.ts", import.meta.url), "utf8");
const profileRouteSource = await readFile(new URL("../app/api/player/profile/route.ts", import.meta.url), "utf8");
const javascript = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const tested = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);
const { getPublicProfile, lastSkillAccessSeconds, parseArenaProfileStats, PVE_SKILL_CUTOFF_SECONDS, pveProfileDecision } = tested;

const base = { aid: 1, info: { nickname: "Test", side: "Savage", experience: 0 } };

test("Arena parser aggregates canonical mode counters and handles zero deaths", () => {
  const profile = {
    ...base,
    stat: { totalInGameTime: 5_400, arenaOverAllCounters: {
      UnrankedOverall: { Counters: {
        KillsWithoutDeaths: 2, MaxKillsWithoutDeaths: 9, LongestWinStreak: 4,
        BestArp: 1750, LoseStreak: 1, LongestLoseStreak: 3,
      } },
      UnrankedTeamFight: { Counters: {
        Kills: 10, Deaths: 4, MaxKillsWithoutDeaths: 5,
        RoundMvpCount: 2, MatchMvpCount: 1, LongestWinStreak: 3,
      } },
      UnrankedLastHero: { Counters: { Kills: 6, Deaths: 0 } },
    } },
  } satisfies PlayerProfile;
  const stats = parseArenaProfileStats(profile);
  assert.equal(stats.arena?.totalKills, 16);
  assert.equal(stats.arena?.totalDeaths, 4);
  assert.equal(stats.arena?.kdRatio, 4);
  assert.equal(stats.arena?.modes[0].kdRatio, 2.5);
  assert.equal(stats.arena?.modes[1].kdRatio, 6);
  assert.equal(stats.arena?.bestArp, 1750);
  assert.equal(stats.hoursPlayed, 1.5);
});

test("PVE cutoff includes the boundary and uses the latest progressed skill", () => {
  const profile = (values: Array<[number, number]>): PlayerProfile => ({
    ...base,
    skills: { Common: values.map(([Progress, LastAccess], index) => ({
      Id: String(index), Progress, LastAccess, PointsEarnedDuringSession: 0,
    })) },
  });
  assert.equal(pveProfileDecision(profile([[1, PVE_SKILL_CUTOFF_SECONDS]])).state, "store");
  assert.equal(pveProfileDecision(profile([[1, PVE_SKILL_CUTOFF_SECONDS - 1]])).state, "skipped_before_cutoff");
  assert.equal(pveProfileDecision(profile([[0, PVE_SKILL_CUTOFF_SECONDS + 1], [1, 0]])).state, "skipped_missing_skill_date");
  assert.equal(lastSkillAccessSeconds(profile([[1, 10], [2, 20], [0, 30]])), 20);
});

test("public profile fetch uses the mode-specific static cache path", async () => {
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    urls.push(url);
    const modeShape = url.includes("/arena/")
      ? { stat: { arenaOverAllCounters: {} } }
      : { pmcStats: { eft: { overAllCounters: { Items: [] }, totalInGameTime: 0 } }, skills: { Common: [] } };
    return new Response(JSON.stringify({ ...base, aid: 5869253, ...modeShape }), { status: 200 });
  };
  try {
    await getPublicProfile(5869253, { force: true, mode: "pve" });
    await getPublicProfile(5869253, { force: true, mode: "arena" });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(urls, [
    "https://players.tarkov.dev/pve/5869253.json",
    "https://players.tarkov.dev/arena/5869253.json",
  ]);
});

test("mode profile refresh falls back to the last stored snapshot", () => {
  assert.match(profileRouteSource, /catch \(error\) \{\s*if \(stored\) return storedResponse\(stored\)/);
  assert.match(profileRouteSource, /if \(!profile\) \{\s*if \(stored\) return storedResponse\(stored\)/);
});
