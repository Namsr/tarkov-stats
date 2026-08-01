/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- Node's direct TypeScript runner requires explicit .ts imports.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { registerHooks } from "node:module";
import test from "node:test";
// @ts-ignore -- Node 24 exposes node:sqlite at runtime; project types target Node 20.
import { DatabaseSync } from "node:sqlite";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      return { shortCircuit: true, url: pathToFileURL(resolve(`${specifier.slice(2)}.ts`)).href };
    }
    return nextResolve(specifier, context);
  },
});

const directory = mkdtempSync(join(tmpdir(), "tarkov-profile-capture-"));
const playersPath = join(directory, "players.db");
const progressionPath = join(directory, "progression.db");
process.env.SQLITE_PATH = playersPath;
process.env.BANS_SQLITE_PATH = join(directory, "bans.db");
process.env.PROGRESSION_SQLITE_PATH = directory;

const { makePlayerSnapshot } = await import("../lib/ban-db.ts");
const { snapshotFromOperatorProfile } = await import("../lib/operator-profile.ts");
const { persistRegularProfileSnapshot } = await import("../lib/regular-profile-capture.ts");
const { parseProfileStats } = await import("../lib/tarkov-api.ts");

function snapshot(updated, raids) {
  const profile = {
    aid: 6657203,
    updated,
    info: { nickname: "Capture", side: "Usec", experience: raids * 1000 },
    pmcStats: {
      eft: {
        totalInGameTime: raids * 3600,
        overAllCounters: { Items: [{ Key: ["Sessions", "Pmc"], Value: raids }] },
      },
    },
    achievements: {},
  };
  return makePlayerSnapshot(profile.aid, parseProfileStats(profile), [], updated);
}

test("Regular persistence is resilient publicly, strict operationally, and captures cache hits", async () => {
  const first = snapshot(1_700_000_000_000, 10);
  const originalError = console.error;
  console.error = () => {};
  try {
    assert.equal(await persistRegularProfileSnapshot(first), null);
  } finally {
    console.error = originalError;
  }
  const players = new DatabaseSync(playersPath);
  assert.equal(players.prepare("SELECT profile_updated_at FROM players WHERE aid = ?").get(first.aid).profile_updated_at, first.upstreamUpdatedAt);
  await assert.rejects(
    persistRegularProfileSnapshot(snapshot(first.upstreamUpdatedAt + 500, 11), { strict: true }),
  );

  process.env.PROGRESSION_SQLITE_PATH = progressionPath;
  assert.equal((await persistRegularProfileSnapshot(first, { strict: true }))?.status, "baseline");

  const cached = snapshot(first.upstreamUpdatedAt + 1_000, 11);
  assert.equal((await persistRegularProfileSnapshot(cached, {
    strict: true,
    upsertPlayer: false,
  }))?.status, "progression");
  assert.equal((await persistRegularProfileSnapshot(cached, {
    strict: true,
    upsertPlayer: false,
  }))?.status, "duplicate");

  const progression = new DatabaseSync(progressionPath);
  assert.equal(players.prepare("SELECT profile_updated_at FROM players WHERE aid = ?").get(first.aid).profile_updated_at, first.upstreamUpdatedAt);
  assert.equal(progression.prepare("SELECT COUNT(*) AS n FROM progression_snapshots WHERE aid = ?").get(first.aid).n, 2);
});

test("embedded Regular profiles without an upstream version fail closed every time", async () => {
  const payload = {
    aid: 6657203,
    mode: "regular",
    profile: {
      aid: 6657203,
      info: { nickname: "NoVersion", side: "Usec", experience: 1000 },
    },
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(
      snapshotFromOperatorProfile(payload, { upsertPlayer: false }),
      /profile\.updated must be a positive timestamp/,
    );
  }
});

test("favorites keep parsed stats when snapshot construction fails synchronously", () => {
  const source = readFileSync(resolve("app/api/favorites/stats/route.ts"), "utf8");
  const start = source.indexOf("const stats = parseProfileStats");
  const end = source.indexOf("// Only on a fresh upstream hit", start);
  assert.ok(start >= 0 && end > start);
  const persistence = source.slice(start, end);
  assert.match(persistence, /try \{\s*await persistRegularProfileSnapshot\(\s*makePlayerSnapshot/);
  assert.match(persistence, /catch \{\s*\/\/ A missing upstream version must not hide otherwise valid profile stats\./);
  assert.doesNotMatch(persistence, /\.catch\(/);
});
