import assert from "node:assert/strict";
import { existsSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname } from "node:path";
import { createArenaSeasonalFixture, SEASONAL_TEST_CYCLE } from "./rust-arena-seasonal-data.mjs";
import { DAY_MS } from "./rust-cohort-data.mjs";
export { SEASONAL_TEST_CYCLE };
export async function createSeasonalPopulationFixture(prefix = "rust-seasonal-population-") {
  const base = await createArenaSeasonalFixture(prefix);
  const columns = ["mode", "cycle_id", "aid", "profile_updated_at", "upstream_updated_at", "captured_at", "local_date", "hours", "experience", "total_raids", "pmc_raids", "scav_raids", "survived", "pmc_survived", "deaths", "pmc_deaths", "pmc_kills", "total_kills", "killed_pmc", "run_through", "level", "prestige", "longest_win_streak", "achv_count", "achievements"];
  const insert = base.seasonalDb.prepare(`INSERT INTO progression_snapshots(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`);
  function snapshots(rows, now = Date.now()) {
    base.seasonalDb.exec("BEGIN");
    try { for (const row of rows) {
      const complete = { mode: "seasonal", cycle_id: SEASONAL_TEST_CYCLE, profile_updated_at: now - DAY_MS, upstream_updated_at: now - DAY_MS, captured_at: now, local_date: "2026-01-01", hours: 99999, experience: 1000, total_raids: 120, pmc_raids: 100, scav_raids: 20, survived: 60, pmc_survived: 50, deaths: 60, pmc_deaths: 50, pmc_kills: 100, total_kills: 240, killed_pmc: 40, run_through: 0, level: 25, prestige: 0, longest_win_streak: 4, achv_count: null, achievements: "[]", ...row };
      insert.run(...columns.map(key => complete[key]));
    } base.seasonalDb.exec("COMMIT"); }
    catch (error) { base.seasonalDb.exec("ROLLBACK"); throw error; }
  }
  return { ...base,
    clear() { base.seasonalDb.exec("DELETE FROM progression_snapshots; DELETE FROM player_profiles; DELETE FROM excluded_players; DELETE FROM season_cycles"); },
    snapshots,
    seed(rows, now = Date.now()) { const values = Array.from(rows); base.seedSeasonal(values, now); snapshots(values.map(row => ({ ...row, ...row.snapshot })), now); },
    async cleanup() {
      base.close(); const { getArenaBackend } = await import("../../lib/db.ts"); (await getArenaBackend())?.db.close();
      const path = realpathSync(base.directory); assert.equal(dirname(path).toLowerCase(), realpathSync(tmpdir()).toLowerCase()); assert.ok(basename(path).startsWith(prefix));
      if (existsSync(path)) rmSync(path, { recursive: true, force: true, maxRetries: 40, retryDelay: 25 });
    },
  };
}
export function* seasonalPopulationRows(count, now = Date.now()) {
  for (let aid = 1; aid <= count; aid++) yield { aid, lifetime_pvp_hours: (aid * 137) % 12000 + aid % 10 / 10, profile_updated_at: now - (aid % 5 === 0 ? 100 : 10) * DAY_MS,
    snapshot: { profile_updated_at: now - DAY_MS, total_raids: 100 + aid, pmc_raids: 50 + aid, scav_raids: 50, survived: aid % 11 === 0 ? 0 : 40, deaths: aid % 13 === 0 ? null : aid % 17, total_kills: aid % 7 === 0 ? null : aid * 3, killed_pmc: aid % 19, pmc_deaths: aid % 7, pmc_survived: aid % 30, level: 1 + aid % 79, prestige: aid % 3, run_through: aid % 2, longest_win_streak: aid % 9, achievements: aid % 5 === 0 ? "invalid" : '["a","b"]', achv_count: aid % 3 === 0 ? 0 : null } };
}
export function assertSeasonalPopulationParity(actual, expected, label = "Seasonal population") {
  function check(got, wanted, path) {
    if (typeof wanted === "number") {
      assert.equal(typeof got, "number", `${label} ${path}`);
      if ((path.includes(".averages.") && !path.endsWith(".n")) || path.endsWith(".sum")) assert.ok(Number.isFinite(got) && Math.abs(got - wanted) <= 1e-12 * Math.max(1, Math.abs(wanted)), `${label} ${path}: ${got} != ${wanted}`);
      else assert.equal(got, wanted, `${label} ${path}`);
    } else if (wanted && typeof wanted === "object") {
      assert.ok(got && typeof got === "object", `${label} ${path}`); assert.equal(Array.isArray(got), Array.isArray(wanted));
      assert.deepEqual(Object.keys(got).sort(), Object.keys(wanted).sort()); for (const [key, value] of Object.entries(wanted)) check(got[key], value, `${path}.${key}`);
    } else assert.equal(got, wanted, `${label} ${path}`);
  }
  check(actual, expected, "result");
}
