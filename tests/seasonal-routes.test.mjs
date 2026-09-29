import assert from "node:assert/strict";
import { access, readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const exists = (path) => access(path).then(() => true, () => false);

test("one catch-all route serves both legacy and canonical player URLs", async () => {
  assert.equal(await exists("app/player/[[...segments]]/page.tsx"), true);
  assert.equal(await exists("app/player/[aid]/page.tsx"), false);
  assert.equal(await exists("app/player/[mode]/[aid]/page.tsx"), false);
});

test("every direct Seasonal page and API entry point uses the full rollout gate", async () => {
  const directEntries = [
    "app/player/[[...segments]]/page.tsx",
    "app/average/[mode]/page.tsx",
    "app/api/player/profile/route.ts",
    "app/api/player/risk/route.ts",
    "app/api/seasonal/progression/route.ts",
    "app/api/operator/seasonal/ban/route.ts",
    "app/api/operator/seasonal/profile/route.ts",
    "app/api/operator/seasonal/run/route.ts",
    "app/api/operator/seasonal/status/route.ts",
    "app/api/community-reports/route.ts",
  ];
  for (const path of directEntries) {
    assert.match(await readFile(path, "utf8"), /isSeasonalRolloutReady\(\)/, path);
  }

  const profileSync = await readFile("app/api/operator/seasonal/profile-sync/route.ts", "utf8");
  assert.match(profileSync, /isSeasonalCollectorReady\(\)/);
  assert.match(profileSync, /allowDisabledCycle: true/);
  assert.match(profileSync, /enabled: true/);

  const helperApi = await readFile("lib/seasonal/helper-api.ts", "utf8");
  assert.match(helperApi, /isCommunityHelperEnabled\(\)/);
  for (const source of [
    await readFile("app/api/player/profile/route.ts", "utf8"),
    await readFile("app/api/operator/seasonal/profile/route.ts", "utf8"),
    helperApi,
  ]) {
    assert.doesNotMatch(source, /refreshProgressionAfterCapture/);
  }

  const playerProfile = await readFile("app/api/player/profile/route.ts", "utf8");
  assert.match(
    playerProfile,
    /fetchPayload: \(\{ aid: seasonalAid, force: shouldForce \}\) =>\s*fetchSeasonalPayload\(seasonalAid, \{ force: shouldForce \}\)/,
  );
  assert.match(
    playerProfile,
    /result\.status === 404[\s\S]*?identity: \{ aid, mode, cycleId \}[\s\S]*?code: "mode_profile_unavailable"/,
  );
});

test("the Seasonal refresh route reports a missing cycle and a missing owner differently", async () => {
  const refresh = await readFile("app/api/operator/seasonal/refresh/route.ts", "utf8");
  // `owner` is a required request field that is passed to every queue call, so
  // omitting it is a client error. A missing cycle stays a 409 server conflict.
  assert.match(refresh, /if \(!cycle\) return Response\.json\(\{ error: "Active Seasonal cycle is required" \}, \{ status: 409, headers \}\);/);
  assert.match(refresh, /if \(!owner\) return Response\.json\(\{ error: "owner is required" \}, \{ status: 400, headers \}\);/);
  assert.doesNotMatch(refresh, /!cycle \|\| !owner/);
  // The sibling operator route already reports the same class of problem as a 400.
  const run = await readFile("app/api/operator/seasonal/run/route.ts", "utf8");
  assert.match(run, /\{ error: "cycleId and owner are required" \}, \{ status: 400, headers \}/);
});

test("the Seasonal run route authorizes before it reads a lease or opens the store", async () => {
  const run = await readFile("app/api/operator/seasonal/run/route.ts", "utf8");
  // `activeLease` answers whoever supplies a runId, taskId, and owner, and the
  // store read is the same kind of read, so either one hoisted above the auth
  // check would hand a caller lease data before it is authorized.
  // The call forms, not the import block: a bare `isOperatorRequest` matches the
  // import on line 1, which sits above every read and pins nothing.
  const auth = run.indexOf("isOperatorRequest(request)");
  assert.notEqual(auth, -1, "isOperatorRequest is missing from the run route");
  for (const name of ["activeLease(", "getSeasonalOperatorStore("]) {
    const at = run.indexOf(name);
    // A missing name is `indexOf` -1, which would sail past an ordering check.
    assert.notEqual(at, -1, `${name} is missing from the run route`);
    assert.ok(auth < at, `isOperatorRequest must precede ${name}`);
  }
});

test("the player risk route gates Seasonal on the active cycle, not just on syntax", async () => {
  const risk = await readFile("app/api/player/risk/route.ts", "utf8");
  // `normalizeCycleId` accepts any well-formed cycle string, so without the gate a
  // request could read a verdict for a cycle the site does not expose — the JSON
  // collector warms exactly those rows before `isSeasonalRolloutReady()` is true.
  assert.match(risk, /if \(mode === "seasonal"\) \{/);
  // A season that has not rolled out is absent, not a client mistake, so the gate
  // answers 404 like the sibling routes on this gate do and only a cycle mismatch
  // is a 400. This assertion used to pin the folded one-liner instead, which
  // presented the 400 as deliberate fail-closed; the invariant worth keeping is
  // that the two cases are answered differently, not how the source is spelled.
  assert.match(
    risk,
    /if \(!isSeasonalRolloutReady\(\) \|\| !cycle\) \{\s*return NextResponse\.json\(\{ error: "Seasonal risk unavailable" \}, \{ status: 404, headers: noStore \}\);/,
  );
  assert.match(
    risk,
    /if \(cycleId !== cycle\.cycleId\) \{\s*return NextResponse\.json\(\{ error: "Invalid or missing cycle" \}, \{ status: 400, headers: noStore \}\);/,
  );
  // Do not fold the mismatch back onto the gate line: that is the original defect.
  assert.doesNotMatch(risk, /!isSeasonalRolloutReady\(\) \|\| !cycle \|\|/);
  // The gate has to run before storage is opened.
  assert.ok(
    risk.indexOf("isSeasonalRolloutReady()") < risk.indexOf("getRiskEvaluation("),
    "the rollout gate must precede the risk read",
  );
});

test("community reports refuse a Seasonal profile from a cycle that is not the live one", async () => {
  const reports = await readFile("app/api/community-reports/route.ts", "utf8");
  const gated = reports.slice(
    reports.indexOf('if (input.mode === "seasonal") {'),
    reports.indexOf('if (input.mode === "regular") {'),
  );

  // Fail-closed in the same four-part shape app/api/seasonal/cohort/route.ts uses,
  // and it must run before the store is opened, not after a snapshot is found.
  assert.match(
    gated,
    /if \(!isSeasonalRolloutReady\(\) \|\| !cycle \|\| cycle\.cycleId !== input\.cycleId \|\| !cycle\.enabled\) return false;/,
  );
  assert.ok(
    gated.indexOf("isSeasonalRolloutReady()") < gated.indexOf("getSeasonalStore()"),
    "the gate must precede the Seasonal store lookup",
  );
  // The caller only learns "Profile not found", so a gated cycle is
  // indistinguishable from an absent one.
  assert.match(gated, /return false;/);
  assert.doesNotMatch(gated, /cycle_unavailable|unavailable/);
  // The non-seasonal branches keep their existing lookups.
  assert.match(reports, /getProgressionStore\("regular"\)/);
  assert.match(reports, /getStore\(input\.mode as CrossSectionMode\)/);
});

// A route that reaches `node:sqlite` breaks at request time under `runtime =
// "edge"`, and the failure surfaces as a 500 rather than a build error. The
// SQLite-backed family is large and its routes are added gradually, so the
// invariant is asserted across `app/api` instead of per route.
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/[\\/]+$/, "");
// Only these trees are importable from a route, so the scan stays bounded and
// never walks `node_modules`, generated output, or the test suite itself.
const SOURCE_ROOTS = ["app", "lib", "components", "scripts"];
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".js", ".mjs", ".jsx"];
const SQLITE_MARKER = "node:sqlite";
// Matches static `import ... from "x"`, `export ... from "x"`, and `import("x")`.
const IMPORT_PATTERN = /(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*)["']([^"']+)["']/g;
const RUNTIME_DECLARATION = /export\s+const\s+runtime\s*(?::\s*[^=]+?)?=\s*["']([a-z]+)["']/;

const posix = (path) => path.split(/[\\/]/).join("/");
const isFile = (path) => stat(path).then((s) => s.isFile(), () => false);

async function sourceFiles(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await sourceFiles(full, out);
    else if (SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) out.push(full);
  }
  return out;
}

async function resolveImport(specifier, fromFile) {
  let base = null;
  if (specifier.startsWith("@/")) base = join(REPO_ROOT, specifier.slice(2));
  else if (specifier.startsWith(".")) base = resolve(dirname(fromFile), specifier);
  if (!base) return null;
  for (const candidate of [
    base,
    ...SOURCE_EXTENSIONS.map((ext) => base + ext),
    ...SOURCE_EXTENSIONS.map((ext) => join(base, "index" + ext)),
  ]) {
    if (await isFile(candidate)) return candidate;
  }
  return null;
}

// Every module that opens the SQLite driver, and every module that imports one.
async function sqliteImportGraph() {
  const files = [];
  for (const root of SOURCE_ROOTS) {
    const abs = join(REPO_ROOT, root);
    if (await exists(abs)) await sourceFiles(abs, files);
  }

  const sources = new Map();
  for (const file of files) sources.set(file, await readFile(file, "utf8"));

  const seeds = new Set();
  const deps = new Map();
  for (const [file, source] of sources) {
    if (source.includes(SQLITE_MARKER)) seeds.add(file);
    const imports = new Set();
    for (const match of source.matchAll(IMPORT_PATTERN)) {
      const resolved = await resolveImport(match[1], file);
      if (resolved) imports.add(resolved);
    }
    deps.set(file, imports);
  }
  return { sources, seeds, deps };
}

function reachesSqlite(file, seeds, deps, seen = new Set()) {
  if (seen.has(file)) return false;
  seen.add(file);
  if (seeds.has(file)) return true;
  for (const dep of deps.get(file) ?? []) {
    if (reachesSqlite(dep, seeds, deps, seen)) return true;
  }
  return false;
}

test("every SQLite-backed API route declares the nodejs runtime", async () => {
  const { sources, seeds, deps } = await sqliteImportGraph();

  const routes = [...sources.keys()]
    .map((file) => posix(file.slice(REPO_ROOT.length + 1)))
    .filter((file) => file.startsWith("app/api/") && /route\.(ts|tsx|mts|js|mjs)$/.test(file))
    .sort();

  // Guard the guard: a scan that resolves nothing would otherwise pass vacuously.
  for (const known of [
    "app/api/seasonal/progression/route.ts",
    "app/api/progression/route.ts",
    "app/api/progression/timeline/route.ts",
    "app/api/progression/average/route.ts",
    "app/api/player/profile/route.ts",
    "app/api/admin/bans/route.ts",
    "app/api/operator/seasonal/run/route.ts",
    "app/api/average/route.ts",
  ]) {
    assert.ok(routes.includes(known), `scan missed ${known}`);
  }

  const backed = routes.filter((route) => reachesSqlite(join(REPO_ROOT, route), seeds, deps));
  assert.ok(backed.length >= routes.length - 5, `only ${backed.length}/${routes.length} routes resolved`);

  const undeclared = backed.filter((route) => !RUNTIME_DECLARATION.test(sources.get(join(REPO_ROOT, route))));
  assert.deepEqual(undeclared, [], `SQLite-backed routes must set runtime = "nodejs": ${undeclared.join(", ")}`);

  // The declaration must pin nodejs, not merely exist.
  for (const route of backed) {
    const [, value] = RUNTIME_DECLARATION.exec(sources.get(join(REPO_ROOT, route)));
    assert.equal(value, "nodejs", `${route} declares runtime = "${value}"`);
  }
});

