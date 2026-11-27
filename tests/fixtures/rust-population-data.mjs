import assert from "node:assert/strict";
import { existsSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname } from "node:path";
import { createCohortFixture, DAY_MS } from "./rust-cohort-data.mjs";
const { AVG_COLS, getArenaBackend } = await import("../../lib/db.ts");
export const POPULATION_COLUMNS = AVG_COLS;
export async function createPopulationFixture(prefix = "rust-population-") {
  const base = await createCohortFixture(prefix);
  const inserts = new Map();
  for (const mode of ["regular", "pve", "arena"]) {
    const columns = ["aid", "nickname", ...AVG_COLS, "profile_updated_at", "last_played_at", "pvp_stats_known", "pvp_stats_version", "fetched_at"];
    if (mode !== "regular") columns.push("mode", "stats_json");
    inserts.set(mode, { columns, statement: base.db.prepare(`INSERT INTO ${mode === "regular" ? "players" : "mode_players"} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`) });
  }
  return { directory: base.directory, db: base.db,
    clear() { base.db.exec("DELETE FROM players; DELETE FROM mode_players; DELETE FROM excluded_players"); },
    seed(rows, mode = "pve", now = Date.now()) {
      assert.ok(inserts.has(mode)); const { columns, statement } = inserts.get(mode);
      base.db.exec("BEGIN");
      try {
        for (const row of rows) {
          const complete = { ...Object.fromEntries(AVG_COLS.map((key) => [key, 0])), nickname: "synthetic-population", mode, stats_json: "{}",
            profile_updated_at: now - DAY_MS, last_played_at: null, pvp_stats_known: 1, pvp_stats_version: 1, fetched_at: now, ...row };
          statement.run(...columns.map((key) => complete[key]));
        }
        base.db.exec("COMMIT");
      } catch (error) { base.db.exec("ROLLBACK"); throw error; }
    },
    async close() {
      base.db.close(); (await getArenaBackend())?.db.close();
      if (existsSync(base.directory)) {
        const path = realpathSync(base.directory);
        assert.equal(dirname(path).toLowerCase(), realpathSync(tmpdir()).toLowerCase());
        assert.ok(basename(path).startsWith(prefix)); rmSync(path, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
      }
    },
  };
}
export function* syntheticPopulationRows(count, { mode = "pve", now = Date.now() } = {}) {
  for (let aid = 1; aid <= count; aid++) {
    const scale = mode === "regular" ? 3 : mode === "arena" ? 100 : 1;
    const row = Object.fromEntries(AVG_COLS.map((key, i) => [key, ((aid * (i + 3)) % 47) * scale + (aid % 7) / 10]));
    yield { ...row, aid, hours: (aid * 137) % 12000 + aid % 3 / 10, pmc_raids: (aid * 53) % 3500,
      kd_ratio: aid % 11 === 0 ? null : row.kd_ratio, killed_pmc: aid % 13 === 0 ? null : row.killed_pmc,
      survival_rate: aid % 7 === 0 ? 0 : row.survival_rate,
      pvp_stats_known: aid % 3 === 0 ? 0 : 1, pvp_stats_version: aid % 4 === 0 ? 0 : 1,
      profile_updated_at: now - (aid % 5 === 0 ? 100 : 10) * DAY_MS, last_played_at: now };
  }
}
export function assertPopulationParity(actual, expected, context = "persistent population") {
  const normalized = structuredClone(actual);
  function compare(got, want, path) {
    if (typeof want === "number") {
      assert.equal(typeof got, "number", `${context}: ${path}`);
      const calculated = (path.startsWith("result.body.averages.") && !path.endsWith(".n")) || path.endsWith(".sum") || path.endsWith(".avg");
      if (!calculated) assert.equal(got, want, `${context}: ${path}`);
      else assert.ok(Number.isFinite(got) && Math.abs(got - want) <= 1e-12 * Math.max(1, Math.abs(want)), `${context}: ${path}: ${got} != ${want}`);
      return want;
    }
    if (want && typeof want === "object") {
      assert.ok(got && typeof got === "object", `${context}: ${path}`);
      assert.deepEqual(Object.keys(got).sort(), Object.keys(want).sort(), `${context}: ${path} fields`);
      for (const [key, value] of Object.entries(want)) got[key] = compare(got[key], value, `${path}.${key}`);
    }
    return got;
  }
  assert.deepEqual(compare(normalized, expected, "result"), expected, context);
}
