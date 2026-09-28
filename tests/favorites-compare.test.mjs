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

test("the favorites note input follows the stored note after a rejected save", async () => {
  const source = await readFile("components/FavoritesList.tsx", "utf8");

  // `useFavorites().setNote` optimistically writes the note and reverts it when the
  // PATCH fails, but the row is keyed by identity and never remounts, so the local
  // draft has to follow `fav.note` or a rejected note stays on screen.
  assert.match(source, /const \[note, setNoteLocal\] = useState\(fav\.note \?\? ""\)/);
  assert.match(source, /useEffect\(\(\) => \{\s*\n\s*setNoteLocal\(fav\.note \?\? ""\);\s*\n\s*\}, \[fav\.note\]\)/);
});
