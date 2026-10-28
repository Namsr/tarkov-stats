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
