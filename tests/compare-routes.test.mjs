import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

test("population routes delegate to the retained average implementation", async () => {
  const [populationPage, populationModePage, averagePage, averageModePage] = await Promise.all([
    readFile("app/population/page.tsx", "utf8"),
    readFile("app/population/[mode]/page.tsx", "utf8"),
    readFile("app/average/page.tsx", "utf8"),
    readFile("app/average/[mode]/page.tsx", "utf8"),
  ]);
  await Promise.all([
    access("app/average/page.tsx"),
    access("app/average/[mode]/page.tsx"),
  ]);

  assert.match(populationPage, /import AveragePage from "@\/app\/average\/page"/);
  assert.match(populationPage, /export default AveragePage/);
  assert.match(populationModePage, /import CanonicalAveragePage from "@\/app\/average\/\[mode\]\/page"/);
  assert.match(populationModePage, /export default CanonicalAveragePage/);
  assert.match(averagePage, /mode = "regular"/);
  assert.match(averageModePage, /gameModeFromAppRoute\(routeMode\)/);
  assert.match(averageModePage, /if \(!mode\) notFound\(\)/);
  assert.match(averageModePage, /if \(mode === "regular" \|\| mode === "pve"\)/);
  assert.match(averageModePage, /if \(mode === "arena"\)/);
  assert.match(averageModePage, /if \(!isSeasonalRolloutReady\(\)/);
  assert.match(averageModePage, /Array\.isArray\(requestedCycle\)/);
  assert.match(averageModePage, /<ModeUnavailable seasonal \/>/);
});

test("average URLs permanently redirect to population without dropping query parameters", async () => {
  const config = await readFile("next.config.ts", "utf8");
  const redirects = config.match(/async redirects\(\) \{[\s\S]*?\n  \},/)?.[0];

  assert.ok(redirects);
  assert.match(redirects, /source: "\/average", destination: "\/population", permanent: true/);
  assert.match(redirects, /source: "\/average\/:mode", destination: "\/population\/:mode", permanent: true/);
  assert.doesNotMatch(redirects, /\?/);
});

test("compare route resolves the active Seasonal cycle on the server", async () => {
  const page = await readFile("app/compare/page.tsx", "utf8");
  assert.match(page, /import \{ connection \} from "next\/server"/);
  assert.match(page, /await connection\(\)/);
  assert.match(page, /loadSeasonalCycleConfig\(\)/);
  assert.match(page, /isSeasonalRolloutReady\(\)/);
  assert.match(page, /<ComparePage seasonalCycleId=\{seasonalCycleId\} \/>/);
  assert.match(page, /<Suspense fallback=\{<main className="page-frame" aria-busy="true" \/>\}>/);
});
