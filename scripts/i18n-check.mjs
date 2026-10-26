// i18n guard. Fails (exit 1) if the UI could ship in only one language:
//   1) a literal t("key") used in app/ or components/ has no dictionary entry;
//   2) the `en` and `ru` key sets in lib/i18n/messages.json have diverged.
//
// Computed keys like t("metric." + x) are skipped (the literal ends with "."),
// so add such namespaces to BOTH languages and rely on the parity check.
//
// Run: `node scripts/i18n-check.mjs` (also runs automatically before `build`).

import fs from "node:fs";
import path from "node:path";

const DICT = "lib/i18n/messages.json";
const SCAN_DIRS = ["app", "components", "rust/ui/src"];

function fail(msg) {
  console.error(`[31m✗ i18n-check: ${msg}[0m`);
}

const messages = JSON.parse(fs.readFileSync(DICT, "utf8"));
for (const lang of ["en", "ru"]) {
  if (!messages[lang] || Object.values(messages[lang]).some((value) => typeof value !== "string")) {
    fail(`invalid ${lang} translations in ${DICT}`);
    process.exit(1);
  }
}
const enKeys = new Set(Object.keys(messages.en));
const ruKeys = new Set(Object.keys(messages.ru));
const allKeys = new Set([...enKeys, ...ruKeys]);

const walk = (dir) => fs.existsSync(dir)
  ? fs.readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && /\.(?:tsx?|rs)$/.test(e.name))
    .map((e) => path.join(e.parentPath, e.name))
  : [];

const usedMissing = [];
for (const f of SCAN_DIRS.flatMap(walk)) {
  const code = fs.readFileSync(f, "utf8");
  for (const m of code.matchAll(/\bt\(\s*["'`]([^"'`]+)["'`]/g)) {
    const key = m[1];
    if (key.endsWith(".")) continue; // computed prefix, e.g. t("metric." + x)
    if (!allKeys.has(key)) usedMissing.push({ key, file: f.replace(/\\/g, "/") });
  }
}

const onlyEn = [...enKeys].filter((k) => !ruKeys.has(k));
const onlyRu = [...ruKeys].filter((k) => !enKeys.has(k));

let ok = true;
if (usedMissing.length) {
  ok = false;
  fail(`${usedMissing.length} t() key(s) used but missing from the dictionary:`);
  for (const u of usedMissing) console.error(`    "${u.key}"  (${u.file})`);
}
if (onlyEn.length) {
  ok = false;
  fail(`${onlyEn.length} key(s) in en but missing in ru: ${onlyEn.map((k) => `"${k}"`).join(", ")}`);
}
if (onlyRu.length) {
  ok = false;
  fail(`${onlyRu.length} key(s) in ru but missing in en: ${onlyRu.map((k) => `"${k}"`).join(", ")}`);
}

if (!ok) {
  console.error("\ni18n-check failed — every user-facing string needs a t() key with BOTH en and ru entries.");
  process.exit(1);
}
console.log(`[32m✓ i18n-check: ${enKeys.size} keys, en/ru in sync, all t() keys resolve[0m`);
