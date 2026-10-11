/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- Node's direct TypeScript runner requires explicit .ts imports.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { groupPlayerSearchResults, selectPlayerSearchProfile } from "../lib/player-search.ts";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "next/server") return nextResolve("next/server.js", context);
    if (specifier.startsWith("@/")) {
      return { shortCircuit: true, url: pathToFileURL(resolve(`${specifier.slice(2)}.ts`)).href };
    }
    return nextResolve(specifier, context);
  },
});

const directory = mkdtempSync(join(tmpdir(), "tarkov-player-search-"));
process.env.SQLITE_PATH = join(directory, "players.db");
process.env.PROGRESSION_SQLITE_PATH = join(directory, "progression.db");
// The route records a request event on every branch. Point the analytics store
// at the temp directory so it does not reach for the container's /data path.
process.env.ADMIN_ANALYTICS_SQLITE_PATH = join(directory, "admin-analytics.db");
process.env.OBSERVABILITY_SAMPLE_RATE = "0";

const { GET } = await import("../app/api/player/search/route.ts");
const { NextRequest } = await import("next/server");

function search(name, ip) {
  const params = new URLSearchParams({ name, mode: "regular" });
  return GET(new NextRequest(`http://local/api/player/search?${params}`, {
    headers: { "x-real-ip": ip },
  }));
}

test("multi-mode search groups one AID and ranks exact matches before prefixes", () => {
  const results = groupPlayerSearchResults([
    { aid: 8, name: "AlphaTwo", mode: "regular", cycleId: "persistent" },
    { aid: 7, name: "Alpha", mode: "pve", cycleId: "persistent" },
    { aid: 7, name: "AlphaArena", mode: "arena", cycleId: "persistent" },
    { aid: 7, name: "Alpha", mode: "seasonal", cycleId: "current" },
  ], "alpha", 12);
  assert.equal(results.length, 2);
  assert.equal(results[0].aid, 7);
  assert.equal(results[0].name, "Alpha");
  assert.deepEqual(results[0].profiles.map((profile) => profile.mode), [
    "pve", "seasonal", "arena",
  ]);
  assert.equal(results[1].aid, 8);
});

test("whole-row profile selection prefers the newest profile even under a different nickname", () => {
  const profiles = [
    { mode: "regular", cycleId: "persistent", name: "Other", updatedAt: 500 },
    { mode: "pve", cycleId: "persistent", name: "Nick", updatedAt: 100 },
    { mode: "arena", cycleId: "persistent", name: "Nick", updatedAt: 300 },
  ] as const;

  assert.equal(
    selectPlayerSearchProfile(profiles, "nick")?.mode,
    "regular",
  );
  assert.equal(
    selectPlayerSearchProfile(profiles.slice(1), "nick")?.mode,
    "arena",
  );
  assert.equal(
    selectPlayerSearchProfile(profiles, "missing")?.mode,
    "regular",
  );
  assert.equal(
    selectPlayerSearchProfile([
      { mode: "regular", cycleId: "persistent", name: "Same", updatedAt: null },
      { mode: "pve", cycleId: "persistent", name: "Same", updatedAt: null },
    ], "same")?.mode,
    "regular",
  );
});

