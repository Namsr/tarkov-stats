import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("global navigation points to compare and only marks its root active", async () => {
  const source = await readFile("components/AverageNavButton.tsx", "utf8");

  assert.match(source, /export default function CompareNavButton/);
  assert.match(source, /href="\/compare"/);
  assert.match(source, /const active = pathname === "\/compare" \|\| pathname === "\/compare\/"/);
  assert.doesNotMatch(source, /pathname\.startsWith\("\/compare"\)/);
  assert.match(source, /t\("nav\.compare"\)/);
});

test("average mode navigation uses population routes without renaming the page contract", async () => {
  const source = await readFile("components/ProfileModeSwitch.tsx", "utf8");

  assert.match(source, /page: "average" \| "player"/);
  assert.match(source, /page === "average" \? `\/population\/\$\{routeMode\}` : `\/player\/\$\{routeMode\}\/\$\{aid\}`/);
  assert.doesNotMatch(source, /\/average\/\$\{routeMode\}/);
});

test("population headers use the population label while retaining page average", async () => {
  const source = await readFile("components/AveragePageHeader.tsx", "utf8");

  assert.match(source, /import \{ usePathname \} from "next\/navigation"/);
  assert.match(source, /const isPopulation = pathname === "\/population" \|\| pathname\.startsWith\("\/population\/"\)/);
  assert.match(source, /<h1 className="page-title">\{t\("nav\.population"\)\}<\/h1>/);
  assert.match(source, /<h1 className="page-title">\{t\("nav\.average"\)\}<\/h1>/);
  assert.match(source, /<ProfileModeSwitch[\s\S]*page="average"/);
  assert.doesNotMatch(source, /page="population"/);
});

test("compare page keeps regular DTO loads and URL selection state", async () => {
  const [page, source] = await Promise.all([
    readFile("app/compare/page.tsx", "utf8"),
    readFile("components/ComparePage.tsx", "utf8"),
  ]);

  assert.match(page, /ComparePage/);
  assert.match(source, /export interface PlayerProfileResponse/);
  assert.equal((source.match(/loadPlayerProfileResponse<PlayerProfileResponse>/g) ?? []).length, 2);
  assert.equal((source.match(/response\.identity\?\.aid === aid && response\.identity\.mode === "regular" && response\.identity\.cycleId === "persistent"/g) ?? []).length, 2);
  assert.doesNotMatch(source, /if \(!response\.identity\) return true/);
  assert.equal((source.match(/fixedMode="regular"/g) ?? []).length, 2);
  assert.match(source, /params\.set\(slot === "primary" \? "aid" : "vs", String\(aid\)\)/);
  assert.match(source, /router\.replace\(`\/compare/);
  assert.match(source, /scroll: false/);
  assert.match(source, /\/api\/average\/cohort\?/);
  assert.match(source, /statistic: "median"/);
  assert.match(source, /period: "90d"/);
});

test("compare page renders per-metric percentiles without unsupported claims", async () => {
  const source = await readFile("components/ComparePage.tsx", "utf8");

  assert.match(source, /percentiles: Record<CompareMetricKey, ComparePercentileMetric>/);
  assert.match(source, /percentile: number \| null/);
  assert.match(source, /count: number/);
  assert.match(source, /below: number/);
  assert.match(source, /equal: number/);
  assert.match(source, /medianPercentile/);
  assert.match(source, /compare\.medianPercentilesTitle/);
  assert.match(source, /compare\.strengths/);
  assert.match(source, /compare\.weaknesses/);
  assert.match(source, /compare\.secondPrompt/);
  assert.match(source, /compare\.fullProfile/);
  assert.match(source, /compare\.population/);
  assert.doesNotMatch(source, /overall percentile/i);
  assert.doesNotMatch(source, /P25|P75|trend/i);
});

test("compare page ranks only available values and does not duplicate a lone percentile", async () => {
  const source = await readFile("components/ComparePage.tsx", "utf8");
  const values = source.slice(
    source.indexOf("function valuesFromStats"),
    source.indexOf("function benchmarkFor"),
  );

  assert.match(values, /const pmcStatsKnown = stats\.pvpStatsKnown !== false/);
  assert.match(values, /kd_ratio: finiteMetric\(stats\.kdRatio\)/);
  assert.match(values, /pmc_kd_ratio: pmcStatsKnown \? finiteMetric\(stats\.pmcKdRatio\) : null/);
  assert.match(values, /kills_per_raid: finiteMetric\(stats\.killsPerRaid\)/);
  assert.match(values, /pmc_survival_rate: pmcStatsKnown \? finiteMetric\(stats\.pmcSurvivalRate\) : null/);
  assert.match(values, /longest_win_streak: finiteMetric\(stats\.longestWinStreak\)/);
  assert.match(values, /level: finiteMetric\(stats\.level\)/);
  assert.doesNotMatch(values, /if \(!stats \|\| stats\.pvpStatsKnown === false\)/);
  assert.match(source, /if \(primaryValues\[metric\.key\] === null\) return \[\]/);
  assert.match(source, /percentile: primaryValues\[metric\.key\] === null \? null : finitePercentile/);
  assert.match(source, /ranked\.length === 1 \? \([\s\S]*?<RankedMetricList title=\{t\("compare\.ranksKicker"\)\} items=\{ranked\} \/>[\s\S]*?\) : \([\s\S]*?<RankedMetricList title=\{t\("compare\.strengths"\)\} items=\{strengths\} \/>[\s\S]*?<RankedMetricList title=\{t\("compare\.weaknesses"\)\} items=\{weaknesses\} \/>/);
});

test("comparison table and badge use server percentile semantics", async () => {
  const [table, badge] = await Promise.all([
    readFile("components/ComparisonTable.tsx", "utf8"),
    readFile("components/PercentileBadge.tsx", "utf8"),
  ]);

  assert.match(table, /scope="row"/);
  assert.match(table, /<PercentileBadge percentile=\{row\.percentile\}/);
  assert.match(table, /compare\.cohortBenchmark/);
  assert.match(badge, /percentile: number \| null \| undefined/);
  assert.match(badge, /if \(percentile == null/);
  assert.match(badge, /P\{value\}/);
  assert.doesNotMatch(badge, /playerValue|medianValue|higherIsBetter/);
});

test("comparison navigation and honest median copy are bilingual", async () => {
  const dictionary = await readFile("lib/i18n/dictionary.ts", "utf8");

  assert.match(dictionary, /"nav\.compare": "Compare players"/);
  assert.match(dictionary, /"nav\.compare": "Сравнение игроков"/);
  assert.match(dictionary, /"nav\.population": "Population"/);
  assert.match(dictionary, /"nav\.population": "Популяция"/);
  assert.match(dictionary, /"compare\.medianPercentilesTitle": "Median of metric percentiles"/);
  assert.match(dictionary, /"compare\.medianPercentilesTitle": "Медиана процентилей метрик"/);
  assert.match(dictionary, /"pct\.badge": "Percentile P\{value\}"/);
  assert.match(dictionary, /"pct\.badge": "Процентиль P\{value\}"/);
});
