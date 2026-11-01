import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const messages = JSON.parse(readFileSync("lib/i18n/messages.json", "utf8"));
const source = readFileSync("app/average/page.tsx", "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;

function renderInitial(lang, defaultLocale) {
  const compiledModule = { exports: {} };
  const t = (key, vars = {}) => (messages[lang][key] ?? key).replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? `{${name}}`));
  const modules = {
    "next/navigation": { usePathname: () => "/population/pve", useRouter: () => ({}), useSearchParams: () => new URLSearchParams() },
    "@/lib/i18n/context": { useI18n: () => ({ t, lang }) },
    "@/lib/histogram": { buildHistogram: () => [], buildNumericHistogram: () => [] },
    "@/lib/metrics": { DEFAULT_Y: "players", Y_METRICS: [], resolveY: () => ({ agg: "count" }), formatValue: () => "" },
    "@/lib/client-average-request": { loadAverageJson: () => {}, cancelAveragePrefetches: () => {} },
  };
  const localRequire = name => name.startsWith("@/components/") ? { __esModule: true, default: () => null } : modules[name] ?? require(name);
  new Function("require", "module", "exports", compiled)(localRequire, compiledModule, compiledModule.exports);
  const original = Number.prototype.toLocaleString;
  try {
    Number.prototype.toLocaleString = function(locale, options) { return original.call(this, locale ?? defaultLocale, options); };
    return renderToStaticMarkup(React.createElement(compiledModule.exports.default, { mode: "pve" }));
  } finally { Number.prototype.toLocaleString = original; }
}

test("initial average SSR text uses the request language, independent of runtime default locale", () => {
  for (const lang of ["ru", "en"]) {
    const server = renderInitial(lang, "en-US"), client = renderInitial(lang, "ru-RU");
    assert.equal(server, client, `${lang}: same props must produce identical initial markup across runtime locales`);
    assert.ok(server.includes(lang === "ru" ? "5\u00a0000" : "5,000"));
  }
});

const achievementSource = readFileSync("components/ProfileAchievements.tsx", "utf8");
const achievementCompiled = ts.transpileModule(achievementSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const achievementHelpers = await import("../lib/profile-achievements.ts");
function renderAchievements({ variant, expanded, lang, count = 5 }) {
  let state = 0;
  const react = { ...React, useState(initial) { state++; return React.useState(state === 3 ? expanded : initial); } };
  const modules = {
    react,
    "next/image": { __esModule: true, default: props => React.createElement("img", props) },
    "@/components/ProfileCollapsible": { __esModule: true, default: ({ children }) => React.createElement("div", null, children), ProfileCollapseToggle: () => null },
    "@/lib/i18n/context": { useI18n: () => ({ lang, t: key => messages[lang][key] ?? key }) },
    "@/lib/profile-achievements": achievementHelpers,
  };
  const compiledModule = { exports: {} };
  new Function("require", "module", "exports", achievementCompiled)(name => modules[name] ?? require(name), compiledModule, compiledModule.exports);
  const items = Array.from({ length: count }, (_, i) => ({ id: `a${i}`, name: `Name ${i}`, nameRu: `Имя ${i}`, owners: 5, percentage: i + 1 }));
  return renderToStaticMarkup(React.createElement(compiledModule.exports.default, { items, variant, mode: "pve", cycleId: "persistent" }));
}
test("achievement average hides the partial tail from AT and keyboard while preserving the profile variant", () => {
  for (const lang of ["en", "ru"]) for (const expanded of [false, true]) {
    const markup = renderAchievements({ variant: "average", expanded, lang });
    const table = markup.match(/<tbody>([\s\S]*?)<\/tbody>/)[1];
    const layouts = [Array.from(table.matchAll(/<tr\b[^>]*>/g), match => match[0]), Array.from(markup.matchAll(/<article\b[^>]*>/g), match => match[0])];
    for (const rows of layouts) {
      assert.equal(rows.length, 5);
      rows.forEach((row, i) => {
        const hidden = !expanded && i >= 3;
        assert.equal(/\saria-hidden="true"/.test(row), hidden, `${lang}/${expanded}/${i} aria`);
        assert.equal(/\sinert=""/.test(row), hidden, `${lang}/${expanded}/${i} inert`);
      });
    }
  }
  const profile = renderAchievements({ variant: "profile", expanded: false, lang: "en" });
  const rows = Array.from(profile.match(/<tbody>([\s\S]*?)<\/tbody>/)[1].matchAll(/<tr\b[^>]*>/g), match => match[0]);
  assert.ok(!rows[3].includes("aria-hidden") && !rows[3].includes("inert"));
  assert.ok(rows[4].includes('aria-hidden="true"') && !rows[4].includes("inert"));
  const short = renderAchievements({ variant: "average", expanded: false, lang: "en", count: 3 });
  assert.doesNotMatch(short, /\sinert=""/);
});
