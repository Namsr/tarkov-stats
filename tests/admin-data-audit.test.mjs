import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUDIT_LEASE_MS,
  compareAuditCounts,
  createDataAuditStore,
  runDataAudit,
} from "../lib/admin/data-audit.ts";

test("manual admin data audit is guarded, explicit, durable, and does not redownload feeds", async () => {
  const [route, audit, dashboard, dictionary] = await Promise.all([
    readFile("app/api/admin/data-audit/route.ts", "utf8"),
    readFile("lib/admin/data-audit.ts", "utf8"),
    readFile("components/AdminDashboard.tsx", "utf8"),
    readFile("lib/i18n/dictionary.ts", "utf8"),
  ]);
  assert.match(route, /requireAdmin/);
  assert.match(route, /rejectInvalidAdminMutation/);
  assert.doesNotMatch(audit, /fetchTarkovJson|players\.tarkov\.dev|\.json\(\)/);
  assert.match(audit, /source_rows/);
  assert.match(audit, /row_count/);
  assert.match(audit, /last_summary/);
  assert.match(audit, /sourceEntries/);
  assert.match(audit, /SELECT COUNT\(\*\) AS count/);
  assert.match(audit, /admin_data_audit_state/);
  assert.match(audit, /BEGIN IMMEDIATE/);
  assert.match(audit, /status === "running"/);
  assert.match(dashboard, /\/api\/admin\/data-audit/);
  assert.match(dashboard, /method: "POST"/);
  assert.match(dashboard, /"admin\.audit\.button"/);
  assert.match(dashboard, /differenceCount/);
  assert.match(dictionary, /"admin\.audit\.button": "Сверить данные"/);
  assert.match(dictionary, /"admin\.audit\.button": "Compare data"/);
  assert.match(dictionary, /Файлы источника повторно не скачиваются/);
  assert.match(dictionary, /The upstream files are not downloaded again/);
});

test("audit comparison reports equal, missing, extra, empty, and unavailable counts", () => {
  const equal = compareAuditCounts("regular", "index", 100, 100, 1_000, {
    lastReceivedAt: 900,
    lastLocalApplyAt: 950,
  });
  assert.deepEqual(
    {
      status: equal.status,
      source: equal.upstreamRecordCount,
      local: equal.localRecordCount,
      difference: equal.differenceCount,
      coverage: equal.coveragePercent,
      received: equal.lastReceivedAt,
      applied: equal.lastLocalApplyAt,
    },
    { status: "ok", source: 100, local: 100, difference: 0, coverage: 100, received: 900, applied: 950 },
  );

  const missing = compareAuditCounts("pve", "updated", 100, 75, 2_000);
  assert.equal(missing.differenceCount, -25);
  assert.equal(missing.coveragePercent, 75);

  const extra = compareAuditCounts("arena", "index", 80, 100, 3_000);
  assert.equal(extra.differenceCount, 20);
  assert.equal(extra.coveragePercent, 125);

  const empty = compareAuditCounts("pvp-season", "updated", 0, 0, 4_000);
  assert.equal(empty.differenceCount, 0);
  assert.equal(empty.coveragePercent, 100);

  const unavailable = compareAuditCounts("regular", "updated", null, 10, 5_000);
  assert.equal(unavailable.status, "unavailable");
  assert.equal(unavailable.upstreamRecordCount, null);
  assert.equal(unavailable.localRecordCount, 10);
  assert.equal(unavailable.differenceCount, null);
  assert.equal(unavailable.coveragePercent, null);
  assert.equal(unavailable.error, "sync_metadata_unavailable");
});

