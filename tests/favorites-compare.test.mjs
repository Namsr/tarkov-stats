import { readFile } from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";

test("favorites comparison keeps regular and PvE tables mode-local", async () => {
  const source = await readFile("components/FavoritesCompare.tsx", "utf8");

  assert.match(source, /const COMPARE_MODES = \["regular", "pve"\]/);
  assert.match(source, /const groups = COMPARE_MODES\.map\(\(mode\) =>/);
  assert.match(source, /\.filter\(\(favorite\) => favorite\.mode === mode\)/);
  assert.match(source, /const comparableGroups = visibleGroups\.filter/);
  assert.match(source, /<ComparisonTable key=\{group\.mode\} mode=\{group\.mode\} cols=\{group\.cols\} \/>/);

  // A favorite's selected identity remains the source for both lookup and link.
  assert.match(source, /statsByFavorite\.get\(favoriteKey\(favorite\)\)/);
  assert.match(source, /href=\{favoriteHref\(c\.fav\)\}/);
  assert.match(source, /key=\{favoriteKey\(c\.fav\)\}/);
  assert.doesNotMatch(source, /favorite\.mode === "regular"/);
});
