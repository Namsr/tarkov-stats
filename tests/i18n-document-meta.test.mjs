import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/** Line comments in the provider explain why, and one of them names the rejected
 *  alternative, so every assertion below reads the code rather than the prose. */
const withoutComments = (source) => source.replace(/^[ \t]*\/\/[^\r\n]*\r?\n/gm, "");

test("a language switch rewrites the tab title and description, using the keys the root layout renders", async () => {
  const provider = withoutComments(await readFile("lib/i18n/context.tsx", "utf8"));
  const layout = withoutComments(await readFile("app/layout.tsx", "utf8"));
  const dictionary = await readFile("lib/i18n/dictionary.ts", "utf8");

  // Anchored on the setLang body. The provider is the only place that applies the
  // language to the document, and an effect keyed on [lang] would leave the write
  // somewhere an unanchored match would also accept.
  const setLang = provider.slice(
    provider.indexOf("const setLang = useCallback("),
    provider.indexOf("const value = useMemo"),
  );
  assert.ok(setLang.length > 0, "the setLang callback must be locatable in the provider");

  // The two head writes. Naming `dict[l]` is the point: the value has to come from
  // the dictionary entry for the language being switched to, not from the one
  // currently rendered.
  assert.match(setLang, /document\.title = dict\[l\]\["meta\.title"\];/);
  assert.match(
    setLang,
    /document\.querySelector\('meta\[name="description"\]'\)\?\.setAttribute\(\s*"content",\s*dict\[l\]\["meta\.description"\],?\s*\);/,
  );

  // The behaviour that was already here, unchanged.
  assert.match(setLang, /document\.cookie = `lang=\$\{l\}; path=\/; max-age=31536000; SameSite=Lax`;/);
  assert.match(setLang, /document\.documentElement\.lang = l;/);

  // router.refresh() would make the layout re-render the metadata, but it re-fetches
  // the whole RSC payload too, which is the refetch family #205 and #225 removed. An
  // effect here would carry a dependency array that `t`, memoized on `lang`, changes
  // identity on; neither belongs in a file that must not re-request anything.
  assert.doesNotMatch(provider, /router\.refresh\(/);
  assert.doesNotMatch(provider, /useEffect/);

  // Drift guard. The only thing this duplicates is the two key names, so they are
  // pinned against the keys the layout reads rather than against a literal string:
  // renaming either side on its own fails here.
  const layoutKeys = [...layout.matchAll(/dict\[lang\]\["([^"]+)"\]/g)].map((match) => match[1]);
  const providerKeys = [...provider.matchAll(/dict\[l\]\["([^"]+)"\]/g)].map((match) => match[1]);
  assert.deepEqual(providerKeys, ["meta.title", "meta.description"]);
  assert.deepEqual([...layoutKeys].sort(), [...providerKeys].sort());

  // Without this the two writes would be no-ops on every dictionary edit, and the
  // dictionary is the one file no test reads for a value.
  assert.match(dictionary, /"meta\.title": "Tarkov Stats Comparator"/);
  assert.match(dictionary, /"meta\.title": "Tarkov Stats — сравнение игроков"/);
});
