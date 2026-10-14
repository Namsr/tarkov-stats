import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { registerHooks } from "node:module";
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Exercise the actual client boundary during SSR, including the layout-less
// fallback Next uses. Transpile only these TSX modules with the installed compiler.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "next/link" && context.parentURL?.endsWith("/components/NotFoundPage.tsx")) {
      return { shortCircuit: true, url: "data:text/javascript,import {createElement} from 'react'; export default function Link(props){return createElement('a',props)}" };
    }
    if (specifier === "@/lib/i18n/context") {
      return { shortCircuit: true, url: pathToFileURL(realpathSync(resolve("lib/i18n/context.tsx"))).href };
    }
    if (specifier === "./dictionary" && context.parentURL?.endsWith("/lib/i18n/context.tsx")) {
      return { shortCircuit: true, url: pathToFileURL(realpathSync(resolve("lib/i18n/dictionary.ts"))).href };
    }
    if (specifier === "react" && context.parentURL?.startsWith("data:")) return nextResolve(specifier, { ...context, parentURL: import.meta.url });
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith("/lib/i18n/context.tsx") || url.endsWith("/components/NotFoundPage.tsx")) {
      const source = ts.transpileModule(readFileSync(new URL(url), "utf8"), {
        compilerOptions: { module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX },
      }).outputText;
      return { shortCircuit: true, format: "module", source };
    }
    return nextLoad(url, context);
  },
});

test("404 renders in either language without a layout and inherits an existing language provider", async () => {
  const { default: NotFoundPage } = await import("../components/NotFoundPage.tsx");
  const { LanguageProvider, useI18n } = await import("../lib/i18n/context.tsx");
  const { dict } = await import("../lib/i18n/dictionary.ts");
  for (const lang of ["ru", "en"]) {
    const html = renderToStaticMarkup(createElement(NotFoundPage, { initialLang: lang }));
    assert.ok(html.includes(dict[lang]["notFound.title"]));
    assert.ok(html.includes(dict[lang]["notFound.description"]));
    assert.ok(html.includes('href="/"'));
  }
  const html = renderToStaticMarkup(createElement(LanguageProvider, { initialLang: "ru" },
    createElement(NotFoundPage, { initialLang: "en" })));
  assert.ok(html.includes(dict.ru["notFound.title"]), "the header's language stays authoritative");
  assert.throws(() => renderToStaticMarkup(createElement(function MissingProvider() { useI18n(); return null; })), /LanguageProvider/);
});

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
