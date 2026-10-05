import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { evaluateBanCandidate, initializeBanImportDb, importBanCandidate, readArchivedBanProfile,
  waveCutoff, characterStatisticsJson, type BanProfile, type BanCandidate } from "../lib/ban-import.ts";
import { collectBanProfiles, discoverBanCandidates, createRateLimitedRequest, boundedText, publishBanArchive } from "../scripts/import-ban-list.mjs";

const candidate: BanCandidate = { aid: 42, nickname: "Player", waves: [
  { date: "2025-12-19", source: "https://example.com/bans", nicknames: ["Player"] },
] };
function input(mode: BanProfile["mode"] = "regular", access: number | null = 1766000000, updated = 1766100000000): BanProfile {
  return { mode, ...(mode === "seasonal" ? { cycleId: "s1" } : {}), raw: JSON.stringify({ aid: 42,
    info: { nickname: "Player", side: "Usec", experience: 10000 }, updated,
    skills: { Common: access === null ? [] : [{ Id: "Strength", Progress: 100, LastAccess: access }] },
    pmcStats: { eft: { totalInGameTime: 1234, overAllCounters: { Items: [{ Key: ["Sessions", "Pmc"], Value: 10 }] } } },
    stat: { totalInGameTime: 1234, arenaOverAllCounters: {} },
    achievements: { test: 1765900000 }, equipment: { Items: ["gear"] }, items: ["inventory"],
    hideout: { Areas: ["stash"] }, customization: { body: "cosmetic" },
  }) };
}
function db() { const result = new DatabaseSync(":memory:"); initializeBanImportDb(result); return result; }

test("PvP requires progressed-skill activity, never the JSON refresh date", () => {
  assert.equal(evaluateBanCandidate(candidate, [input("regular", null)]), "missing_skill_date");
  assert.equal(evaluateBanCandidate(candidate, []), "missing_pvp");
  assert.equal(evaluateBanCandidate(candidate, [input("regular", 1766000000, Date.parse("2026-10-05"))]), "accepted");
  const p = JSON.parse(input().raw); p.skills.Common[0].Progress = 0;
  assert.equal(evaluateBanCandidate(candidate, [{ mode: "regular", raw: JSON.stringify(p) }]), "missing_skill_date");
});

test("confirmed IDs retain secondary modes without dates; known later activity rejects the ID", () => {
  assert.equal(evaluateBanCandidate(candidate, [input(), input("pve", null), input("arena", null)]), "accepted");
  assert.equal(evaluateBanCandidate(candidate, [input(), input("pve", waveCutoff("2025-12-19") / 1000 + 1)]), "active_after_wave");
  assert.equal(evaluateBanCandidate(candidate, [input("regular", waveCutoff("2025-12-19") / 1000 - 1)]), "accepted");
});

test("last listed wave governs activity and invalid calendar dates fail", () => {
  const waves = [...candidate.waves, { ...candidate.waves[0], date: "2026-02-01" }];
  assert.equal(evaluateBanCandidate({ ...candidate, waves }, [input("regular", Date.parse("2026-01-01") / 1000)]), "accepted");
  assert.throws(() => waveCutoff("2025-02-30"));
  assert.throws(() => evaluateBanCandidate({ ...candidate, nickname: "SomeoneElse" }, [input()]));
});

test("all modes and seasons coexist; original statistics round-trip without inventory or hideout", () => {
  const store = db();
  try {
    const profiles = [input(), input("pve"), input("arena", null), input("seasonal"), { ...input("seasonal"), cycleId: "s2" }];
    importBanCandidate(store, candidate, profiles, 1767000000000);
    assert.equal(store.prepare("SELECT COUNT(*) n FROM banned_mode_snapshots").get()!.n, 5);
    const row = store.prepare("SELECT raw_json_gzip FROM banned_mode_snapshots WHERE mode='regular'").get()!;
    const expected = JSON.parse(characterStatisticsJson(JSON.parse(profiles[0].raw)));
    assert.deepEqual(JSON.parse(gunzipSync(row.raw_json_gzip as Uint8Array).toString()), expected);
    assert.deepEqual(readArchivedBanProfile(store, 42, "regular"), expected);
    assert.deepEqual(readArchivedBanProfile(store, 42, "seasonal", "s2"), expected);
    for (const key of ["equipment", "items", "hideout", "customization"]) assert.equal(Object.hasOwn(expected, key), false);
    importBanCandidate(store, candidate, profiles, 1767000001000);
    assert.equal(store.prepare("SELECT COUNT(*) n FROM banned_mode_snapshots").get()!.n, 5);
    assert.equal(store.prepare("SELECT COUNT(*) n FROM ban_confirmations").get()!.n, 1);
    store.prepare("UPDATE banned_mode_snapshots SET raw_sha256='wrong' WHERE mode='regular'").run();
    assert.throws(() => readArchivedBanProfile(store, 42, "regular"), /checksum/);
  } finally { store.close(); }
});

