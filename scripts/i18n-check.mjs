// i18n guard. Fails (exit 1) if the UI could ship in only one language:
//   1) a literal t("key") used in app/ or components/ has no dictionary entry;
//   2) the `en` and `ru` key sets in lib/i18n/dictionary.ts have diverged.
//
// Computed keys like t("metric." + x) are skipped (the literal ends with "."),
// so add such namespaces to BOTH languages and rely on the parity check.
//
// Run: `node scripts/i18n-check.mjs` (also runs automatically before `build`).

import fs from "node:fs";
import path from "node:path";

const DICT = "lib/i18n/dictionary.ts";
const SCAN_DIRS = ["app", "components"];

function fail(msg) {
  console.error(`[31m✗ i18n-check: ${msg}[0m`);
}

const src = fs.readFileSync(DICT, "utf8");
const ruIdx = src.indexOf("const ru: Dict = {");
if (ruIdx < 0) {
  fail(`could not find the ru object in ${DICT}`);
  process.exit(1);
}
const keysOf = (s) => new Set([...s.matchAll(/^\s*"([^"]+)":/gm)].map((m) => m[1]));
const enKeys = keysOf(src.slice(0, ruIdx));
const ruKeys = keysOf(src.slice(ruIdx));
const allKeys = new Set([...enKeys, ...ruKeys]);

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  let out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out = out.concat(walk(p));
    else if (e.name.endsWith(".tsx") || e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

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
