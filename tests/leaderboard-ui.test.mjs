import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const read = (path) => readFile(path, "utf8");

test("leaderboard formatter reuse preserves the exact existing locale and precision text", async () => {
  const table = await read("components/LeaderboardTable.tsx");
  const helper = table.slice(table.indexOf("const numberFormats"), table.indexOf("function scoreValue"));
  const format = new Function(`${ts.transpile(helper)}; return formatNumber`)();
  for (const locale of ["en-US", "ru-RU"]) for (const digits of [0, 1, 2]) {
    for (const value of [null, 0, -0, 1.005, -1.005, 1 / 7, 1234567.891, NaN, Infinity]) {
      assert.equal(format(value, locale, digits), value == null ? "—"
        : value.toLocaleString(locale, { maximumFractionDigits: digits, minimumFractionDigits: digits }));
    }
  }
});

test("leaderboard FLIP cancels before geometry and measures every row before animation writes", async () => {
  const table = await read("components/LeaderboardTable.tsx");
  const helper = table.slice(table.indexOf("const flipActive"), table.indexOf("export default function"));
  let reduced = false;
  const { flipRows, flipActive } = new Function("window", `${ts.transpile(helper)}; return { flipRows, flipActive }`)({
    matchMedia: () => ({ matches: reduced }),
  });
  const calls = [];
  const elements = [1, 2].map((aid) => ({
    dataset: { aid: String(aid) },
    getClientRects: () => [1],
    getBoundingClientRect: () => { calls.push(`read:${aid}`); return { top: aid * 20 }; },
    animate: (frames, options) => { calls.push(`write:${aid}`); return { frames, options, cancel: () => calls.push(`cancel:${aid}`) }; },
  }));
  elements.forEach((el, i) => flipActive.set(el, { cancel: () => calls.push(`cancel:${i + 1}`) }));
  let containerReads = 0;
  const container = { querySelectorAll: () => elements, getClientRects: () => [1],
    getBoundingClientRect: () => { containerReads++; return { top: 10 }; } };
  assert.deepEqual([...flipRows(container, new Map([[1, 30], [2, 50]]))], [[1, 10], [2, 30]]);
  assert.deepEqual(calls, ["cancel:1", "cancel:2", "read:1", "read:2", "write:1", "write:2"]);
  assert.equal(containerReads, 1);
  calls.length = 0; reduced = true;
  flipRows(container, new Map([[1, 30], [2, 50]]));
  assert.ok(!calls.some((call) => call.startsWith("write:")));
  calls.length = 0;
  assert.equal(flipRows({ ...container, getClientRects: () => [] }, new Map()).size, 0);
  assert.ok(!calls.some((call) => call.startsWith("read:")));
});

test("leaderboard route uses the query-driven client and a route loading state", async () => {
  const [page, loading] = await Promise.all([
    read("app/leaderboard/page.tsx"),
    read("app/leaderboard/loading.tsx"),
  ]);
  assert.match(page, /await connection\(\)/);
  assert.match(page, /<LeaderboardPage \/>/);
  assert.match(loading, /<LeaderboardLoading \/>/);
});

