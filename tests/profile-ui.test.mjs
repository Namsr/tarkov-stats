import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

test("missing mode keeps the profile shell without mounting data sections", async () => {
  const source = await readFile("components/RegularPlayer.tsx", "utf8");
  const unavailableStart = source.indexOf("if (modeUnavailable)");
  const genericErrorStart = source.indexOf("if (error || !stats)");
  assert.ok(unavailableStart > 0 && genericErrorStart > unavailableStart);

  const unavailableUi = source.slice(unavailableStart, genericErrorStart);
  assert.match(source, /data\.code === "mode_profile_unavailable"/);
  assert.match(source, /profileSummary\?: ProfileSummary/);
  assert.match(unavailableUi, /<ProfileActions/);
  assert.match(unavailableUi, /profileSummary\?\.nickname/);
  assert.match(unavailableUi, /<StatCard key=\{label\} label=\{label\} value="\?" \/>/);
  assert.match(unavailableUi, /<ProfileModeSwitch|<ProfileActions/);
  assert.match(unavailableUi, /key=\{`\$\{aid\}:\$\{mode\}`\}[\s\S]*?onCheck=\{refreshProfile\}/);

  const labelLists = unavailableUi.match(/\? \[(.*?)\]\s*: \[(.*?)\];/s);
  assert.ok(labelLists);
  assert.equal(labelLists[1].match(/t\(/g)?.length, 4);
  assert.equal(labelLists[2].match(/t\(/g)?.length, 4);

  for (const component of [
    "PlayerRadarComparison",
    "CheaterScore",
    "EarlyUnlocks",
  ]) {
    assert.doesNotMatch(unavailableUi, new RegExp(`<${component}`));
  }
  assert.doesNotMatch(unavailableUi, /player\.raidStats|player\.progression|player\.skills/);
});

test("ordinary profile failures retain the generic error UI", async () => {
  const source = await readFile("components/RegularPlayer.tsx", "utf8");
  assert.match(source, /const unavailable = data\.code === "mode_profile_unavailable"/);
  assert.match(source, /throw new Error\(data\.error \?\? t\("player\.loadError"\)\)/);
  assert.match(source, /if \(error \|\| !stats\)[\s\S]*?\{error \|\| t\("player\.unknownError"\)\}/);
});

test("profile actions share a top edge and helper copy sits underneath", async () => {
  const regular = await readFile("components/RegularPlayer.tsx", "utf8");
  const favorite = await readFile("components/FavoriteButton.tsx", "utf8");
  const report = await readFile("components/CheaterReportButton.tsx", "utf8");

  assert.match(regular, /flex flex-wrap items-start gap-2/);
  assert.match(regular, /className="!min-h-12 whitespace-nowrap"/);
  assert.equal((favorite.match(/!min-h-12/g) ?? []).length, 2);
  assert.match(report, /!min-h-12 whitespace-nowrap/);
  assert.match(report, /<\/button>\s*<p[^>]*>\{t\("report\.count"/);
});

test("visitor help is hidden from home without deleting its implementation", async () => {
  const home = await readFile("components/HomePage.tsx", "utf8");
  assert.doesNotMatch(home, /CommunityHelper/);
  await access("components/CommunityHelper.tsx");
  await access("app/api/community/ban-reviews/claim/route.ts");
});

test("average statistic switch keeps URL state and masks stale portrait values", async () => {
  const source = await readFile("app/average/page.tsx", "utf8");

  assert.match(source, /searchParams\.get\("statistic"\) === "median"/);
  assert.match(source, /new URLSearchParams\(searchParams\.toString\(\)\)/);
  assert.match(source, /params\.delete\("statistic"\)/);
  assert.match(source, /router\.replace\([\s\S]*?\{ scroll: false \}\)/);
  assert.match(source, /new URLSearchParams\(\{ dimension, metric: yMetric, mode, statistic, period \}\)/);
  assert.match(source, /\.then\(\(json\) => \{\s*if \(controller\.signal\.aborted\) return;\s*setData\(json\)/);
  assert.match(source, /data\?\.statistic === statistic && data\.period === period/);
  assert.match(source, /aria-pressed=\{statistic === option\}/);
});

test("regular average period switch keeps URL state and masks stale responses", async () => {
  const source = await readFile("app/average/page.tsx", "utf8");

  assert.match(source, /mode === "regular" && searchParams\.get\("period"\) === "90d"/);
  assert.match(source, /params\.set\("period", next\)/);
  assert.match(source, /params\.delete\("period"\)/);
  assert.match(source, /setSelection\(null\);\s*setRequestedRange\(null\);\s*setData\(null\);/);
  assert.match(source, /new URLSearchParams\(\{ dimension, metric: yMetric, mode, statistic, period \}\)/);
  assert.match(source, /data\?\.statistic === statistic && data\.period === period/);
  assert.match(source, /mode === "regular" && \(/);
  assert.match(source, /aria-pressed=\{period === option\}/);
});

test("radar statistic switch identifies requests by method", async () => {
  const source = await readFile("components/PlayerRadarComparison.tsx", "utf8");

  assert.match(source, /searchParams\.get\("statistic"\) === "median"/);
  assert.match(source, /statistic,\s*period,\s*\}\);/);
  assert.match(source, /requestId: `\$\{sourceAid\}:\$\{mode\}:\$\{dimension\}:\$\{center\}:\$\{/);
  assert.match(source, /remoteCohort\?\.requestId === `\$\{aid\}:\$\{mode\}:\$\{dimension\}:\$\{center\}:\$\{statistic\}:/);
  assert.match(source, /params\.delete\("statistic"\)/);
  assert.match(source, /router\.replace\([\s\S]*?\{ scroll: false \}\)/);
  assert.match(source, /aria-pressed=\{statistic === value\}/);
});

test("regular radar period switch identifies requests by freshness", async () => {
  const source = await readFile("components/PlayerRadarComparison.tsx", "utf8");

  assert.match(source, /mode === "regular" && searchParams\.get\("period"\) === "90d"/);
  assert.match(source, /period,\s*\}\);/);
  assert.match(source, /requestId: `\$\{sourceAid\}:\$\{mode\}:\$\{dimension\}:\$\{center\}:\$\{input\.statistic \?\? statistic\}:\$\{input\.period \?\? period\}`/);
  assert.match(source, /remoteCohort\?\.requestId === `\$\{aid\}:\$\{mode\}:\$\{dimension\}:\$\{center\}:\$\{statistic\}:\$\{period\}`/);
  assert.match(source, /params\.delete\("period"\)/);
  assert.match(source, /aria-pressed=\{period === value\}/);
});

test("profile refresh checks automatically after returning without requiring F5", async () => {
  const button = await readFile("components/RefreshButton.tsx", "utf8");
  const profile = await readFile("components/RegularPlayer.tsx", "utf8");

  assert.match(button, /window\.addEventListener\("focus", handleFocus\)/);
  assert.match(button, /awaitingReturn\.current = true/);
  assert.match(button, /if \(!onCheck\) return/);
  assert.match(button, /if \(!onCheck \|\| checking\.current\) return/);
  assert.match(button, /player\.refreshCheckAgain/);
  assert.match(button, /onCheck && status !== "idle"/);
  assert.match(button, /aria-live="polite"/);
  assert.match(profile, /new URLSearchParams\(\{ aid, mode, refresh: "1" \}\)/);
  assert.match(profile, /setStats\(data\.stats\)/);
  assert.match(profile, /JSON\.stringify\(data\.stats\) !== JSON\.stringify\(previousStats\)/);
  assert.match(profile, /requestGeneration\.current \+= 1/);
  assert.match(profile, /if \(generation !== requestGeneration\.current\) return "unchanged"/);
  assert.match(profile, /if \(refreshPromise\.current === request\) refreshPromise\.current = null/);
  assert.ok((profile.match(/key=\{`\$\{aid\}:\$\{mode\}`\}/g) ?? []).length >= 2);
  assert.equal((profile.match(/player\.profileUpdated/g) ?? []).length, 1);
});

test("unknown regular PvP stats are not rendered or scored as zero", async () => {
  const profile = await readFile("components/RegularPlayer.tsx", "utf8");
  const radar = await readFile("components/PlayerRadarComparison.tsx", "utf8");
  const score = await readFile("components/CheaterScore.tsx", "utf8");

  assert.match(profile, /mode !== "regular" \|\| stats\.pvpStatsKnown !== false/);
  assert.match(profile, /pvpStatsKnown \? stats\.pmcKdRatio : t\("common\.notAvailable"\)/);
  assert.match(profile, /pvpStatsKnown \? stats\.killedPmc\.toLocaleString\(\) : t\("common\.notAvailable"\)/);
  assert.match(radar, /playerStatsKnown \? valuesFromStats\(stats\) : null/);
  assert.match(radar, /favoriteStats && favoriteStatsKnown/);
  assert.match(radar, /radar\.incompletePvp\.player/);
  assert.match(radar, /radar\.incompletePvp\.favorite/);
  assert.match(score, /if \(!pvpStatsKnown\)/);
  assert.match(score, /cheater\.incompletePvp/);
});