test("search API reads all four indexes and rejects incomplete searches", async () => {
  const [route, db, seasonal, component] = await Promise.all([
    readFile("app/api/player/search/route.ts", "utf8"),
    readFile("lib/db.ts", "utf8"),
    readFile("lib/seasonal/search-index.ts", "utf8"),
    readFile("components/SearchBar.tsx", "utf8"),
  ]);
  assert.match(route, /SEARCH_MODES = \["regular", "pve", "arena", "seasonal"\]/);
  assert.match(route, /Promise\.allSettled/);
  assert.match(route, /available\.length === 0/);
  assert.match(route, /groupPlayerSearchResults/);
  assert.match(db, /arena_player_index/);
  assert.match(seasonal, /seasonal_player_index_meta/);
  assert.match(component, /\["all", \.\.\.GAME_MODES\]/);
  assert.match(component, /\{profiles\.map/);
  assert.match(component, /profileHref\(aid, selectedProfile\)/);
  assert.match(component, /search-unit__result-hitarea/);
  assert.match(component, /aria-label=\{t\("search\.openProfile"/);
  assert.match(component, /aria-current=\{isSelected \? "page"/);
  assert.match(component, /onClick=\{\(\) => openProfile\(player\.aid, profile\)\}/);
  assert.match(component, /search-unit__result-hitarea[\s\S]*search-unit__result-name/);
  assert.doesNotMatch(component, /role="link"/);
});

test("every player search response is no-store, so a shared cache cannot replay a 429 or 503", async (context) => {
  // The index tables exist but carry no `synced_at`, so the store reports
  // itself unavailable and the route takes its 503 branch.
  const unavailable = await search("Alpha", "198.51.100.11");
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), { error: "Player nickname index is not ready" });
  assert.equal(unavailable.headers.get("cache-control"), "no-store");

  const invalid = await search("not a nickname", "198.51.100.12");
  assert.equal(invalid.status, 400);
  assert.equal(invalid.headers.get("cache-control"), "no-store");

  // Mark the regular index synced so the success path is reachable too.
  const db = new DatabaseSync(process.env.SQLITE_PATH);
  db.exec("INSERT INTO player_index (aid, nickname, nickname_lower, synced_at) VALUES (7, 'Alpha', 'alpha', 1)");
  db.exec("INSERT INTO player_index_meta (key, value) VALUES ('synced_at', '1')");
  db.close();

  const found = await search("Alpha", "198.51.100.13");
  assert.equal(found.status, 200);
  assert.equal(found.headers.get("cache-control"), "no-store");
  assert.deepEqual(
    (await found.json()).map((player) => ({ aid: player.aid, name: player.name })),
    [{ aid: 7, name: "Alpha" }],
  );

  // The search bucket allows 120 requests a minute, so the 121st is the
  // rate-limited one. It used to ship the empty limiter header bag, leaving a
  // shared cache free to store and replay that 429 for every other visitor.
  context.mock.method(Date, "now", () => 1_800_000_000_000);
  let rateLimited = null;
  for (let attempt = 0; attempt <= 120; attempt += 1) {
    const response = await search("invalid nickname", "198.51.100.14");
    assert.equal(response.status, attempt < 120 ? 400 : 429);
    if (response.status === 429) rateLimited = response;
  }
  assert.ok(rateLimited, "the 121st request from one IP must be rate limited");
  assert.deepEqual(await rateLimited.json(), { error: "Rate limit exceeded" });
  assert.equal(rateLimited.headers.get("cache-control"), "no-store");

  // The limiter has nothing left to merge, so the directive stays single-sourced.
  const route = await readFile("app/api/player/search/route.ts", "utf8");
  assert.match(route, /const noStore = \{ \.\.\.headers, "Cache-Control": "no-store" \}/);
  assert.equal((route.match(/"Cache-Control"/g) ?? []).length, 1);
  assert.doesNotMatch(route, /\{ status: \d+, headers \}/);
  assert.doesNotMatch(route, /NextResponse\.json\(results, \{ headers \}\)/);
});

test("saved nickname results hide on blur and reopen before recent history", async () => {
  const [component, styles] = await Promise.all([
    readFile("components/SearchBar.tsx", "utf8"),
    readFile("app/globals.css", "utf8"),
  ]);

  assert.match(component, /const \[resultsOpen, setResultsOpen\] = useState\(false\)/);
  assert.match(component, /setResults\(found\);\s*setResultsOpen\(false\);\s*setRecentOpen\(false\);/);
  assert.match(component, /const found = \(await response\.json\(\)\)[\s\S]*searchRequestRef\.current !== controller/);
  assert.match(component, /pendingResultsOpenRef\.current = !searchDismissedRef\.current/);
  assert.match(component, /requestAnimationFrame\([\s\S]*setResultsOpen\(true\)/);
  assert.match(component, /cancelAnimationFrame/);
  assert.match(component, /if \(results\.length > 0 && searchedNickname === query\.trim\(\)\) \{[\s\S]*setRecentOpen\(false\);[\s\S]*setResultsOpen\(true\);/);
  assert.match(component, /setResultsOpen\(false\);\s*setRecentOpen\(true\);/);
  assert.match(component, /const showResults = resultsOpen && results\.length > 0 && searchedNickname === query\.trim\(\)/);
  assert.match(component, /\{results\.length > 0 && \(\s*<div[\s\S]*className="search-unit__results"/);
  assert.match(component, /className="search-unit__results"[\s\S]*data-open=\{showResults\}[\s\S]*aria-hidden=\{!showResults\}[\s\S]*inert=\{!showResults\}/);
  // `aria-controls` points at this element while results are shown, so it has to
  // carry the popup role the input advertises with `aria-haspopup="dialog"`.
  assert.match(component, /id=\{resultListId\}[\s\S]*inert=\{!showResults\}[\s\S]*role="dialog"\s*\n\s*aria-label=\{t\("search\.resultsHeading"\)\}/);
  assert.match(component, /if \(!loading && !recentOpen && !modeMenuOpen && !resultsOpen && !pendingResultsOpenRef\.current\) return/);
  assert.match(component, /searchFormRef\.current\?\.contains\(target\) \|\| resultsRef\.current\?\.contains\(target\)/);
  assert.match(component, /function closeOnFocusOut\(event: FocusEvent\) \{\s*if \(!isSearchTarget\(event\.relatedTarget\)\) closePanels\(\);/);
  assert.match(component, /document\.addEventListener\("focusout", closeOnFocusOut, true\)/);
  assert.match(component, /window\.addEventListener\("blur", closePanels\)/);
  assert.match(component, /ref=\{searchFormRef\} className="search-unit__form"/);
  assert.match(component, /ref=\{resultsRef\}[\s\S]*className="search-unit__results"/);
  assert.doesNotMatch(component, /searchUnitRef/);
  assert.match(component, /suppressNextInputPanelRef/);
  assert.match(component, /const suppressPointerInputPanelRef = useRef\(false\)/);
  assert.match(component, /onPointerDown=\{handleInputPointerDown\}/);
  assert.match(component, /onPointerUp=\{handleInputPointerUp\}/);
  assert.match(component, /onPointerCancel=\{handleInputPointerCancel\}/);
  assert.match(component, /onClick=\{handleInputClick\}/);
  assert.match(component, /if \(suppressPointerInputPanelRef\.current\) return/);
  assert.match(component, /closeSearchPanels\(\);\s*inputRef\.current\?\.focus\(\)/);
  assert.match(component, /id=\{resultListId\}[\s\S]*event\.key !== "Escape"[\s\S]*closePanelsAndFocusInput\(\)/);
  assert.match(styles, /\.search-unit__results\s*\{[\s\S]*grid-template-rows: 0fr[\s\S]*opacity: 0[\s\S]*transform: translateY\(-8px\)[\s\S]*opacity 180ms ease-in/);
  assert.match(styles, /\.search-unit__results\[data-open="true"\][\s\S]*grid-template-rows: 1fr[\s\S]*opacity: 1[\s\S]*transform: translateY\(0\)[\s\S]*opacity 240ms ease-out/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.search-unit__results[\s\S]*transition-duration: \.01ms/);
});

test("search and recent profile lists stay bounded without truncating rows", async () => {
  const [component, styles] = await Promise.all([
    readFile("components/SearchBar.tsx", "utf8"),
    readFile("app/globals.css", "utf8"),
  ]);

  assert.match(component, /className="search-unit__recent-list space-y-1"[\s\S]*recentMatches\.map/);
  assert.match(component, /className="search-unit__results-list space-y-1"[\s\S]*results\.map/);
  assert.match(styles, /\.search-unit__recent-list\s*\{[\s\S]*max-height: min\(256px, 50svh\)[\s\S]*overflow-y: auto[\s\S]*overscroll-behavior: contain/);
  assert.match(styles, /\.search-unit__results-list\s*\{[\s\S]*max-height: min\(276px, 50svh\)[\s\S]*overflow-y: auto[\s\S]*overscroll-behavior: contain/);
});

test("fixed search mode scopes numeric, nickname, and recent selections without changing defaults", async () => {
  const source = await readFile("components/SearchBar.tsx", "utf8");

  assert.match(source, /onSelect\?: \(aid: number, profile: PlayerSearchProfileResult\) => void/);
  assert.match(source, /fixedMode\?: GameMode/);
  assert.match(source, /cycleId\?: string/);
  assert.match(source, /const effectiveSearchMode: SearchMode = fixedMode \?\? searchMode/);
  assert.match(source, /const selectedMode = fixedMode \?\? \(/);
  assert.match(source, /const selectedCycleId = selectedMode === "seasonal" && fixedMode[\s\S]*cycleId\?\.trim\(\)/);
  assert.match(source, /onSelect\(player\.aid, \{[\s\S]*mode: selectedMode,[\s\S]*cycleId: selectedCycleId/);
  assert.match(source, /onSelect\(Number\(entry\.aid\), \{[\s\S]*mode,[\s\S]*cycleId:/);
  assert.match(source, /searchNickname\(clean, effectiveSearchMode\)/);
  assert.match(source, /router\.push\(profileHref\(aid, selectedProfile\)\)/);
  assert.match(source, /router\.push\(getRecentPlayerHref\(entry\)\)/);
  assert.match(source, /!fixedMode && \(/);
});

test("fixed search filters recent and nickname profiles by the selected mode and cycle", async () => {
  const source = await readFile("components/SearchBar.tsx", "utf8");

  assert.match(source, /filterRecentPlayers\(recentPlayers, query\)\.filter\(\(entry\) => \{[\s\S]*const mode = fixedMode \?\? effectiveSearchMode[\s\S]*recentEntryMode\(entry\) !== mode[\s\S]*entry\.cycle === cycleId/);
  assert.match(source, /player\.profiles\.filter\(\(profile\) => profile\.mode === fixedMode/);
  assert.match(source, /profile\.cycleId === cycleId/);
  assert.match(source, /function scopedProfile\([\s\S]*if \(!fixedMode\) return profile[\s\S]*mode: fixedMode[\s\S]*cycleId: fixedMode === "seasonal"/);
});

test("search selection action is localized separately from profile navigation", async () => {
  const [component, dictionary] = await Promise.all([
    readFile("components/SearchBar.tsx", "utf8"),
    readFile("lib/i18n/dictionary.ts", "utf8"),
  ]);

  assert.match(component, /loading \? t\("common\.loading"\) : t\(onSelect \? "search\.select" : landing \? "home\.search" : "search\.view"\)/);
  assert.match(dictionary, /"search\.select": "Select"/);
  assert.match(dictionary, /"search\.select": "Выбрать"/);
});

test("saving profiles makes every persistent mode searchable without a completed index sync", async () => {
  const { getStore, getPlayerIndexStore } = await import("../lib/db.ts");
  const { parseProfileStats } = await import("../lib/tarkov-api.ts");
  for (const [index, mode] of ["regular", "pve", "arena"].entries()) {
    const aid = 500 + index;
    const makeStats = (nickname, updated) => parseProfileStats({
      aid, updated, info: { nickname, side: "Usec", experience: 0 },
      pmcStats: { eft: { totalInGameTime: 3600, overAllCounters: { Items: [] } } },
    });
    const store = await getStore(mode);
    await store.upsert(aid, makeStats(`Saved_${mode}`, 1_800_000_000_000), []);
    // An older response must not roll the nickname back in either table.
    await store.upsert(aid, makeStats(`Old_${mode}`, 1_700_000_000_000), []);
    const playerIndex = await getPlayerIndexStore(mode);
    assert.equal(await playerIndex.isReady(), true);
    assert.deepEqual((await playerIndex.search(`Saved_${mode}`, 12)).map((row) => row.aid), [aid]);
    assert.deepEqual(await playerIndex.search(`Old_${mode}`, 12), []);
  }
});

test("all-mode search includes a newer profile whose nickname differs from the query", async () => {
  const { getStore } = await import("../lib/db.ts");
  const { parseProfileStats } = await import("../lib/tarkov-api.ts");
  const aid = 600;
  for (const [mode, nickname, updated] of [
    ["regular", "Original", 1_700_000_000_000],
    ["pve", "Changed", 1_800_000_000_000],
  ]) {
    await (await getStore(mode)).upsert(aid, parseProfileStats({
      aid, updated, info: { nickname, side: "Usec", experience: 0 },
      pmcStats: { eft: { totalInGameTime: 3600, overAllCounters: { Items: [] } } },
    }), []);
  }
  const response = await GET(new NextRequest("http://local/api/player/search?name=Original&mode=all", {
    headers: { "x-real-ip": "198.51.100.30" },
  }));
  assert.equal(response.status, 200);
  const [player] = await response.json();
  assert.equal(player.aid, aid);
  assert.deepEqual(player.profiles.map((profile) => profile.mode), ["regular", "pve"]);
  assert.equal(selectPlayerSearchProfile(player.profiles, "Original").mode, "pve");
});

test("persistent searches fall back to the previous directory without reviving excluded players", async () => {
  const { getPlayerIndexStore } = await import("../lib/db.ts");
  const db = new DatabaseSync(process.env.SQLITE_PATH);
  try {
    for (const [index, mode] of ["regular", "pve", "arena"].entries()) {
      const table = mode === "regular" ? "player_index" : `${mode}_player_index`;
      const playerIndex = await getPlayerIndexStore(mode);
      db.exec(`ALTER TABLE ${table} RENAME TO ${table}_audit_original`);
      try {
        db.exec(`CREATE TABLE ${table}_previous AS SELECT * FROM ${table}_audit_original`);
        db.exec(`CREATE TABLE ${table} AS SELECT * FROM ${table}_audit_original`);
        db.exec(`ALTER TABLE ${table} RENAME COLUMN nickname_lower TO broken_column`);
        assert.equal(await playerIndex.isReady(), true);
        assert.deepEqual((await playerIndex.search(`Saved_${mode}`, 12)).map((row) => row.aid), [500 + index]);
        assert.deepEqual((await playerIndex.byIds([500 + index])).map((row) => row.aid), [500 + index]);
        db.prepare("INSERT INTO excluded_players (aid, reason, created_at) VALUES (?, 'test', 1)").run(500 + index);
        assert.deepEqual(await playerIndex.search(`Saved_${mode}`, 12), []);
        // A missing primary table also uses the persisted fallback.
        db.exec(`DROP TABLE ${table}`);
        assert.equal(await playerIndex.isReady(), true);
        assert.deepEqual(await playerIndex.byIds([500 + index]), []);
      } finally {
        db.exec(`DROP TABLE IF EXISTS ${table}; DROP TABLE IF EXISTS ${table}_previous;
          ALTER TABLE ${table}_audit_original RENAME TO ${table}`);
        db.prepare("DELETE FROM excluded_players WHERE aid = ?").run(500 + index);
      }
    }
    db.exec("ALTER TABLE arena_player_index RENAME TO arena_player_index_audit_original");
    try {
      const incomplete = await GET(new NextRequest("http://local/api/player/search?name=Missing&mode=all", {
        headers: { "x-real-ip": "198.51.100.31" },
      }));
      assert.equal(incomplete.status, 503, "without any snapshot we must not claim a complete negative result");
    } finally { db.exec("ALTER TABLE arena_player_index_audit_original RENAME TO arena_player_index"); }
  } finally { db.close(); }
});

test("Seasonal profiles enter the directory and fallback stays within the requested cycle", async () => {
  const { createSqliteSeasonalStore } = await import("../lib/seasonal/storage.ts");
  const { getSeasonalPlayerIndexStore } = await import("../lib/seasonal/search-index.ts");
  const db = new DatabaseSync(process.env.PROGRESSION_SQLITE_PATH);
  try {
    const store = createSqliteSeasonalStore(db);
    const profile = {
      mode: "seasonal", cycleId: "search-test", aid: 700, nickname: "SeasonNick",
      profileUpdatedAt: 1_800_000_000_000, lastAccessAt: 1_800_000_000_000,
      lifetimePvpHours: null,
      counters: { experience: 0, pmcRaids: 1, scavRaids: 0, pmcSurvived: 1, pmcDeaths: 0, pmcKills: 1, killedPmc: 0 },
    };
    await store.upsertProfile(profile);
    await store.upsertProfile({ ...profile, nickname: "OldSeasonNick", profileUpdatedAt: 1_700_000_000_000 });
    const index = await getSeasonalPlayerIndexStore(profile.cycleId);
    assert.equal(await index.isReady(), true);
    assert.deepEqual((await index.search("SeasonNick", 12)).map((row) => row.aid), [700]);
    assert.deepEqual(await index.search("OldSeasonNick", 12), []);
    db.exec("ALTER TABLE seasonal_player_index RENAME TO seasonal_player_index_audit_original");
    try {
      db.exec("CREATE TABLE seasonal_player_index_previous AS SELECT * FROM seasonal_player_index_audit_original");
      db.exec("CREATE TABLE seasonal_player_index AS SELECT * FROM seasonal_player_index_audit_original");
      db.exec("ALTER TABLE seasonal_player_index RENAME COLUMN nickname_lower TO broken_column");
      assert.deepEqual((await index.search("SeasonNick", 12)).map((row) => row.aid), [700]);
      assert.deepEqual((await index.byIds([700])).map((row) => row.aid), [700]);
      const otherCycle = await getSeasonalPlayerIndexStore("other-cycle");
      assert.equal(await otherCycle.isReady(), false);
      db.prepare("INSERT INTO excluded_players (aid, reason, created_at) VALUES (?, 'test', 1)").run(700);
      assert.deepEqual(await index.search("SeasonNick", 12), []);
    } finally {
      db.exec(`DROP TABLE seasonal_player_index; DROP TABLE seasonal_player_index_previous;
        ALTER TABLE seasonal_player_index_audit_original RENAME TO seasonal_player_index`);
      db.prepare("DELETE FROM excluded_players WHERE aid = ?").run(700);
    }
  } finally { db.close(); }
});
