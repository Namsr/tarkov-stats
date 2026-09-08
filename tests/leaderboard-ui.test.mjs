import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(path, "utf8");

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
  assert.match(arena, /leaderboardArenaMode=\{selectedMode\}/);
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
  assert.match(page, /visible\.top/);
  assert.match(page, /visible\.around/);
  assert.doesNotMatch(page, /\.slice\(/);
  assert.ok(((table.match(/prefetch=\{false\}/g) ?? []).length) >= 2);
  assert.match(table, /leaderboard-cards/);
  assert.doesNotMatch(table, /raidsOrMatches/);
  assert.doesNotMatch(table, /column\.position/);
  assert.match(table, /leaderboard\.column\.kills/);
  assert.match(table, /meta\.mode === "arena" && <th scope="col">\{t\("leaderboard\.column\.bestArp"\)\}/);
  assert.match(table, /row\.stats\.bestArp/);
  assert.match(table, /meta\.primaryMetric !== "killsPerMatch"/);
  assert.match(table, /tabIndex=\{row\.selected \? -1 : undefined\}/);
  assert.match(table, /meta\.mode === "pvp-season" && meta\.cycleId/);
  assert.match(table, /profileParams\.set\("cycle", meta\.cycleId\)/);
  assert.match(table, /focusParams\.set\("cycle", meta\.cycleId\)/);
});

test("Arena defaults, sort preservation, and focused jump targets are explicit", async () => {
  const page = await read("components/LeaderboardPage.tsx");
  assert.match(page, /\?\? "blastGang"/);
  assert.match(page, /sort: sort === "hours" \? "hours" : "primary"/);
  assert.match(page, /nextMode === "arena" \? "blastGang"/);
  assert.match(page, /#leaderboard-around \[data-leaderboard-selected='true'\]/);
  assert.match(page, /leaderboard-jump-toggle/);
  assert.match(page, /jumpEdge/);
  // Round jump is first in the row and always visible (no focused gate).
  assert.ok(page.indexOf("leaderboard-jump-toggle") < page.indexOf("SORTS.map"));
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
  assert.match(page, /leaderboard\.pills\.place/);
  assert.match(page, /setDirection/);
  assert.match(page, /\.reverse\(\)/);
  assert.doesNotMatch(page, /<select/);
  assert.doesNotMatch(page, /leaderboard\.generated/);
  assert.doesNotMatch(page, /leaderboard\.top500/);
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
  assert.match(page, /popstate/);
  assert.match(page, /history\.pushState/);
  assert.match(page, /lastData/);
  assert.match(page, /leaderboard-switching/);
  // No remount key on the lists: rows keep DOM nodes, updates swap instantly.
  assert.doesNotMatch(page, /visible\.meta\.sort-\$\{direction\}/);
  assert.match(css, /\.leaderboard-switching/);
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

test("leaderboard mobile layout exposes one full list and sticky controls", async () => {
  const css = await read("app/globals.css");
  assert.match(css, /\.leaderboard-mode-switch \{[^}]*grid-template-columns: repeat\(4,/);
  assert.match(css, /\.leaderboard-mode-switch \{ grid-template-columns: repeat\(2,/);
  assert.match(css, /\.leaderboard-sticky \{[^}]*position: sticky/);
  assert.match(css, /\.leaderboard-sort-pills button\[aria-pressed="true"\]/);
  assert.match(css, /\.leaderboard-cards/);
  assert.doesNotMatch(css, /\.leaderboard-table \{ min-width: 7/);
  assert.match(css, /leaderboard-lists--has-around\[data-mobile-list="top"\]/);
  assert.match(css, /leaderboard-lists--has-around\[data-mobile-list="around"\]/);
  assert.doesNotMatch(css, /\.leaderboard-jumps \{/);
  assert.doesNotMatch(css, /body:has\(\.leaderboard-page--focused\) \.faq-trigger/);
  assert.match(css, /tr\[aria-current="true"\]/);
});