test("unknown statistical counters survive projection; changing equipment does not change the snapshot", () => {
  const store = db();
  try {
    const p = JSON.parse(input().raw);
    p.pmcStats.eft.overAllCounters.Items.push({ Key: ["FutureStat", "Pmc"], Value: 123 });
    p.scavStats = { eft: { overAllCounters: { Items: [{ Key: ["LongestWinStreak", "Scav"], Value: 7 }] } } };
    p.skills.Mastering = [{ Id: "weapon", Progress: 99 }];
    importBanCandidate(store, candidate, [{ mode: "regular", raw: JSON.stringify(p) }]);
    p.equipment.Items = ["new-gear"];
    importBanCandidate(store, candidate, [{ mode: "regular", raw: JSON.stringify(p) }]);
    const archived = readArchivedBanProfile(store, 42, "regular")!;
    assert.deepEqual(archived.pmcStats, p.pmcStats);
    assert.deepEqual(archived.scavStats, p.scavStats);
    assert.deepEqual(archived.skills, p.skills);
    assert.equal(store.prepare("SELECT COUNT(*) n FROM banned_mode_snapshots").get()!.n, 1);
  } finally { store.close(); }
});

test("public profiles with null counter items still follow the skill-date rule", () => {
  const p = JSON.parse(input("regular", null).raw);
  p.pmcStats.eft.overAllCounters.Items = null;
  assert.equal(evaluateBanCandidate(candidate, [{ mode: "regular", raw: JSON.stringify(p) }]), "missing_skill_date");
});

test("ineligible profiles create neither bans nor snapshots; legacy rows remain intact", () => {
  const store = db();
  try {
    store.prepare("INSERT INTO banned_accounts VALUES(99,1,1,'legacy','banned',NULL,1)").run();
    assert.equal(importBanCandidate(store, candidate, [input("regular", null)]), "missing_skill_date");
    assert.equal(store.prepare("SELECT COUNT(*) n FROM banned_accounts").get()!.n, 1);
    assert.equal(store.prepare("SELECT COUNT(*) n FROM banned_mode_snapshots").get()!.n, 0);
    assert.equal(store.prepare("SELECT source FROM banned_accounts WHERE aid=99").get()!.source, "legacy");
  } finally { store.close(); }
});

test("identity mismatches and changed bytes under the same version roll back", () => {
  const store = db();
  try {
    importBanCandidate(store, candidate, [input()]);
    const p = JSON.parse(input().raw); p.info.nickname = "Changed";
    assert.throws(() => importBanCandidate(store, candidate, [{ mode: "regular", raw: JSON.stringify(p) }]), /version change/);
    p.aid = 43;
    assert.throws(() => importBanCandidate(store, candidate, [{ mode: "regular", raw: JSON.stringify(p) }]), /identity/);
    assert.equal(readArchivedBanProfile(store, 42, "regular")!.info.nickname, "Player");
  } finally { store.close(); }
});