test("audit reads all eight counts from synchronization metadata without upstream requests", async () => {
  const directory = await mkdtemp(join(tmpdir(), "admin-data-audit-"));
  const playersPath = join(directory, "players.db");
  const progressionPath = join(directory, "progression.db");
  const previousPlayersPath = process.env.SQLITE_PATH;
  const previousProgressionPath = process.env.PROGRESSION_SQLITE_PATH;
  const players = new DatabaseSync(playersPath);
  const progression = new DatabaseSync(progressionPath);
  try {
    players.exec(`
      CREATE TABLE player_index (aid INTEGER PRIMARY KEY, nickname TEXT);
      CREATE TABLE player_index_meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE pve_player_index (mode TEXT, aid INTEGER PRIMARY KEY);
      CREATE TABLE pve_player_index_meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE arena_player_index (mode TEXT, aid INTEGER PRIMARY KEY);
      CREATE TABLE arena_player_index_meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE players (aid INTEGER PRIMARY KEY, fetched_at INTEGER);
      CREATE TABLE mode_players (mode TEXT, aid INTEGER, fetched_at INTEGER, PRIMARY KEY (mode, aid));
      CREATE TABLE regular_profile_sync_meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE pve_profile_sync_meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE arena_profile_sync_meta (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO player_index VALUES (1, 'Alpha'), (2, 'Bravo');
      INSERT INTO pve_player_index VALUES ('pve', 1);
      INSERT INTO arena_player_index VALUES ('arena', 1), ('arena', 2), ('arena', 3);
      INSERT INTO players VALUES (1, 101), (2, 102);
      INSERT INTO mode_players VALUES ('pve', 1, 201), ('arena', 1, 301), ('arena', 2, 302);
    `);
    for (const [table, count] of [
      ["player_index_meta", 2],
      ["pve_player_index_meta", 2],
      ["arena_player_index_meta", 2],
    ]) {
      players.prepare(`INSERT INTO ${table} (key, value) VALUES ('source_rows', ?), ('synced_at', '1000'), ('last_poll_at', '1100')`)
        .run(String(count));
    }
    for (const [table, count] of [
      ["regular_profile_sync_meta", 2],
      ["pve_profile_sync_meta", 3],
      ["arena_profile_sync_meta", 2],
    ]) {
      players.prepare(`INSERT INTO ${table} (key, value) VALUES ('last_summary', ?), ('last_poll_at', '1200'), ('last_feed_max_updated_at', '1300')`)
        .run(JSON.stringify({ sourceEntries: count }));
    }

    progression.exec(`
      CREATE TABLE season_cycles (cycle_id TEXT PRIMARY KEY, enabled INTEGER, starts_at INTEGER);
      CREATE TABLE seasonal_player_index (cycle_id TEXT, aid INTEGER, PRIMARY KEY (cycle_id, aid));
      CREATE TABLE seasonal_player_index_meta (cycle_id TEXT, key TEXT, value TEXT, PRIMARY KEY (cycle_id, key));
      CREATE TABLE player_profiles (mode TEXT, cycle_id TEXT, aid INTEGER, last_access_at INTEGER, PRIMARY KEY (mode, cycle_id, aid));
      CREATE TABLE seasonal_profile_sync_meta (cycle_id TEXT, key TEXT, value TEXT, PRIMARY KEY (cycle_id, key));
      INSERT INTO season_cycles VALUES ('current', 1, 1);
      INSERT INTO seasonal_player_index VALUES ('current', 1), ('current', 2);
      INSERT INTO seasonal_player_index_meta VALUES
        ('current', 'source_rows', '3'), ('current', 'synced_at', '1400'), ('current', 'last_poll_at', '1500');
      INSERT INTO player_profiles VALUES ('seasonal', 'current', 1, 401);
      INSERT INTO seasonal_profile_sync_meta VALUES
        ('current', 'last_summary', '${JSON.stringify({ sourceEntries: 2 })}'),
        ('current', 'last_poll_at', '1600'), ('current', 'last_feed_max_updated_at', '1700');
    `);
    players.close();
    progression.close();
    process.env.SQLITE_PATH = playersPath;
    process.env.PROGRESSION_SQLITE_PATH = progressionPath;

    const storeDb = new DatabaseSync(":memory:");
    const result = await runDataAudit({ store: createDataAuditStore(storeDb), now: () => 2_000 });
    assert.equal(result.started, true);
    assert.equal(result.state.snapshot?.datasets.length, 8);
    assert.equal(result.state.snapshot?.status, "success");
    assert.deepEqual(
      result.state.snapshot?.datasets.map((row) => [row.mode, row.dataset, row.upstreamRecordCount, row.localRecordCount, row.differenceCount]),
      [
        ["regular", "index", 2, 2, 0],
        ["regular", "updated", 2, 2, 0],
        ["pve", "index", 2, 1, -1],
        ["pve", "updated", 3, 1, -2],
        ["arena", "index", 2, 3, 1],
        ["arena", "updated", 2, 2, 0],
        ["pvp-season", "index", 3, 2, -1],
        ["pvp-season", "updated", 2, 1, -1],
      ],
    );
    storeDb.close();
  } finally {
    try { players.close(); } catch {}
    try { progression.close(); } catch {}
    if (previousPlayersPath === undefined) delete process.env.SQLITE_PATH;
    else process.env.SQLITE_PATH = previousPlayersPath;
    if (previousProgressionPath === undefined) delete process.env.PROGRESSION_SQLITE_PATH;
    else process.env.PROGRESSION_SQLITE_PATH = previousProgressionPath;
    await rm(directory, { recursive: true, force: true });
  }
});

test("audit store rejects active lease, exposes expired lease as idle, and allows reclaim", () => {
  const db = new DatabaseSync(":memory:");
  const store = createDataAuditStore(db);
  const startedAt = 2_000_000_000;
  assert.deepEqual(store.start("run-1", startedAt), { started: true });

  const priorSnapshot = {
    version: 2,
    runId: "prior-run",
    status: "partial",
    startedAt: startedAt - 100,
    finishedAt: startedAt - 50,
    datasets: [],
  };
  db.prepare("UPDATE admin_data_audit_state SET result_json = ?, error = ? WHERE id = 1")
    .run(JSON.stringify(priorSnapshot), "prior_error");

  const conflict = store.start("run-2", startedAt + 1_000);
  assert.equal(conflict.started, false);
  assert.equal(conflict.state.running, true);
  assert.equal(conflict.state.runId, "run-1");
  assert.equal(conflict.state.snapshot?.runId, "prior-run");

  const expiredAt = startedAt + AUDIT_LEASE_MS + 1;
  const expired = store.read(expiredAt);
  assert.equal(expired.running, false);
  assert.equal(expired.runId, null);
  assert.equal(expired.error, "prior_error");
  assert.equal(expired.snapshot?.runId, "prior-run");

  assert.deepEqual(store.start("run-2", expiredAt), { started: true });
  assert.equal(store.read(expiredAt).running, true);
  db.close();
});
