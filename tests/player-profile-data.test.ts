/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- node:sqlite types are not present in the project's Node 20 type package.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { parseSeasonalProfile } from "../lib/seasonal-upstream.ts";
import {
  createSqliteSeasonalStore,
  initializeSeasonalSchema,
} from "../lib/seasonal/storage.ts";
import { PROFILE_SECTION_ORDER } from "../types/player-profile-view.ts";

const gameModeFixture = JSON.parse(readFileSync("tests/fixtures/seasonal-game-mode.json", "utf8"));
const profileViewSource = readFileSync("lib/player-profile-view.ts", "utf8");
const parserOptions = {
  enabled: true,
  confirmedContract: "game_mode",
  cycleId: "season-2026-01",
  seasonStartsAt: 1_783_000_000_000,
  seasonEndsAt: 1_784_000_000_000,
};

test("profile DTO keeps mastery between achievements and skills", () => {
  assert.deepEqual(PROFILE_SECTION_ORDER, [
    "overview",
    "progression",
    "risk",
    "comparison",
    "statistics",
    "achievements",
    "mastering",
    "skills",
  ]);
});

test("persistent profile view model is mode-aware without a regular fallback", () => {
  const start = profileViewSource.indexOf("export function buildPersistentProfileViewModel");
  const end = profileViewSource.indexOf("export function buildRegularProfileViewModel", start);
  assert.ok(start >= 0 && end > start);
  const persistentBuilder = profileViewSource.slice(start, end);

  assert.match(profileViewSource, /export type PersistentProfileViewInput[\s\S]*mode: "regular" \| "pve"/);
  assert.match(persistentBuilder, /mode: input\.mode/);
  assert.match(persistentBuilder, /cohortMode: input\.mode/);
  assert.match(persistentBuilder, /kind: input\.mode === "pve" \? "pve" : "pvp"/);
  assert.match(persistentBuilder, /PROFILE_SECTION_ORDER/);
  assert.match(persistentBuilder, /Object\.entries\(profile\.achievements\)/);
  assert.match(persistentBuilder, /input\.achievementIds/);
  assert.match(persistentBuilder, /skillRows\(profile\?\.skills \?\? stats\.commonSkills\)/);
  assert.match(persistentBuilder, /stats\.achievementUnlocks\?\.\[id\]/);
  assert.doesNotMatch(persistentBuilder, /buildRegularProfileViewModel/);
});

test("regular profile view model remains a compatibility wrapper", () => {
  assert.match(
    profileViewSource,
    /export function buildRegularProfileViewModel\([\s\S]*?return buildPersistentProfileViewModel\(input, risk\)/,
  );
});

function storageProfile(updatedAt: number, commonSkills?: unknown, withPortrait = false, weaponMastery?: unknown) {
  const profile = {
    mode: "seasonal",
    cycleId: "season-2026-01",
    aid: 42,
    nickname: "SkillsRoundTrip",
    profileUpdatedAt: updatedAt,
    lastAccessAt: updatedAt,
    lifetimePvpHours: 100,
    counters: {
      experience: 1_000,
      pmcRaids: 10,
      scavRaids: 2,
      pmcSurvived: 7,
      pmcDeaths: 3,
      pmcKills: 20,
      killedPmc: 8,
    },
  };
  if (commonSkills !== undefined) profile.commonSkills = commonSkills;
  if (weaponMastery !== undefined) profile.weaponMastery = weaponMastery;
  if (withPortrait) {
    profile.seasonalStats = {
      totalRaids: 12,
      survivedRaids: 7,
      totalKills: 22,
      deaths: 4,
      runThrough: 1,
      survivalRate: 58,
      kdRatio: 5.5,
      pmcKdRatio: 2.67,
      killsPerRaid: 1.83,
      pmcSurvivalRate: 70,
      level: 4,
      prestige: 1,
      longestWinStreak: 3,
      achievementsCount: 0,
    };
  }
  return profile;
}

test("Seasonal parser retains the latest Common skills JSON", () => {
  const profile = parseSeasonalProfile(gameModeFixture, parserOptions);
  assert.deepEqual(profile.commonSkills, gameModeFixture.profile.skills.Common);
});

test("Seasonal parser normalizes profile.skills.Mastering", () => {
  const payload = structuredClone(gameModeFixture);
  payload.profile.skills.Mastering = [
    { Id: "AK", Progress: 12 },
    { Id: "bad", Progress: -1 },
  ];
  const profile = parseSeasonalProfile(payload, parserOptions);
  assert.deepEqual(profile.weaponMastery, [{ id: "AK", progress: 12 }]);
});

test("SQLite Common skills survive storage round-trip and duplicate enrichment", async () => {
  const db = new DatabaseSync(":memory:");
  initializeSeasonalSchema(db);
  const store = createSqliteSeasonalStore(db);

  const first = storageProfile(1_783_501_200_000, undefined, true);
  await store.upsertProfile(first);
  await store.captureSnapshot(first, 1_783_501_200_100);
  assert.equal(db.prepare("SELECT common_skills FROM progression_snapshots").get().common_skills, null);

  const enriched = storageProfile(1_783_501_200_000, [
    { Id: "Endurance", Progress: 2, LastAccess: 1_783_501_200 },
  ], false, [{ id: "AK", progress: 12 }]);
  const duplicate = await store.captureSnapshot(enriched, 1_783_501_200_200);
  assert.equal(duplicate.status, "duplicate");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM progression_snapshots").get().n, 1);
  assert.deepEqual(
    JSON.parse(db.prepare("SELECT common_skills FROM progression_snapshots").get().common_skills),
    enriched.commonSkills,
  );
  assert.deepEqual(
    JSON.parse(db.prepare("SELECT weapon_mastery FROM progression_snapshots").get().weapon_mastery),
    enriched.weaponMastery,
  );
  assert.deepEqual((await store.getProfile({ mode: "seasonal", cycleId: "season-2026-01", aid: 42 })).commonSkills,
    enriched.commonSkills);
  assert.deepEqual((await store.getProfile({ mode: "seasonal", cycleId: "season-2026-01", aid: 42 })).weaponMastery,
    enriched.weaponMastery);
  db.close();
});
