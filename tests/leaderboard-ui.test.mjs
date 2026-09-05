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
  assert.match(page, /rows=\{data\.top\}/);
  assert.match(page, /rows=\{data\.around\}/);
  assert.doesNotMatch(page, /\.slice\(/);
  assert.equal((table.match(/prefetch=\{false\}/g) ?? []).length, 2);
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
  assert.match(page, /arenaMode: "blastGang", sort: "primary"/);
  assert.match(page, /#leaderboard-around \[data-leaderboard-selected='true'\]/);
  assert.match(page, /data-leaderboard-selected="true" className="leaderboard-insufficient/);
  assert.match(page, /leaderboard-lists--has-around/);
  assert.match(page, /\["regular", "pve", "arena", "pvp-season"\]/);
  assert.match(page, /"pvp-season": t\("fav\.mode\.seasonal"\)/);
  assert.match(page, /mode === "pvp-season" && cycle/);
  assert.match(page, /data\?\.meta\.cycleId \?\? cycle/);
});

test("leaderboard mobile layout exposes one full list and fixed jump controls", async () => {
  const css = await read("app/globals.css");
  assert.match(css, /\.leaderboard-mode-switch \{[^}]*grid-template-columns: repeat\(4,/);
  assert.match(css, /\.leaderboard-mode-switch \{ grid-template-columns: repeat\(2,/);
  assert.match(css, /\.leaderboard-jumps \{ position: fixed;/);
  assert.match(css, /leaderboard-lists--has-around\[data-mobile-list="top"\]/);
  assert.match(css, /leaderboard-lists--has-around\[data-mobile-list="around"\]/);
  assert.match(css, /body:has\(\.leaderboard-page--focused\) \.faq-trigger/);
  assert.match(css, /tr\[aria-current="true"\]/);
});
