/* eslint-disable @typescript-eslint/ban-ts-comment */
import assert from "node:assert/strict";
import test from "node:test";
// @ts-ignore -- Node 24 exposes node:sqlite at runtime; project types target Node 20.
import { DatabaseSync } from "node:sqlite";
import {
  COMMUNITY_REPORTS_SCHEMA,
  createD1CommunityReportsStore,
  createSqliteCommunityReportsStore,
  type CommunityReportsStore,
// @ts-ignore -- Node's strip-types runner resolves the explicit .ts module.
} from "../lib/community-reports-db.ts";

function d1Style(db: DatabaseSync) {
  return {
    prepare(sql: string) {
      let args: unknown[] = [];
      return {
        bind(...next: unknown[]) { args = next; return this; },
        async first(column?: string) {
          const row = db.prepare(sql).get(...args) as Record<string, unknown> | undefined;
          return column ? row?.[column] ?? null : row ?? null;
        },
        async all() { return { results: db.prepare(sql).all(...args) }; },
        async run() {
          const result = db.prepare(sql).run(...args);
          return { meta: { changes: Number(result.changes) } };
        },
      };
    },
  };
}

const storeFactories: [string, () => CommunityReportsStore][] = [
  ["SQLite", () => createSqliteCommunityReportsStore(new DatabaseSync(":memory:"))],
  ["D1-style", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(COMMUNITY_REPORTS_SCHEMA);
    return createD1CommunityReportsStore(d1Style(db));
  }],
];

for (const [name, makeStore] of storeFactories) {
  test(`${name}: reports are globally unique, idempotent, and keep ranking history`, async () => {
    const store = makeStore();
    assert.deepEqual(await store.report({ userSub: "google-a", aid: 7, mode: "regular", cycleId: "persistent", createdAt: 10 }), { already: false, count: 1 });
    assert.deepEqual(await store.report({ userSub: "google-a", aid: 7, mode: "seasonal", cycleId: "wipe", createdAt: 11 }), { already: true, count: 1 });
    await Promise.all([
      store.report({ userSub: "google-b", aid: 7, mode: "pve", cycleId: "persistent", createdAt: 12 }),
      store.report({ userSub: "google-c", aid: 8, mode: "arena", cycleId: "persistent", createdAt: 13 }),
    ]);
    assert.equal(await store.count(7), 2);
    assert.equal(await store.reportedBy("google-a", 7), true);
    assert.deepEqual((await store.candidates("helper-a", 3)).map(({ aid, reportCount, lastReportedAt }) => ({ aid, reportCount, lastReportedAt })), [
      { aid: 7, reportCount: 2, lastReportedAt: 12 }, { aid: 8, reportCount: 1, lastReportedAt: 13 },
    ]);
  });

  test(`${name}: votes are idempotent and exclude a helper's prior candidates`, async () => {
    const store = makeStore();
    await store.report({ userSub: "google-a", aid: 70, mode: "regular", cycleId: "persistent", createdAt: 1 });
    await store.report({ userSub: "google-b", aid: 80, mode: "regular", cycleId: "persistent", createdAt: 2 });
    assert.deepEqual(await store.vote({ helperId: "helper-a", aid: 70, verdict: "yes", createdAt: 3 }), { already: false, missing: false });
    assert.deepEqual(await store.vote({ helperId: "helper-a", aid: 70, verdict: "no", createdAt: 4 }), { already: true, missing: false });
    assert.deepEqual((await store.candidates("helper-a", 3)).map((candidate) => candidate.aid), [80]);
    assert.deepEqual(await store.vote({ helperId: "helper-b", aid: 999, verdict: "yes" }), { already: false, missing: true });
    assert.deepEqual(await store.reviews(70), [{
      aid: 70, mode: "regular", modes: ["regular"], cycleId: "persistent", seasonalCycleId: null, reportCount: 1, lastReportedAt: 1, yesCount: 1, noCount: 0,
    }]);
  });

  test(`${name}: equal timestamps choose the same latest source`, async () => {
    const store = makeStore();
    await store.report({ userSub: "google-a", aid: 9, mode: "regular", cycleId: "persistent", createdAt: 10 });
    await store.report({ userSub: "google-z", aid: 9, mode: "arena", cycleId: "persistent", createdAt: 10 });
    assert.deepEqual(await store.reviews(9), [{
      aid: 9, mode: "arena", modes: ["arena", "regular"], cycleId: "persistent", seasonalCycleId: null, reportCount: 2, lastReportedAt: 10, yesCount: 0, noCount: 0,
    }]);
  });

  test(`${name}: modes are sorted deterministically regardless of insert order`, async () => {
    const store = makeStore();
    await store.report({ userSub: "google-a", aid: 11, mode: "arena", cycleId: "persistent", createdAt: 10 });
    await store.report({ userSub: "google-b", aid: 11, mode: "regular", cycleId: "persistent", createdAt: 11 });
    await store.report({ userSub: "google-c", aid: 12, mode: "regular", cycleId: "persistent", createdAt: 10 });
    await store.report({ userSub: "google-d", aid: 12, mode: "arena", cycleId: "persistent", createdAt: 11 });
    assert.deepEqual((await store.reviews(11))[0].modes, ["arena", "regular"]);
    assert.deepEqual((await store.reviews(12))[0].modes, ["arena", "regular"]);
  });

  test(`${name}: seasonal cycle survives when seasonal is not the latest report`, async () => {
    const store = makeStore();
    await store.report({ userSub: "google-a", aid: 21, mode: "seasonal", cycleId: "cycleX", createdAt: 10 });
    await store.report({ userSub: "google-b", aid: 21, mode: "regular", cycleId: "persistent", createdAt: 20 });
    assert.deepEqual(await store.reviews(21), [{
      aid: 21, mode: "regular", modes: ["regular", "seasonal"], cycleId: "persistent", seasonalCycleId: "cycleX",
      reportCount: 2, lastReportedAt: 20, yesCount: 0, noCount: 0,
    }]);
  });
}

test("community routes never reference the destructive ban operation", async () => {
  const { readFileSync } = await import("node:fs");
  const paths = [
    "app/api/community-reports/route.ts",
    "app/api/community/ban-reviews/claim/route.ts",
    "app/api/community/ban-reviews/vote/route.ts",
    "app/api/operator/community-reviews/route.ts",
  ];
  const operatorSource = readFileSync("app/api/operator/community-reviews/route.ts", "utf8");
  assert.equal(operatorSource.includes("user_" + "sub"), false);
  assert.equal(operatorSource.includes("helper_" + "id"), false);
  assert.equal(operatorSource.includes("reportCount"), true);
  for (const path of paths) {
    const source = readFileSync(path, "utf8");
    assert.equal(source.includes("confirm" + "Banned"), false, path);
    assert.equal(source.includes("ban-" + "db"), false, path);
  }
});
