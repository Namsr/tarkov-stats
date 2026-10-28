// Bounded, one-shot correctness probe for the unchanged production-image backend.
// Executed only inside its disposable Linux container by check-rust-cold-https-image.sh.
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";

const TTL = 6 * 60 * 60_000, LIMIT = 2 * 1024 * 1024;
class ProbeFailure extends Error { constructor(code) { super(code); this.code = code; } }
function requireCheck(condition, code) { if (!condition) throw new ProbeFailure(code); }
function validEntry(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (!["id", "name", "nameEn", "side"].every(key => typeof value[key] === "string") || !value.id) return false;
  if (!["nameRu", "descriptionEn", "descriptionRu", "imageUrl"].every(key => value[key] === null || typeof value[key] === "string")) return false;
  if (!["common", "rare", "legendary", "seasonal"].includes(value.rarity)) return false;
  if (!["playersCompletedPercent", "adjustedPlayersCompletedPercent"].every(key => Number.isFinite(value[key]) && value[key] >= 0 && value[key] <= 100)) return false;
  if (value.imageUrl !== null) { try { const url = new URL(value.imageUrl); if (url.protocol !== "https:" || url.hostname !== "assets.tarkov.dev") return false; } catch { return false; } }
  return true;
}

// Inputs are already parsed private artifacts; only the aggregate count is returned.
export function validateColdMetadata({ mode, file, fileBytes, saved, payloadBytes, start, end }) {
  requireCheck(mode === "regular" || mode === "seasonal", "invalid-mode");
  requireCheck(Number.isInteger(fileBytes) && fileBytes > 0 && fileBytes <= LIMIT, "reference-size");
  requireCheck(file?.version === 2 && file.mode === mode && Number.isFinite(file.savedAt) && file.savedAt >= start && file.savedAt <= end, "reference-header");
  requireCheck(Array.isArray(file.entries) && file.entries.length > 0 && file.entries.every(validEntry), "reference-entries");
  const key = mode === "regular" ? "achievement-metadata:regular" : "achievement-metadata:seasonal:cold-tls-cycle";
  requireCheck(saved?.key === key && Array.isArray(saved.value) && saved.value.length === file.entries.length, "durable-identity");
  requireCheck(saved.value.length > 0 && saved.value.every((pair, index) => Array.isArray(pair) && pair.length === 2 && typeof pair[0] === "string" && pair[0] === pair[1]?.id && validEntry(pair[1]) && isDeepStrictEqual(pair[1], file.entries[index])), "durable-entries");
  requireCheck(Number.isFinite(saved.generatedAt) && saved.generatedAt >= start && saved.generatedAt <= end && saved.expiresAt === saved.generatedAt + TTL, "durable-timestamps");
  requireCheck(Number.isInteger(payloadBytes) && payloadBytes > 0 && payloadBytes <= 1024 * 1024, "durable-size");
  return { count: file.entries.length, fileBytes, payloadBytes };
}
// The host runner also checks this before treating a container exit as success.
export function validateProbeReport(report, expected) {
  requireCheck(report?.outcome === "passed" && report.phase === "complete" && report.failure === null, "report-outcome");
  requireCheck(report.imageId === expected.imageId && report.sourceRevision === expected.sourceRevision && report.reviewedHead === expected.reviewedHead, "report-identity");
  requireCheck(/^[0-9a-f]{64}$/.test(report.backendSha256 || "") && /^[0-9a-f]{64}$/.test(report.caBundleSha256 || "") && Number.isInteger(report.caBundleBytes) && report.caBundleBytes > 0, "report-artifacts");
  for (const mode of ["regular", "seasonal"]) {
    const value = report.modes?.[mode];
    requireCheck(value?.status === 200 && value.stale === false && Number.isInteger(value.count) && value.count > 0 &&
      Number.isInteger(value.fileBytes) && value.fileBytes > 0 && value.fileBytes <= LIMIT && Number.isInteger(value.payloadBytes) && value.payloadBytes > 0 && value.payloadBytes <= 1024 * 1024, "report-mode");
  }
  requireCheck(report.health?.before === 200 && report.health?.after === 200, "report-health");
  requireCheck(report.cleanup?.backendStopped === true, "report-cleanup");
  return true;
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function main() {
  const evidence = { schemaVersion: 1, outcome: "failed", phase: "configuration", sourceRevision: process.env.PROBE_SOURCE_REVISION,
    reviewedHead: process.env.PROBE_HEAD_SHA, imageId: process.env.PROBE_IMAGE_ID, backendSha256: null, caBundleSha256: null,
    caBundleBytes: 0, health: { before: null, after: null }, modes: {}, cleanup: { backendStopped: false }, failure: null };
  let child, closed, backendEnded = false, output = "", exitState = null;
  const start = Date.now();
  try {
    requireCheck(process.platform === "linux" && process.env.PROBE_COLD_REFERENCE === "true", "configuration");
    for (const value of [evidence.sourceRevision, evidence.reviewedHead]) requireCheck(/^[0-9a-f]{40}$/.test(value || ""), "source-identity");
    requireCheck(/^sha256:[0-9a-f]{64}$/.test(evidence.imageId || ""), "image-identity");
    const binary = "/app/rust/backend/target/release/tarkov-backend", ca = "/etc/ssl/certs/ca-certificates.crt";
    evidence.phase = "provenance";
    requireCheck(statSync(binary).size > 0 && statSync(ca).size > 0, "missing-image-artifacts");
    evidence.caBundleBytes = statSync(ca).size;
    [evidence.backendSha256, evidence.caBundleSha256] = await Promise.all([sha256(binary), sha256(ca)]);
    evidence.phase = "fixture";
    const { DatabaseSync } = await import("node:sqlite");
    const root = "/data/cold-reference-probe", reference = `${root}/reference`, players = `${root}/players.db`, progression = `${root}/progression.db`, cache = `${root}/cache.db`;
    requireCheck(!existsSync(root), "fixture-not-cold");
    mkdirSync(root); mkdirSync(reference);
    requireCheck(!existsSync(`${reference}/achievements-regular.json`) && !existsSync(`${reference}/achievements-seasonal.json`), "reference-not-cold");
    const primary = new DatabaseSync(players);
    try {
      primary.exec(`CREATE TABLE achievement_baseline_publications(mode TEXT PRIMARY KEY CHECK(mode IN ('regular','pve')),generation INTEGER NOT NULL,generated_at INTEGER NOT NULL,total INTEGER NOT NULL,achievements_json TEXT NOT NULL)`);
      primary.prepare("INSERT INTO achievement_baseline_publications VALUES('regular',1,?,0,'[]')").run(start);
    } finally { primary.close(); }
    const progress = new DatabaseSync(progression);
    try {
      progress.exec(`CREATE TABLE progression_population_current(mode TEXT,cycle_id TEXT,generation INTEGER,generated_at INTEGER,PRIMARY KEY(mode,cycle_id));
        CREATE TABLE progression_population_generations(mode TEXT,cycle_id TEXT,generation INTEGER,generated_at INTEGER,payload TEXT,PRIMARY KEY(mode,cycle_id,generation))`);
      progress.prepare("INSERT INTO progression_population_current VALUES('seasonal','cold-tls-cycle',1,?)").run(start);
      progress.prepare("INSERT INTO progression_population_generations VALUES('seasonal','cold-tls-cycle',1,?,?)").run(start, JSON.stringify({ metrics: {}, riskBaselines: [], achievementBaseline: { eligibleN: 0, achievements: [] } }));
    } finally { progress.close(); }
    const durable = new DatabaseSync(cache);
    try { durable.exec("CREATE TABLE statistics_response_cache(cache_key TEXT PRIMARY KEY,payload_json TEXT NOT NULL,generated_at INTEGER NOT NULL,payload_bytes INTEGER NOT NULL)");
      requireCheck(durable.prepare("SELECT COUNT(*) AS n FROM statistics_response_cache").get().n === 0, "durable-not-cold");
    } finally { durable.close(); }
    evidence.phase = "startup";
    child = spawn(binary, [], { env: { ...process.env, NODE_ENV: "production", LOCAL_FAKE_AVERAGE: "0", AVERAGE_PUBLICATIONS_ENABLED: "false",
      RUST_API_BIND: "127.0.0.1:0", SQLITE_PATH: players, PROGRESSION_SQLITE_PATH: progression, AVERAGE_PUBLICATION_SQLITE_PATH: cache,
      ACHIEVEMENTS_CACHE_DIR: reference, ADMIN_ANALYTICS_SQLITE_PATH: root, SEASONAL_ENABLED: "true", SEASONAL_CYCLE_ID: "cold-tls-cycle",
      SEASONAL_STARTS_AT: "2020-01-01", SEASONAL_ENDS_AT: "", SEASONAL_COLLECTION_SOURCE: "operator", SEASONAL_UPSTREAM_CONTRACT: "direct_profile",
      SEASONAL_PROFILE_URL_TEMPLATE: "https://players.tarkov.dev/pvp-season/{aid}.json", OBSERVABILITY_SAMPLE_RATE: "0",
      SEASONAL_API_UPSTREAM: "web:3000", SEASONAL_POPULATION_UI_UPSTREAM: "web:3000", ARENA_UI_UPSTREAM: "web:3000", PVE_UI_UPSTREAM: "web:3000", REGULAR_UI_UPSTREAM: "web:3000", HOME_SHOWCASE_API_UPSTREAM: "web:3000" }, stdio: ["ignore", "pipe", "pipe"] });
    closed = new Promise(resolve => { child.once("error", () => { backendEnded = true; exitState = "spawn-error"; resolve(); }); child.once("close", (code, signal) => { backendEnded = true; exitState = code === 0 ? "exit-0" : signal || "nonzero"; resolve(); }); });
    for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { output = (output + chunk).slice(-65536); });
    const lines = createInterface({ input: child.stdout });
    const address = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new ProbeFailure("startup-timeout")), 10000);
      child.once("error", () => { clearTimeout(timer); reject(new ProbeFailure("backend-spawn")); });
      child.once("close", () => { clearTimeout(timer); reject(new ProbeFailure("backend-exited")); });
      lines.on("line", line => { try { const event = JSON.parse(line); if (event.event === "rust_api_ready") { clearTimeout(timer); resolve(event.address); } } catch { /* Other backend logs are not persisted. */ } });
    });
    lines.close(); requireCheck(/^127\.0\.0\.1:\d+$/.test(address), "invalid-bind");
    const base = `http://${address}`;
    const health = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(3000) });
    evidence.health.before = health.status; requireCheck(health.status === 200, "initial-health"); await health.body.cancel();
    for (const mode of ["regular", "seasonal"]) {
      evidence.phase = mode;
      const query = mode === "regular" ? "mode=regular" : "mode=seasonal&cycle=cold-tls-cycle";
      const response = await fetch(`${base}/api/average/achievements?${query}`, { signal: AbortSignal.timeout(20000) });
      evidence.modes[mode] = { status: response.status, stale: response.headers.get("x-statistics-stale") === "1" ? true : response.headers.get("x-statistics-stale") === "0" ? false : null };
      const body = await response.json();
      requireCheck(response.status === 200 && body.total === 0 && Array.isArray(body.achievements) && body.achievements.length === 0 && response.headers.get("x-statistics-stale") === "0", "response-not-fresh");
      const filename = `${reference}/achievements-${mode}.json`;
      requireCheck(existsSync(filename), "reference-missing");
      const fileBytes = statSync(filename).size; requireCheck(fileBytes > 0 && fileBytes <= LIMIT, "reference-size");
      const file = JSON.parse(readFileSync(filename, "utf8"));
      const reader = new DatabaseSync(cache, { readOnly: true }); let row;
      try {
        const key = mode === "regular" ? "achievement-metadata:regular" : "achievement-metadata:seasonal:cold-tls-cycle";
        row = reader.prepare("SELECT payload_json,payload_bytes FROM statistics_response_cache WHERE cache_key=?").get(`statistics-v1:${key}`);
      } finally { reader.close(); }
      requireCheck(row && typeof row.payload_json === "string" && row.payload_bytes === Buffer.byteLength(row.payload_json), "durable-missing");
      const saved = JSON.parse(row.payload_json);
      evidence.modes[mode] = { status: response.status, stale: false, ...validateColdMetadata({ mode, file, fileBytes, saved, payloadBytes: row.payload_bytes, start, end: Date.now() }) };
    }
    evidence.phase = "final-health";
    const finalHealth = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(3000) }); evidence.health.after = finalHealth.status; requireCheck(finalHealth.status === 200, "final-health"); await finalHealth.body.cancel();
    requireCheck(!/Tarkov achievement reference unavailable|Tarkov achievement file cache write unavailable/.test(output), "reference-failure-log");
    requireCheck(!backendEnded, "backend-exited");
    evidence.outcome = "passed"; evidence.phase = "complete";
  } catch (error) { evidence.failure = error instanceof ProbeFailure ? error.code : "unexpected-error"; }
  finally {
    if (child && !backendEnded) {
      child.kill("SIGTERM");
      await Promise.race([closed, sleep(3000)]);
      if (!backendEnded) { child.kill("SIGKILL"); await Promise.race([closed, sleep(3000)]); }
    }
    evidence.cleanup.backendStopped = !child || backendEnded;
    evidence.cleanup.backendExit = exitState;
    if (!evidence.cleanup.backendStopped) { evidence.outcome = "failed"; evidence.failure ||= "backend-cleanup"; }
    if (evidence.outcome !== "passed") process.exitCode = 1;
    console.log(JSON.stringify(evidence));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
