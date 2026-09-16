import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(path, "utf8");

test("home leaderboard keeps the previous table while the next mode loads", async () => {
  const [component, css] = await Promise.all([
    read("components/home/HomeLeaderboard.tsx"),
    read("components/home/home.css"),
  ]);
  // No wipe to the loading panel on mode change: that collapses the section
  // and shifts the whole page on every switch.
  assert.doesNotMatch(component, /setResult\(null\)/);
  // Stale-while-revalidate: the previous mode's snapshot stays on screen.
  assert.match(component, /result && result\.mode === mode \? result : null/);
  assert.match(component, /current \? current\.data : result\?\.data/);
  assert.match(component, /switching/);
  assert.match(component, /aria-busy=\{switching/);
  // The stale snapshot keeps its own mode for headers, values and links,
  // so rows never mix with the newly selected mode.
  assert.match(component, /displayMode/);
  assert.match(component, /result\.mode : mode/);
  assert.match(component, /displayMode === "arena" \? row\.stats\.arp : row\.score/);
  assert.match(component, /\/player\/\$\{displayMode\}/);
  // The stale table is visibly dimmed while the next mode loads.
  assert.match(css, /\.home-leaderboard-switching \{[^}]*opacity/);
});

test("home leaderboard still separates loading, error and retry states", async () => {
  const component = await read("components/home/HomeLeaderboard.tsx");
  assert.match(component, /data === undefined \? "common\.loading" : "leaderboard\.error"/);
  assert.match(component, /setAttempt\(\(value\) => value \+ 1\)/);
  assert.match(component, /home-loading-panel/);
});
