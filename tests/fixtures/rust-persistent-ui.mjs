// Synthetic private databases initialized through the production TypeScript schema.
// Application HTML, assets and APIs are always real Rust/Next implementations.
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import { createPopulationFixture, syntheticPopulationRows, assertPopulationParity } from "./rust-population-data.mjs";
import { syntheticArenaRows } from "./rust-arena-seasonal-data.mjs";
import { rustCohortBinary } from "./rust-cohort-data.mjs";
import { startRustBackend } from "./rust-seasonal-http.mjs";
import { readBuiltAssets } from "./rust-arena-ui.mjs";

// Break only the PvE source used by the real failure/recovery interaction.
// Regular prefetches continue to query their independent players table.
export function persistentFixtureControl(fixture, value) {
  if (value.action === "break-primary") {
    fixture.db.exec("ALTER TABLE mode_players RENAME COLUMN kd_ratio TO fixture_missing_kd");
  } else if (value.action === "repair-primary") {
    fixture.db.exec("ALTER TABLE mode_players RENAME COLUMN fixture_missing_kd TO kd_ratio");
  } else if (value.action) throw new Error("Unknown private control action");
}

export const PERSISTENT_MODES = ["pve", "regular"];
export const PERSISTENT_ASSETS_ROOT = resolve(process.env.RUST_PERSISTENT_UI_ASSETS || "public/_rust/persistent");
export const persistentAssets = () => readBuiltAssets(PERSISTENT_ASSETS_ROOT);
export function progressionPayload(mode, count, now = Date.now()) {
  return { mode, cycleId: "persistent", axis: "pmc_raids", series: {
    cumulative: { kind: "cumulative", n: count, confidence: 0.84, freshnessAt: now,
      overall: Array.from({ length: 8 }, (_, i) => ({ pointId: `${mode}-point-${i}`, date: `2026-01-${String(i + 1).padStart(2, "0")}`,
        pmcRaids: i < 6 ? 10 + i * 10 : 1000000000 + i * 10, raidMin: i < 6 ? 10 + i * 10 : 1000000000 + i * 10, raidMax: i < 6 ? 19 + i * 10 : 1000000009 + i * 10, value: i < 6 ? (i + 1) ** 2 * 12000 : (i - 5) * 500000000000,
        n: count - i, seriesId: i < 5 ? 1 : 2 })) },
    tempo: { kind: "tempo", overall: [], n: 0, confidence: 0, freshnessAt: now },
  } };
}
export async function createPersistentUiFixture({ prefix = "rust-persistent-ui-", rows = 300, includeArena = false } = {}) {
  const population = await createPopulationFixture(prefix);
  let progression; let denyProxy; const sockets=new Set(); const blockedOutbound=[];
  try {
  const { createSqliteProgressionStore } = await import("../../lib/progression-db.ts");
  progression = new DatabaseSync(process.env.PROGRESSION_SQLITE_PATH);
  createSqliteProgressionStore(progression, "pve");
  const now = Date.now();
  for (const mode of PERSISTENT_MODES) population.seed(syntheticPopulationRows(rows, { mode, now }), mode, now);
  if (includeArena) {
    const {ARENA_PARSER_VERSION}=await import("../../lib/arena/storage.ts");
    const columns=["aid","arena_mode","hours","games_count","kd_ratio","win_rate","headshot_rate","kills_per_match","damage_per_match","upstream_version","parser_version","raw_json","fetched_at"];
    const insert=population.db.prepare(`INSERT INTO arena_mode_stats(${columns.join(",")})VALUES(${columns.map(()=>"?").join(",")})`);
    population.db.exec("BEGIN");try{for(const arenaMode of["overall","teamFight","lastHero","checkpoint","blastGang","shootOutDuo"])for(const row of syntheticArenaRows(rows,{arenaMode})){const complete={...row,upstream_version:1,parser_version:ARENA_PARSER_VERSION,raw_json:"{}",fetched_at:now};insert.run(...columns.map(key=>complete[key]));}population.db.exec("COMMIT");}catch(error){population.db.exec("ROLLBACK");throw error;}
  }
  const referenceDirectory = join(population.directory, "reference");
  mkdirSync(referenceDirectory);
  const metadata = Array.from({ length: 8 }, (_, i) => ({ id: `fixture-achievement-${i + 1}`,
    name: `Synthetic achievement ${i + 1}`, nameEn: `Synthetic achievement ${i + 1}`, nameRu: `Тестовое достижение ${i + 1}`,
    descriptionEn: `English synthetic description ${i + 1}`, descriptionRu: `Русское тестовое описание ${i + 1}`,
    imageUrl: i === 0 ? "https://assets.tarkov.dev/fixture-missing.webp" : null, side: "pmc", rarity: ["common", "rare", "seasonal", "legendary"][i % 4],
    playersCompletedPercent: i / 10, adjustedPlayersCompletedPercent: i / 5 }));
  writeFileSync(join(referenceDirectory, "achievements-regular.json"), JSON.stringify({ version: 2, mode: "regular", savedAt: now, entries: metadata }));
  // Exercise the real TS disk-cache parser under a rejecting fixture-only fetch.
  // An invalid fresh cache must fail before a native process can try its fallback.
  const previousFetch=globalThis.fetch,previousCache=process.env.ACHIEVEMENTS_CACHE_DIR;
  const setupAttempts=[];process.env.ACHIEVEMENTS_CACHE_DIR=referenceDirectory;
  globalThis.fetch=async(input)=>{setupAttempts.push(String(input));throw new Error("Private fixture cache validation forbids networking");};
  try {
    const {getAchievements}=await import("../../lib/tarkov-api.ts");const actual=await getAchievements("regular");
    assert.equal(actual.size,8);assert.equal(actual.get(metadata[0].id)?.nameRu,metadata[0].nameRu);assert.deepEqual(setupAttempts,[]);
  }finally{globalThis.fetch=previousFetch;if(previousCache===undefined)delete process.env.ACHIEVEMENTS_CACHE_DIR;else process.env.ACHIEVEMENTS_CACHE_DIR=previousCache;}
  denyProxy=createServer((request,response)=>{blockedOutbound.push(request.url);request.resume();response.writeHead(403);response.end();});
  denyProxy.maxConnections=16;
  denyProxy.on("connect",(request,socket)=>{blockedOutbound.push(request.url);socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");});
  denyProxy.on("connection",socket=>{sockets.add(socket);socket.once("close",()=>sockets.delete(socket));});
  await new Promise((done,reject)=>{denyProxy.once("error",reject);denyProxy.listen(0,"127.0.0.1",done);});
  const proxyUrl="http://127.0.0.1:"+denyProxy.address().port;
  const achievementRows = metadata.map((entry, i) => ({ ach_id: entry.id, owners: rows - i * 20,
    meanHours: 25.5 + i * 15, stdHours: i + 1, earlyHours: 5 + i, unlockHours: i === 0 ? 0 : 5 + i }));
  const configured = { NODE_ENV: "production", LOCAL_FAKE_AVERAGE: "0", AVERAGE_PUBLICATIONS_ENABLED: "false",
    SQLITE_PATH: process.env.SQLITE_PATH, PROGRESSION_SQLITE_PATH: process.env.PROGRESSION_SQLITE_PATH,
    BANS_SQLITE_PATH: process.env.BANS_SQLITE_PATH, REPORTS_SQLITE_PATH: process.env.REPORTS_SQLITE_PATH,
    AVERAGE_PUBLICATION_SQLITE_PATH: join(population.directory, "default-statistics.db"),
    ACHIEVEMENTS_CACHE_DIR: referenceDirectory, ADMIN_ANALYTICS_SQLITE_PATH: population.directory,
    RUST_PERSISTENT_UI_ASSETS: PERSISTENT_ASSETS_ROOT, RUST_COHORT_BIN: rustCohortBinary(),
    PVE_UI_UPSTREAM: "web:3001", REGULAR_UI_UPSTREAM: "web:3001", ARENA_UI_UPSTREAM: "web:3000",
    SEASONAL_API_UPSTREAM: "web:3000", HOME_SHOWCASE_API_UPSTREAM: "web:3000",
    HTTP_PROXY:proxyUrl,HTTPS_PROXY:proxyUrl,ALL_PROXY:proxyUrl,http_proxy:proxyUrl,https_proxy:proxyUrl,all_proxy:proxyUrl,
    NO_PROXY:"127.0.0.1,localhost,::1",no_proxy:"127.0.0.1,localhost,::1",
    TRUSTED_IP_HEADER: "x-real-ip", OBSERVABILITY_SAMPLE_RATE: "0", SEASONAL_ENABLED: "false" };
  const servers = [];
  let variant = 0; let cacheSerial = 0;
  let closed = false;
  function publishProgression(mode, generatedAt = now, generation = 1) {
    const body = progressionPayload(mode, rows, now);
    progression.prepare("INSERT OR REPLACE INTO progression_population_generations(mode,cycle_id,generation,generated_at,payload) VALUES(?,'persistent',?,?,?)")
      .run(mode, generation, generatedAt, JSON.stringify({ average: body }));
    progression.prepare("INSERT OR REPLACE INTO progression_population_current(mode,cycle_id,generation,generated_at) VALUES(?,'persistent',?,?)")
      .run(mode, generation, generatedAt);
    return body;
  }
  function publishAchievements(mode, values = achievementRows) {
    population.db.prepare("INSERT INTO achievement_baseline_publications(mode,generation,generated_at,total,achievements_json) VALUES(?,1,?,?,?) ON CONFLICT(mode)DO UPDATE SET generated_at=excluded.generated_at,total=excluded.total,achievements_json=excluded.achievements_json")
      .run(mode, now, rows, JSON.stringify(values));
  }
  for (const mode of PERSISTENT_MODES) { publishProgression(mode); publishAchievements(mode); }
  return { ...population, configured, rows, metadata, progression, referenceDirectory, publishProgression, publishAchievements,blockedOutbound,
    referenceAccess:{cache:"fresh v2 metadata validated through actual TypeScript parser",nativeGuard:"owned loopback deny-proxy via verified reqwest env support; not OS network isolation"},
    async start(env = {}) { assert.equal(closed, false); const server = await startRustBackend({ ...configured, AVERAGE_PUBLICATION_SQLITE_PATH: join(population.directory, `statistics-${cacheSerial++}.db`), ...env }); servers.push(server); return server; },
    cloneAssets(assets = persistentAssets()) {
      const path = join(population.directory, `assets-${variant++}`); mkdirSync(path);
      cpSync(join(assets.root, "manifest.json"), join(path, "manifest.json"));
      cpSync(join(assets.root, assets.manifest.hash), join(path, assets.manifest.hash), { recursive: true }); return path;
    },
    async closeAll() { if (closed) return; closed = true; for (const server of servers.toReversed()) await server.stop(); progression.close();for(const socket of sockets)socket.destroy();await new Promise(done=>denyProxy.close(done)); await population.close(); assert.equal(existsSync(population.directory), false);assert.deepEqual(blockedOutbound,[],"native metadata must consume the validated fresh reference cache without fallback attempts"); },
  };
  }catch(error){
    for(const socket of sockets)socket.destroy();if(denyProxy?.listening)await new Promise(done=>denyProxy.close(done));progression?.close();await population.close();throw error;
  }

}
export function assertPersistentPayload(body, label, query, rows = 300) {
  const mode = new URL(query, "http://local").searchParams.get("mode");
  assert.equal(body.mode, mode, `${label}: mode`); assert.equal(body.cycleId, "persistent");
  assert.equal(body.averages.n, rows, `${label}: actual private accounts`);
  assert.ok(body.buckets.length > 0); assert.ok(body.metricCounts.kd_ratio > 0);
}
export function assertPersistentParity(actual, expected, query) {
  assertPopulationParity({ body: actual }, { body: expected }, `real Rust/Next persistent startup: ${query}`);
}
