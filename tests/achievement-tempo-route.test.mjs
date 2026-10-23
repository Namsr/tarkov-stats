import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { initializeTempoExclusions, materializeTempo } from "../lib/achievement-tempo-store.ts";

registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {};" };
  if (specifier === "@/lib/auth/session") return { shortCircuit: true, url: "data:text/javascript,export async function getSession(){return globalThis.tempoTestSession ?? null;}" };
  if (specifier.startsWith("@/")) return { shortCircuit: true, url: pathToFileURL(resolve(specifier.slice(2) + ".ts")).href };
  return nextResolve(specifier, context);
} });
const { GET } = await import("../app/api/admin/achievement-tempo/route.ts");
const directory = mkdtempSync(join(tmpdir(), "achievement-tempo-route-"));
const sourcePath = join(directory, "progression.db"), outputPath = join(directory, "achievement-tempo.db");
process.env.PROGRESSION_SQLITE_PATH = sourcePath;
process.env.ACHIEVEMENT_TEMPO_SQLITE_PATH = outputPath;
process.env.ADMIN_GOOGLE_SUB = "tempo-admin";
process.env.SEASONAL_ENABLED = "false";
const request = (query = "") => GET(new Request("http://localhost/api/admin/achievement-tempo" + query));

test("admin route denies anonymous and non-admin users before opening storage", async () => {
  try {
    globalThis.tempoTestSession = null;
    assert.equal((await request()).status, 401);
    globalThis.tempoTestSession = { sub: "someone-else" };
    assert.equal((await request()).status, 403);
    assert.equal(existsSync(sourcePath), false);
    globalThis.tempoTestSession = { sub: "tempo-admin" };
    for (const query of ["?mode=pve", "?mode=arena", "?aid=NaN", "?aid=0", "?aid=1e3", "?aid=1%20OR%201=1", "?aid=", "?aid=9999999999999999"]) {
      assert.equal((await request(query)).status, 400, query);
    }
    assert.equal(existsSync(sourcePath), false);
    const seasonal = await request("?mode=seasonal");
    assert.equal((await seasonal.json()).reason, "season_unavailable");

    const source = new DatabaseSync(sourcePath), output = new DatabaseSync(outputPath);
    source.exec(`CREATE TABLE player_profiles(mode TEXT,cycle_id TEXT,aid INTEGER,confirmed_banned INTEGER);
      CREATE TABLE excluded_players(aid INTEGER PRIMARY KEY);
      CREATE TABLE progression_personal_revisions(mode TEXT,cycle_id TEXT,aid INTEGER,revision INTEGER);
      CREATE TABLE progression_snapshots(id INTEGER,mode TEXT,cycle_id TEXT,aid INTEGER,profile_updated_at INTEGER,stats_json TEXT,achievements TEXT);
      INSERT INTO player_profiles VALUES('regular','persistent',1,0);
      INSERT INTO progression_personal_revisions VALUES('regular','persistent',1,1);
      INSERT INTO progression_snapshots VALUES(1,'regular','persistent',1,100,'{}',NULL);`);
    initializeTempoExclusions(source);
    materializeTempo(source, output, { mode: "regular", cycleId: "persistent", startsAt: 0, endsAt: null });
    const versions = [source, output].map((db) => db.prepare("PRAGMA data_version").get().data_version);
    const reply = await request("?mode=regular&aid=1");
    assert.equal(reply.status, 200);
    assert.equal(reply.headers.get("cache-control"), "no-store");
    assert.equal(reply.headers.get("x-robots-tag"), "noindex");
    const body = await reply.json();
    assert.equal(body.available, true); assert.equal(body.affectsPublicRisk, false);
    assert.equal(body.evaluations.length, 9);
    assert.equal(body.evaluations[0].reason, "missing_dates");
    assert.equal("values" in body.cohorts[0], false, "never return the population account list");
    assert.deepEqual([source, output].map((db) => db.prepare("PRAGMA data_version").get().data_version), versions);
    source.exec("INSERT INTO excluded_players VALUES(1)");
    assert.equal((await (await request("?aid=1")).json()).reason, "exclusions_changed");
    output.close(); source.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