test("profile badge is scoped to the active mode and explicit profile revision", async () => {
  const [badge, header, regular, arena, seasonal] = await Promise.all([
    read("components/LeaderboardRankLink.tsx"),
    read("components/ProfileHeader.tsx"),
    read("components/RegularPlayer.tsx"),
    read("components/ArenaPlayer.tsx"),
    read("components/SeasonalPlayer.tsx"),
  ]);
  assert.match(badge, /\/api\/leaderboard\/rank/);
  assert.match(badge, /if \(!controller\.signal\.aborted\) setResult/);
  assert.match(badge, /result\?\.key !== requestKey/);
  assert.match(header, /arenaMode=\{leaderboardArenaMode\}/);
  assert.match(header, /cycleId=\{seasonalCycleId\}/);
  assert.match(header, /revision=\{leaderboardRevision\}/);
  assert.match(header, /mode === "seasonal" \? "pvp-season" : mode/);
  assert.match(regular, /leaderboardRevision=\{`\$\{profileUpdatedAt/);
  assert.match(arena, /leaderboardArenaMode=\{selectedMode === "overall" \? "blastGang" : selectedMode\}/);
  assert.match(arena, /profile\.fetchedAt/);
  assert.match(seasonal, /leaderboardRevision=\{`\$\{cycleId}:\$\{profile\.profileUpdatedAt}/);
  assert.match(badge, /mode === "pvp-season" && cycleId/);
  assert.match(badge, /params\.set\("cycle", cycleId\)/);
});

test("public and focused lists preserve server rows and disable mass link prefetch", async () => {
  const [page, table] = await Promise.all([
    read("components/LeaderboardPage.tsx"),
    read("components/LeaderboardTable.tsx"),
  ]);
  assert.match(page, /\/api\/leaderboard\?\$\{params\}/);
  assert.match(page, /rows=\{orderedTop\}/);
  assert.match(page, /rows=\{orderedAround\}/);
  assert.match(page, /visible\?\.top/);
  assert.match(page, /visible\.around/);
  assert.doesNotMatch(page, /\.slice\(/);
  assert.ok(((table.match(/prefetch=\{false\}/g) ?? []).length) >= 2);
  assert.match(table, /leaderboard-cards/);
  assert.doesNotMatch(table, /raidsOrMatches/);
  assert.doesNotMatch(table, /column\.position/);
  assert.match(table, /leaderboard\.column\.kills/);
  assert.match(table, /displayRank/);
  assert.match(table, /sort === "primary" \? row\.primaryRank : row\.position/);
  // Direction changes the server window; ranks retain their published meaning.
  assert.doesNotMatch(page, /\.reverse\(/);
  assert.doesNotMatch(table, /rankedCount - rank/);
  assert.doesNotMatch(table, /Балл/);
  assert.match(table, /getBoundingClientRect/);
  assert.match(table, /flipActive/);
  assert.match(table, /\.cancel\(\)/);
  assert.match(table, /\}, \[rows\]\)/);
  assert.match(table, /data-aid/);
  assert.match(table, /useLayoutEffect/);
  assert.match(table, /translateY/);
  assert.match(table, /showBestArp && <th scope="col">\{t\("leaderboard\.column\.bestArp"\)\}/);
  assert.match(table, /meta\.arenaMode === "blastGang"/);
  assert.match(table, /row\.stats\.bestArp/);
  assert.match(table, /scoreValue\(row, meta, locale\)/);
  assert.match(table, /leaderboard\.column\.bestArp"\)\}<\/th>\}\s*<th scope="col">\{t\("leaderboard\.column\.score/);
  assert.match(table, /tabIndex=\{row\.selected \? -1 : undefined\}/);
  // Both the desktop row and the mobile card (the visible copy) are programmatically focusable.
  assert.ok(((table.match(/tabIndex=\{row\.selected \? -1 : undefined\}/g) ?? []).length) >= 2);
  assert.match(table, /leaderboard\.hoursValue/);
  assert.doesNotMatch(table, /lang === "ru" \? " ч"/);
  assert.match(table, /meta\.mode === "pvp-season" && meta\.cycleId/);
  assert.match(table, /profileParams\.set\("cycle", meta\.cycleId\)/);
  assert.match(table, /focusParams\.set\("cycle", meta\.cycleId\)/);
});

test("Arena defaults, sort preservation, and focused jump targets are explicit", async () => {
  const page = await read("components/LeaderboardPage.tsx");
  assert.match(page, /\?\? "blastGang"/);
  assert.match(page, /sort: sort === "hours" \|\| sort === "kills" \? sort : "primary"/);
  assert.match(page, /nextMode === "lastHero"/);
  assert.match(page, /sort === "hours" \|\| sort === "kills" \? sort : "killsPerMatch"/);
  assert.match(page, /nextMode === "arena" \? "blastGang"/);
  assert.match(page, /#leaderboard-around \[data-leaderboard-selected='true'\]/);
  assert.match(page, /scrollToPlayer/);
  assert.match(page, /scrollEdge/);
  assert.match(page, /setMobileList\("top"\)/);
  assert.match(page, /getClientRects/);
  assert.match(page, /leaderboard-jump-toggle/);
  assert.match(page, /jumpEdge/);
  // Round jump is first in the row and always visible (no focused gate).
  assert.ok(page.indexOf("leaderboard-jump-toggle") < page.indexOf("SORTS.filter"));
  assert.match(page, /data-leaderboard-selected="true" className="leaderboard-insufficient/);
  assert.match(page, /leaderboard-lists--has-around/);
  assert.match(page, /\["regular", "pve", "arena", "pvp-season"\]/);
  assert.match(page, /"pvp-season": t\("fav\.mode\.seasonal"\)/);
  assert.match(page, /mode === "pvp-season" && cycle/);
  assert.match(page, /visible\?\.meta\.cycleId \?\? cycle/);
});

test("leaderboard sort pills replace the select and support direction toggle", async () => {
  const page = await read("components/LeaderboardPage.tsx");
  assert.match(page, /leaderboard-sort-pills/);
  assert.match(page, /\["primary", "score", "kd", "killsPerMatch", "kills", "hours"\]/);
  assert.match(page, /key !== "score" \|\| hasAlternatePrimary/);
  // LastHero primary duplicates the per-match order, so its primary pill is
  // hidden: score stays first and the per-match pill keeps the second slot.
  assert.match(page, /isLastHero/);
  assert.match(page, /key !== "primary" \|\| !isLastHero/);
  assert.match(page, /requestedSort === "primary" && isLastHero \? "killsPerMatch"/);
  assert.match(page, /leaderboard\.pills\.score/);
  assert.match(page, /leaderboard\.column\.bestArp/);
  assert.match(page, /leaderboard-sort-pills__break/);
  assert.match(page, /leaderboard\.pills\.kills/);
  assert.doesNotMatch(page, /leaderboard\.pills\.place/);
  // Direction lives in the shareable URL and flows into direction-aware ranks.
  assert.match(page, /queryDir/);
  assert.match(page, /searchParams\.get\("dir"\)/);
  assert.match(page, /dir: direction/);
  assert.match(page, /params\.set\("dir", "asc"\)/);
  assert.match(page, /leaderboard\.sort\.ascending/);
  assert.match(page, /dir: direction === "desc" \? "asc" : "desc"/);
  assert.doesNotMatch(page, /<select/);
  assert.doesNotMatch(page, /leaderboard\.generated/);
  assert.match(page, /leaderboard\.top500/);
  assert.match(page, /leaderboard\.top100/);
});

test("leaderboard switches sorts smoothly without a skeleton flash", async () => {
  const [page, css] = await Promise.all([
    read("components/LeaderboardPage.tsx"),
    read("app/globals.css"),
  ]);
  // Local query state: no Next navigation, so app/leaderboard/loading.tsx never flashes.
  assert.doesNotMatch(page, /useRouter/);
  assert.doesNotMatch(page, /router\.push/);
  assert.match(page, /const aid = positiveAid\(searchParams\.get/);
  assert.match(page, /history\.pushState/);
  assert.match(page, /loading \? result\?\.data : null/);
  assert.match(page, /leaderboard-switching/);
  // No remount key on the lists: rows keep DOM nodes, updates swap instantly.
  assert.doesNotMatch(page, /visible\.meta\.sort-\$\{direction\}/);
  // Loading announces itself instead of hiding behind aria-hidden.
  assert.match(page, /aria-live="polite"/);
  assert.match(page, /role="status"/);
  assert.match(css, /\.leaderboard-switching/);
  // A single switching rule for the pills plus a real dim of the stale lists.
  assert.match(page, /disabled=\{loading\}/);
  assert.match(css, /\.leaderboard-switching \.leaderboard-lists \{[^}]*opacity/);
  assert.match(css, /lb-rise/);
  assert.match(css, /lb-arrow-pop/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /\.leaderboard-sort-pills button/);
  assert.match(css, /\.leaderboard-jump-toggle__arrow/);
  assert.match(css, /-webkit-text-stroke/);
  // One shared row: round edge-jump + player jump live inside the sort pills.
  assert.match(css, /button\.leaderboard-jump-toggle \{[^}]*border-radius: 50%/);
  assert.match(css, /button\.leaderboard-jump-toggle \{[^}]*margin-right/);
  assert.match(css, /\.leaderboard-sticky \{[^}]*margin-top/);
  assert.doesNotMatch(css, /\.leaderboard-jumps \{/);
});

test("leaderboard hours units and best ARP labels live in the dictionary", async () => {
  const dict = await read("lib/i18n/messages.json");
  assert.match(dict, /"leaderboard\.hoursValue": "\{v\} h"/);
  assert.match(dict, /"leaderboard\.hoursValue": "\{v\} ч"/);
  assert.match(dict, /"leaderboard\.column\.bestArp": "Best ARP"/);
  assert.match(dict, /"leaderboard\.column\.bestArp": "Лучший ARP"/);
  assert.doesNotMatch(dict, /"leaderboard\.column\.bestArp": "BEST ARP"/);
});

test("leaderboard nicknames show a compact prestige badge from assets.tarkov.dev", async () => {
  const [table, css] = await Promise.all([
    read("components/LeaderboardTable.tsx"),
    read("app/globals.css"),
  ]);
  assert.match(table, /prestigeIconUrl/);
  assert.match(table, /https:\/\/assets\.tarkov\.dev\/prestige-/);
  assert.match(table, /prestige-\$\{level\}-icon\.webp/);
  assert.match(table, /leaderboard-prestige/);
  assert.match(table, /player\.prestigeLabel/);
  assert.match(table, /meta\.mode !== "arena"/);
  // Badge renders next to the nickname in both the desktop row and the mobile card.
  assert.ok(((table.match(/<PrestigeBadge/g) ?? []).length) >= 2);
  assert.match(table, /leaderboard-player__name/);
  assert.match(table, /leaderboard-card__player/);
  // Compact 18px badge that cannot stretch the row: fixed size, no layout shift.
  assert.match(css, /\.leaderboard-prestige \{[^}]*width: 18px/);
  assert.match(css, /\.leaderboard-prestige \{[^}]*height: 18px/);
  assert.match(css, /\.leaderboard-prestige \{[^}]*object-fit: contain/);
  // Missing images (future levels, 404) collapse instead of breaking the row.
  assert.match(table, /onError/);
  assert.match(table, /display.*none/);
  assert.match(table, /loading="lazy"/);
  // Accessible name comes from the shared prestige label (matches ProfilePrestige).
  assert.match(table, /alt=\{label\}/);
  assert.match(table, /referrerPolicy="no-referrer"/);
});

test("prestige badge recovers after an image error followed by a successful load", async () => {
  const table = await read("components/LeaderboardTable.tsx");
  const badge = table.slice(table.indexOf("function PrestigeBadge("), table.indexOf("const flipActive"));
  const event = { currentTarget: { style: { display: "" } } };
  const bodies = {};
  for (const handler of ["onError", "onLoad"]) {
    const body = badge.match(new RegExp(`${handler}=\\{\\(event\\) => \\{([\\s\\S]*?)\\}\\}`))?.[1];
    assert.ok(body, `${handler} handler must be present`);
    bodies[handler] = body;
  }
  new Function("event", bodies.onError)(event);
  assert.equal(event.currentTarget.style.display, "none");
  new Function("event", bodies.onLoad)(event);
  assert.equal(event.currentTarget.style.display, "");
  // Remount on level change so a previous 404 never hides the next valid badge.
  assert.match(table, /<PrestigeBadge key=\{prestige\}/);
  assert.match(table, /key=\{level\}/);
});

test("prestige icon URL rejects invalid levels", async () => {
  const table = await read("components/LeaderboardTable.tsx");
  assert.match(table, /Number\.isSafeInteger\(level\)/);
});

test("leaderboard fetch fails fast and retries without a full reload", async () => {
  const page = await read("components/LeaderboardPage.tsx");
  // Client-side timeout well under Caddy's 20s response_header_timeout, so a
  // stalled origin surfaces as a retryable error instead of a 504.
  assert.match(page, /LEADERBOARD_FETCH_TIMEOUT_MS = 15_000/);
  assert.match(page, /setTimeout\(\(\) => controller\.abort\(\), LEADERBOARD_FETCH_TIMEOUT_MS\)/);
  // One automatic retry, then a manual retry that re-issues the API request.
  assert.match(page, /LEADERBOARD_FETCH_RETRIES = 1/);
  assert.match(page, /setRetryNonce\(\(nonce\) => nonce \+ 1\)/);
  assert.match(page, /\[requestUrl, retryNonce\]/);
  assert.match(page, /tRef\.current\("leaderboard\.error"\)/);
  assert.doesNotMatch(page, /window\.location\.reload/);
  // A failed fetch keeps the previous table instead of wiping to the panel.
  assert.match(page, /prev\?\.data \? prev : \{ key: requestUrl, data: null/);
  assert.match(page, /failedUrl === requestUrl/);
});

test("leaderboard mobile layout exposes one full list and sticky controls", async () => {
  const css = await read("app/globals.css");
  assert.match(css, /\.leaderboard-mode-switch \{[^}]*grid-template-columns: repeat\(4,/);
  assert.match(css, /\.leaderboard-mode-switch \{ grid-template-columns: repeat\(2,/);
  assert.match(css, /\.leaderboard-sticky \{[^}]*position: sticky/);
  assert.match(css, /\.leaderboard-sort-pills button\[aria-pressed="true"\]/);
  assert.match(css, /\.leaderboard-table thead th \{[^}]*font-variant-numeric: tabular-nums/);
  assert.match(css, /\.leaderboard-table thead th:not\(:first-child\):not\(\.leaderboard-table__player\)/);
  assert.match(css, /\.leaderboard-cards/);
  assert.match(css, /\.leaderboard-sort-pills__break/);
  assert.match(css, /\.leaderboard-arena-tabs button \{[^}]*flex: 0 0 auto/);
  assert.doesNotMatch(css, /\.leaderboard-table \{ min-width: 7/);
  assert.match(css, /leaderboard-lists--has-around\[data-mobile-list="top"\]/);
  assert.match(css, /leaderboard-lists--has-around\[data-mobile-list="around"\]/);
  assert.doesNotMatch(css, /\.leaderboard-jumps \{/);
  assert.doesNotMatch(css, /body:has\(\.leaderboard-page--focused\) \.faq-trigger/);
  assert.match(css, /tr\[aria-current="true"\]/);
});

test("preview ownership closes other providers, cancels pending opens and releases on unmount", async () => {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const timers = new Map();
  const requests = [];
  let sequence = 0, rendering, reducedMotion = true;
  const react = {
    createContext: () => ({ Provider: () => null }),
    useId: () => String(++sequence),
    useRef: (current) => { const ref = { current }; rendering.refs.push(ref); return ref; },
    useState: (value) => {
      const states = rendering.states, index = states.length;
      states.push(value);
      return [value, (next) => { states[index] = next; }];
    },
    useCallback: (callback) => callback,
    useEffect: (effect) => { const cleanup = effect(); if (cleanup) rendering.cleanups.push(cleanup); },
    useLayoutEffect: () => {},
  };
  const stubs = {
    react,
    "@/lib/i18n/context": { useI18n: () => ({ lang: "en", t: (key) => key }) },
    "@/lib/leaderboard-preview": { AXIS_PREVIEW_DELAY_MS: 180, LEADERBOARD_PREVIEW_DELAY_MS: 400 },
    "@/components/ProfilePortrait": () => null,
    "next/link": () => null,
    "next/image": () => null,
    "react-dom": { createPortal: () => null },
  };
  const compiled = ts.transpileModule(await read("components/LeaderboardPreview.tsx"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  const previewModule = { exports: {} };
  new Function("require", "module", "exports", "window", "setTimeout", "clearTimeout", "fetch", compiled)(
    (name) => stubs[name] ?? require(name), previewModule, previewModule.exports,
    { matchMedia: (query) => ({ matches: query.includes("reduced-motion") ? reducedMotion : true }) },
    (callback) => { const id = ++sequence; timers.set(id, callback); return id; },
    (id) => timers.delete(id),
    (_url, { signal }) => { requests.push(signal); return new Promise(() => {}); },
  );
  const provider = () => {
    const state = { states: [], cleanups: [], refs: [] }; rendering = state;
    const tree = previewModule.exports.LeaderboardPreviewProvider({ meta: { mode: "regular", cycleId: null, arenaMode: null, generation: 1 } });
    return { ...tree.props.value, state };
  };
  const flush = () => { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach((callback) => callback()); };
  const target = (id) => ({ id, aid: 123, nickname: id, element: { isConnected: true, matches: () => false } });
  const first = provider(), second = provider(), third = provider();
  first.enter(target("first")); flush();
  assert.equal(first.state.states[1].nickname, "first");
  second.enter(target("second"));
  assert.equal(first.state.states[1], null, "the previous card closes before the next dwell timer");
  assert.equal(requests[0].aborted, true, "switching cancels the previous profile request");
  third.enter(target("third")); flush();
  assert.equal(second.state.states[1], null, "a superseded timer cannot reopen its card");
  assert.equal(third.state.states[1].nickname, "third");
  second.state.cleanups.forEach((cleanup) => cleanup());
  first.enter(target("new first"), true);
  assert.equal(third.state.states[1], null, "unmounting an old provider cannot release the current owner");
  assert.equal(first.state.states[1].nickname, "new first");
  first.enter(target("same provider"), true);
  assert.equal(first.state.states[1].nickname, "same provider");
  reducedMotion = false;
  first.state.refs[0].current = {};
  first.close();
  assert.equal(first.state.states[0], true, "ordinary close starts the exit animation");
  assert.equal(first.state.states[1].nickname, "same provider");
  third.enter(target("during exit"));
  assert.equal(first.state.states[1], null, "switching bypasses the previous exit animation");
  flush();
  assert.equal(third.state.states[1].nickname, "during exit", "an old exit timer cannot dismiss the new card");
  third.state.refs[0].current = {};
  third.close(); flush();
  assert.equal(third.state.states[1], null);
  first.enter(target("reduced motion"), true); reducedMotion = true;
  first.close();
  assert.equal(first.state.states[1], null, "reduced motion skips delayed unmount");
  for (const instance of [first, third]) instance.state.cleanups.forEach((cleanup) => cleanup());
  assert.equal(timers.size, 0);
  assert.ok(requests.every((signal) => signal.aborted));
});
