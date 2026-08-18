import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  AUDIT_LEASE_MS,
  compareAuditRecords,
  createDataAuditStore,
} from "../lib/admin/data-audit.ts";

test("manual admin data audit is guarded, explicit, JSON-only, and durable", async () => {
  const [route, audit, dashboard, dictionary] = await Promise.all([
    readFile("app/api/admin/data-audit/route.ts", "utf8"),
    readFile("lib/admin/data-audit.ts", "utf8"),
    readFile("components/AdminDashboard.tsx", "utf8"),
    readFile("lib/i18n/dictionary.ts", "utf8"),
  ]);
  assert.match(route, /requireAdmin/);
  assert.match(route, /rejectInvalidAdminMutation/);
  assert.match(audit, /fetchTarkovJson/);
  assert.doesNotMatch(audit, /api\.tarkov\.dev\/graphql|\bgraphql\b/i);
  assert.match(audit, /admin_data_audit_state/);
  assert.match(audit, /BEGIN IMMEDIATE/);
  assert.match(audit, /status === "running"/);
  assert.doesNotMatch(audit, /(?:regular|seasonal)_profile_sync_meta|last_poll_at/);
  assert.match(audit, /fetched_at/);
  assert.match(audit, /synced_at/);
  for (const mode of ["profile", "pve", "arena", "pvp-season"]) {
    assert.match(audit, new RegExp(`players\\.tarkov\\.dev\\/${mode}\\/(?:index|updated)\\.json`));
  }
  assert.match(dashboard, /\/api\/admin\/data-audit/);
  assert.match(dashboard, /method: "POST"/);
  assert.match(dashboard, /"admin\.audit\.button"/);
  assert.match(dictionary, /"admin\.audit\.button": "Сверить данные"/);
  assert.match(dictionary, /"admin\.audit\.button": "Compare data"/);
  assert.match(dictionary, /"admin\.audit\.localLegend"/);
});

test("audit source keeps unavailable history distinct from zero", async () => {
  const source = await readFile("lib/admin/data-audit.ts", "utf8");
  assert.match(source, /upstreamRecordCount: null/);
  assert.match(source, /localMatchingCount: null/);
  assert.match(source, /lastReceivedAt/);
  assert.match(source, /lastLocalApplyAt/);
  assert.match(source, /latestUpstreamUpdatedAt/);
  assert.match(source, /status: "unavailable"/);
});

test("audit comparison distinguishes missing, stale, current, and unavailable records", () => {
  const index = compareAuditRecords(
    "regular",
    "index",
    new Map([[1, "Alpha"], [2, "Bravo"], [3, "Charlie"], [4, "Delta"]]),
    {
      available: true,
      rows: [
        { aid: 1, nickname: " alpha " },
        { aid: 2, nickname: "Old Bravo" },
        { aid: 5, nickname: "Extra" },
      ],
      lastLocalApplyAt: 80,
    },
    100,
    110,
  );
  assert.equal(index.status, "ok");
  assert.deepEqual(
    {
      upstream: index.upstreamRecordCount,
      matching: index.localMatchingCount,
      current: index.localCurrentCount,
      missing: index.missingCount,
      stale: index.staleCount,
      coverage: index.coveragePercent,
    },
    { upstream: 4, matching: 2, current: 1, missing: 2, stale: 1, coverage: 25 },
  );
  assert.equal(index.lastCheckedAt, 100);
  assert.equal(index.lastReceivedAt, 110);
  assert.equal(index.lastLocalApplyAt, 80);

  const updated = compareAuditRecords(
    "pve",
    "updated",
    new Map([
      [1, 1_700_000_000_000],
      [2, 1_700_000_001_000],
      [3, 1_700_002_000_000],
      [4, 1_700_003_000_000],
    ]),
    {
      available: true,
      rows: [
        { aid: 1, updatedAt: 1_700_000_000_000 },
        { aid: 2, updatedAt: 1_700_000_000_999 },
        { aid: 4, updatedAt: 1_700_003_000_001 },
        { aid: 5, updatedAt: 1_700_004_000_000 },
      ],
      lastLocalApplyAt: 90,
    },
    200,
    210,
  );
  assert.deepEqual(
    {
      matching: updated.localMatchingCount,
      current: updated.localCurrentCount,
      missing: updated.missingCount,
      stale: updated.staleCount,
      coverage: updated.coveragePercent,
      latest: updated.latestUpstreamUpdatedAt,
    },
    {
      matching: 3,
      current: 2,
      missing: 1,
      stale: 1,
      coverage: 50,
      latest: 1_700_003_000_000,
    },
  );

  const unavailable = compareAuditRecords(
    "arena",
    "updated",
    new Map([[42, 1_700_000_000_000]]),
    { available: false, rows: [], lastLocalApplyAt: null, error: "missing_db" },
    300,
    310,
  );
  assert.equal(unavailable.status, "unavailable");
  assert.equal(unavailable.upstreamRecordCount, 1);
  assert.equal(unavailable.localMatchingCount, null);
  assert.equal(unavailable.localCurrentCount, null);
  assert.equal(unavailable.missingCount, null);
  assert.equal(unavailable.staleCount, null);
  assert.equal(unavailable.coveragePercent, null);
  assert.equal(unavailable.error, "missing_db");

  const empty = compareAuditRecords(
    "arena",
    "updated",
    new Map(),
    { available: true, rows: [], lastLocalApplyAt: null },
    400,
    410,
  );
  assert.equal(empty.status, "ok");
  assert.equal(empty.upstreamRecordCount, 0);
  assert.equal(empty.localMatchingCount, 0);
  assert.equal(empty.localCurrentCount, 0);
  assert.equal(empty.missingCount, 0);
  assert.equal(empty.staleCount, 0);
  assert.equal(empty.coveragePercent, 100);
});

test("audit latest updated timestamp handles large datasets without argument spread", () => {
  const upstream = new Map();
  for (let aid = 1; aid <= 150_000; aid += 1) {
    upstream.set(aid, 1_700_000_000_000 + aid);
  }
  const result = compareAuditRecords(
    "regular",
    "updated",
    upstream,
    { available: true, rows: [], lastLocalApplyAt: null },
    500,
    510,
  );
  assert.equal(result.upstreamRecordCount, 150_000);
  assert.equal(result.latestUpstreamUpdatedAt, 1_700_000_150_000);
  assert.equal(result.missingCount, 150_000);
  assert.equal(result.coveragePercent, 0);
});

test("audit store rejects active lease, exposes expired lease as idle, and allows reclaim", () => {
  const db = new DatabaseSync(":memory:");
  const store = createDataAuditStore(db);
  const startedAt = 2_000_000_000;
  assert.deepEqual(store.start("run-1", startedAt), { started: true });

  const priorSnapshot = {
    version: 1,
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
