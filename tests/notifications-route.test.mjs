import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === "next/server") return nextResolve("next/server.js", context);
  if (specifier === "@/lib/auth/session") return { shortCircuit: true, url: pathToFileURL(resolve("tests/fixtures/notifications-session-shim.mjs")).href };
  if (specifier.startsWith("@/")) return { shortCircuit: true, url: pathToFileURL(resolve(`${specifier.slice(2)}.ts`)).href };
  return nextResolve(specifier, context);
} });

const directory = mkdtempSync(join(tmpdir(), "notifications-route-"));
process.env.ADMIN_ANALYTICS_SQLITE_PATH = join(directory, "admin.db");
process.env.REPORTS_SQLITE_PATH = join(directory, "reports.db");
const { getSupportStore } = await import("../lib/admin/support-db.ts");
const { NextRequest } = await import("next/server");
const session = await import("./fixtures/notifications-session-shim.mjs");
const { GET, PATCH } = await import("../app/api/notifications/route.ts");
const store = await getSupportStore();
const news = store.createNotification({ title: "News", body: "Body" });
const admin = new DatabaseSync(process.env.ADMIN_ANALYTICS_SQLITE_PATH);
admin.exec(`CREATE TABLE admin_audit_log (id INTEGER PRIMARY KEY, aid INTEGER, action TEXT, next_status TEXT, created_at INTEGER);
  INSERT INTO admin_audit_log VALUES (1, 42, 'review', 'reviewed', 20), (2, 43, 'review', 'confirmed', 20);`);
admin.close();
const reports = new DatabaseSync(process.env.REPORTS_SQLITE_PATH);
reports.exec(`CREATE TABLE suspect_reports (user_sub TEXT, aid INTEGER, mode TEXT, created_at INTEGER);
  INSERT INTO suspect_reports VALUES ('alice', 42, 'regular', 10), ('bob', 43, 'arena', 10);`);
reports.close();
let ip = 0;
function request(method = "GET", body, origin = "http://local") {
  return new NextRequest("http://local/api/notifications", { method,
    headers: { origin, "content-type": "application/json", "x-real-ip": `198.51.100.${++ip}` },
    ...(method === "PATCH" ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
  });
}

test("the inbox rejects anonymous access and always returns no-store", async () => {
  session.setUser(null);
  for (const response of [await GET(request()), await PATCH(request("PATCH", { ids: ["report:1"] }))]) {
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  session.setUser({ sub: "alice" });
});

test("read and mutation routes isolate accounts and never accept foreign or invented IDs", async () => {
  const response = await GET(request());
  assert.equal(response.headers.get("cache-control"), "no-store");
  const feed = await response.json();
  assert.equal(feed.unreadCount, 2);
  assert.deepEqual(feed.notifications.map((item) => item.id), [`news:${news.id}`, "report:1"]);
  for (const id of ["report:2", "news:999"]) {
    const rejected = await PATCH(request("PATCH", { ids: [`news:${news.id}`, id] }));
    assert.equal(rejected.status, 404);
    assert.equal(rejected.headers.get("cache-control"), "no-store");
  }
  assert.equal((await (await GET(request())).json()).unreadCount, 2, "rejected batches must not partially write");
  const marked = await PATCH(request("PATCH", { ids: [`news:${news.id}`, "report:1"] }));
  assert.equal(marked.status, 200);
  assert.equal((await marked.json()).unreadCount, 0);
  assert.equal((await (await GET(request())).json()).unreadCount, 0);
  session.setUser({ sub: "bob" });
  assert.equal((await (await GET(request())).json()).unreadCount, 2);
  session.setUser({ sub: "alice" });
});

test("mutations reject cross-origin requests, malformed JSON, and oversized batches", async () => {
  assert.equal((await PATCH(request("PATCH", { ids: ["report:1"] }, "https://evil.example"))).status, 403);
  for (const body of ["{", {}, { ids: [] }, { ids: [1] }, { ids: ["report:-1"] }, { ids: Array(121).fill("report:1") }]) {
    const response = await PATCH(request("PATCH", body));
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
});

test("inbox database failures return no-store 503 rather than an empty success", async () => {
  const db = new DatabaseSync(process.env.REPORTS_SQLITE_PATH);
  try {
    db.exec("DROP TABLE suspect_reports; CREATE TABLE suspect_reports (incompatible INTEGER)");
    const response = await GET(request());
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "no-store");
  } finally { db.close(); }
});
