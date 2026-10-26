import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const state = globalThis.__reportRouteTest = { session: { sub: "alice" }, unavailable: false, failWrite: false };
const moduleUrl = (source) => `data:text/javascript,${encodeURIComponent(source)}`;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "next/server") return nextResolve("next/server.js", context);
    if (specifier === "@/lib/auth/session") return { shortCircuit: true, url: moduleUrl("export async function getSession() { return globalThis.__reportRouteTest.session; }") };
    if (specifier === "@/lib/community-reports-db") return { shortCircuit: true, url: moduleUrl(`
      import { getCommunityReportsStore as open } from "${pathToFileURL(resolve("lib/community-reports-db.ts")).href}";
      export async function getCommunityReportsStore() {
        if (globalThis.__reportRouteTest.unavailable) return null;
        const store = await open();
        if (globalThis.__reportRouteTest.failWrite) store.unreport = async () => { throw new Error("write failed"); };
        return store;
      }
    `) };
    if (specifier.startsWith("@/")) return { shortCircuit: true, url: pathToFileURL(resolve(`${specifier.slice(2)}.ts`)).href };
    return nextResolve(specifier, context);
  },
});
process.env.REPORTS_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "report-undo-route-")), "reports.db");
const { getCommunityReportsStore } = await import("../lib/community-reports-db.ts");
const store = await getCommunityReportsStore();
assert.ok(store);
const { DELETE, GET } = await import("../app/api/community-reports/route.ts");
const { NextRequest } = await import("next/server");
let ip = 0;
const remove = (body, address = `198.51.100.${++ip}`) => DELETE(new NextRequest("http://local/api/community-reports", {
  method: "DELETE", headers: { "content-type": "application/json", "x-real-ip": address }, body: JSON.stringify(body),
}));

test("DELETE withdraws only the signed-in user's global mark and GET persists it", async () => {
  await store.report({ userSub: "alice", aid: 7, mode: "seasonal", cycleId: "retired-cycle" });
  await store.report({ userSub: "bob", aid: 7, mode: "regular", cycleId: "persistent" });
  const result = await remove({ aid: 7 });
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("cache-control"), "no-store");
  assert.deepEqual(await result.json(), { count: 1 });
  assert.equal(await store.reportedBy("bob", 7), true);
  const status = await GET(new NextRequest("http://local/api/community-reports?aid=7"));
  assert.deepEqual(await status.json(), { count: 1, reportedByMe: false });
  assert.deepEqual(await (await remove({ aid: 7 })).json(), { count: 1 });
  assert.deepEqual(await store.report({ userSub: "alice", aid: 7, mode: "arena", cycleId: "persistent" }), { already: false, count: 2 });
});

test("DELETE requires authentication", async () => {
  await store.report({ userSub: "alice", aid: 8, mode: "regular", cycleId: "persistent" });
  state.session = null;
  try {
    assert.equal((await remove({ aid: 8 })).status, 401);
    assert.equal(await store.reportedBy("alice", 8), true);
  } finally { state.session = { sub: "alice" }; }
});

test("DELETE rejects invalid identities and supplied user IDs", async () => {
  await store.report({ userSub: "alice", aid: 9, mode: "regular", cycleId: "persistent" });
  for (const body of [null, [], {}, { aid: 0 }, { aid: "7x" }, { aid: [9] }, { aid: {} }, { aid: { toString: null } }, { aid: 9, userSub: "bob" }, { aid: 9, mode: "arena" }]) {
    assert.equal((await remove(body)).status, 400, JSON.stringify(body));
  }
  const malformed = await DELETE(new NextRequest("http://local/api/community-reports", { method: "DELETE", body: "{" }));
  assert.equal(malformed.status, 400);
  assert.equal(await store.reportedBy("alice", 9), true);
});

test("DELETE reports unavailable storage and failed writes without removing the mark", async () => {
  await store.report({ userSub: "alice", aid: 10, mode: "regular", cycleId: "persistent" });
  for (const flag of ["unavailable", "failWrite"]) {
    state[flag] = true;
    try { assert.equal((await remove({ aid: 10 })).status, 503); }
    finally { state[flag] = false; }
  }
  assert.equal(await store.reportedBy("alice", 10), true);
});

test("DELETE shares the report write rate limit", async () => {
  for (let n = 0; n < 30; n++) assert.equal((await remove({ aid: 999 }, "203.0.113.50")).status, 200);
  assert.equal((await remove({ aid: 999 }, "203.0.113.50")).status, 429);
});
