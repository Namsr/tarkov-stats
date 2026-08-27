/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- Node's direct TypeScript runner requires explicit .ts imports.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { groupPlayerSearchResults, selectPlayerSearchProfile } from "../lib/player-search.ts";

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

test("whole-row profile selection prefers exact nicknames, recent modes, freshness, then order", () => {
  const profiles = [
    { mode: "regular", cycleId: "persistent", name: "Other", updatedAt: 500 },
    { mode: "pve", cycleId: "persistent", name: "Nick", updatedAt: 100 },
    { mode: "arena", cycleId: "persistent", name: "Nick", updatedAt: 300 },
  ] as const;

  assert.equal(
    selectPlayerSearchProfile(42, profiles, "nick", [{ aid: "42", mode: "pve" }])?.mode,
    "pve",
  );
  assert.equal(
    selectPlayerSearchProfile(42, profiles, "nick", [])?.mode,
    "arena",
  );
  assert.equal(
    selectPlayerSearchProfile(42, profiles, "missing", [{ aid: "42", mode: "pve" }])?.mode,
    "pve",
  );
  assert.equal(
    selectPlayerSearchProfile(42, profiles, "missing", [])?.mode,
    "regular",
  );
  assert.equal(
    selectPlayerSearchProfile(42, [
      { mode: "regular", cycleId: "persistent", name: "Same", updatedAt: null },
      { mode: "pve", cycleId: "persistent", name: "Same", updatedAt: null },
    ], "same", [])?.mode,
    "regular",
  );
});

test("search API reads all four indexes and tolerates unavailable modes", async () => {
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
  assert.match(component, /player\.profiles\.map/);
  assert.match(component, /profileHref\(aid, profile\)/);
  assert.match(component, /search-unit__result-hitarea/);
  assert.match(component, /aria-label=\{t\("search\.openProfile"/);
  assert.match(component, /aria-current=\{isSelected \? "page"/);
  assert.match(component, /onClick=\{\(\) => openProfile\(player\.aid, profile\)\}/);
  assert.match(component, /search-unit__result-hitarea[\s\S]*search-unit__result-name/);
  assert.doesNotMatch(component, /role="link"/);
});

test("saved nickname results hide on blur and reopen before recent history", async () => {
  const [component, styles] = await Promise.all([
    readFile("components/SearchBar.tsx", "utf8"),
    readFile("app/globals.css", "utf8"),
  ]);

  assert.match(component, /const \[resultsOpen, setResultsOpen\] = useState\(false\)/);
  assert.match(component, /setResults\(found\);\s*setResultsOpen\(false\);\s*setRecentOpen\(false\);/);
  assert.match(component, /const found = \(await response\.json\(\)\)[\s\S]*searchRequestRef\.current !== controller/);
  assert.match(component, /pendingResultsOpenRef\.current = true/);
  assert.match(component, /requestAnimationFrame\([\s\S]*setResultsOpen\(true\)/);
  assert.match(component, /cancelAnimationFrame/);
  assert.match(component, /if \(results\.length > 0 && searchedNickname === query\.trim\(\)\) \{[\s\S]*setRecentOpen\(false\);[\s\S]*setResultsOpen\(true\);/);
  assert.match(component, /setResultsOpen\(false\);\s*setRecentOpen\(true\);/);
  assert.match(component, /const showResults = resultsOpen && results\.length > 0 && searchedNickname === query\.trim\(\)/);
  assert.match(component, /\{results\.length > 0 && \(\s*<div[\s\S]*className="search-unit__results"/);
  assert.match(component, /className="search-unit__results"[\s\S]*data-open=\{showResults\}[\s\S]*aria-hidden=\{!showResults\}[\s\S]*inert=\{!showResults\}/);
  assert.match(component, /if \(!recentOpen && !modeMenuOpen && !resultsOpen && !pendingResultsOpenRef\.current\) return/);
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