test("publication preserves full live history before excluding all modes", () => {
  const directory = mkdtempSync(join(tmpdir(), "ban-import-")); const stage = db();
  try {
    const playersPath = join(directory, "players.db"), progressionPath = join(directory, "progression.db");
    const players = new DatabaseSync(playersPath); const progression = new DatabaseSync(progressionPath);
    players.exec("CREATE TABLE players(aid INTEGER PRIMARY KEY, nickname TEXT); INSERT INTO players VALUES(42,'Player'); CREATE TABLE excluded_players(aid INTEGER PRIMARY KEY, reason TEXT, created_at INTEGER);");
    progression.exec("CREATE TABLE excluded_players(aid INTEGER PRIMARY KEY,reason TEXT,created_at INTEGER); CREATE TABLE player_profiles(aid INTEGER PRIMARY KEY,confirmed_banned INTEGER); INSERT INTO player_profiles VALUES(42,0); CREATE TABLE progression_snapshots(aid INTEGER,mode TEXT,cycle_id TEXT,updated INTEGER,opaque TEXT,PRIMARY KEY(aid,mode,cycle_id,updated)); INSERT INTO progression_snapshots VALUES(42,'regular','persistent',1,'keep-pvp'),(42,'pve','persistent',1,'keep-pve');");
    players.close(); progression.close();
    importBanCandidate(stage, candidate, [input()]);
    const targetPath = join(directory, "bans.db");
    assert.equal(publishBanArchive(stage, targetPath, playersPath, progressionPath), 1);
    assert.equal(publishBanArchive(stage, targetPath, playersPath, progressionPath), 1);
    const target = new DatabaseSync(targetPath); const live = new DatabaseSync(progressionPath);
    try {
      assert.equal(target.prepare("SELECT COUNT(*) n FROM banned_stored_rows").get()!.n, 4);
      assert.equal(live.prepare("SELECT COUNT(*) n FROM progression_snapshots").get()!.n, 2);
      assert.equal(live.prepare("SELECT confirmed_banned FROM player_profiles WHERE aid=42").get()!.confirmed_banned, 1);
      assert.equal(live.prepare("SELECT COUNT(*) n FROM excluded_players").get()!.n, 1);
    } finally { target.close(); live.close(); }
    importBanCandidate(stage, candidate, [input("regular", null)], Date.now() + 1000);
    assert.equal(publishBanArchive(stage, targetPath, playersPath, progressionPath), 0);
  } finally {
    stage.close();
    try { rmSync(directory, { recursive: true, force: true }); } catch { /* Preserve the original failure if a fixture handle remains open. */ }
  }
});

test("failed history preservation rolls back both ban and cross-database exclusion", () => {
  const store = db();
  try {
    store.exec("ATTACH DATABASE ':memory:' AS players_db; CREATE TABLE players_db.players(aid INTEGER PRIMARY KEY); INSERT INTO players_db.players VALUES(42); CREATE TABLE players_db.excluded_players(aid INTEGER PRIMARY KEY,reason TEXT,created_at INTEGER); ATTACH DATABASE ':memory:' AS progression_db; CREATE TABLE progression_db.player_profiles(aid INTEGER PRIMARY KEY,confirmed_banned INTEGER);");
    assert.throws(() => importBanCandidate(store, candidate, [input()]), /exclusion schema/);
    assert.equal(store.prepare("SELECT COUNT(*) n FROM banned_accounts").get()!.n, 0);
    assert.equal(store.prepare("SELECT COUNT(*) n FROM players_db.excluded_players").get()!.n, 0);
    assert.equal(store.prepare("SELECT COUNT(*) n FROM players_db.players").get()!.n, 1);
  } finally { store.close(); }
});

test("streamed discovery uses exact case-insensitive names and keeps duplicate IDs", async () => {
  const found = await discoverBanCandidates(candidate.waves, async () => new Response('{"42":"PLAYER","43":"PlayerExtra","44":"Player"}'));
  assert.deepEqual(found.map(c => c.aid), [42, 44]);
  assert.equal(found[0].waves[0].nicknames.length, 1);
});

test("collector fetches every mode, accepts 404 but never mistakes server errors for absence", async () => {
  const seen: string[] = [];
  const request = async (url: string) => {
    seen.push(url); const mode = url.includes("/arena/") ? "arena" : url.includes("/pve/") ? "pve" : url.includes("/pvp-season/") ? "seasonal" : "regular";
    return new Response(input(mode, mode === "arena" ? null : 1766000000).raw);
  };
  assert.equal((await collectBanProfiles(candidate, request, "s1")).length, 4);
  assert.equal(seen.length, 4);
  await assert.rejects(collectBanProfiles(candidate, async () => new Response("error", { status: 503 }), "s1"), /503/);
});

test("rate limiter retries 429/5xx, honors Retry-After, and bounds responses", async () => {
  const delays: number[] = []; let count = 0;
  const request = createRateLimitedRequest(2, async () => ++count === 1 ? new Response("", { status: 429, headers: { "Retry-After": "2" } }) : new Response("ok"), async (ms: number) => { delays.push(ms); });
  assert.equal(await (await request("https://example.com")).text(), "ok");
  assert.ok(delays.includes(2000));
  await assert.rejects(boundedText(new Response("12345"), 4), /too large/);
});
