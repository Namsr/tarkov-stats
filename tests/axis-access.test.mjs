import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createAxisLeagueStore } from "../lib/admin/axis-league-db.ts";

const mock = source => ({ shortCircuit: true, url: "data:text/javascript," + encodeURIComponent(source) });
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === "next/server") return mock("export const NextResponse = Response; export function after(callback) { globalThis.axisAfter = callback; }");
  if (specifier === "@/lib/admin/request-events") return mock("export async function recordAuthActivity() {}");
  if (specifier === "server-only") return mock("");
  if (specifier === "@/lib/auth/session") return mock("export async function getSession() { return globalThis.axisUser; }");
  if (specifier === "@/lib/admin/axis-league-db") return mock("export async function getAxisLeagueStore() { if (globalThis.axisStoreFailure) throw Error('offline'); return globalThis.axisRoleStore; }");
  if (specifier.startsWith("@/")) return { shortCircuit: true, url: pathToFileURL(resolve(specifier.slice(2) + ".ts")).href };
  return nextResolve(specifier, context);
} });
const { canEditAxisKda, requireAxisKdaEditor } = await import("../lib/axis-access.ts");
const { requireAdmin, getAdminSession } = await import("../lib/admin-auth.ts");
const { GET: photoGet } = await import("../app/api/axis-league/match-photo/route.ts");
const { POST: profilesPost } = await import("../app/api/axis-league/profiles/route.ts");

test("KDA editor role is scoped to the signed Google subject and revocation is immediate", async (t) => {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  process.env.ADMIN_GOOGLE_SUB = "full-admin";
  globalThis.axisRoleStore = createAxisLeagueStore(db);
  globalThis.axisStoreFailure = false;
  globalThis.axisUser = null;
  assert.deepEqual(await requireAxisKdaEditor(), { ok: false, status: 401 });
  const user = { sub: "editor", email: "same@example.test", name: "Admin", picture: "" };
  globalThis.axisUser = user;
  assert.deepEqual(await requireAxisKdaEditor(), { ok: false, status: 403 });
  globalThis.axisRoleStore.setKdaEditor("editor", true);
  assert.equal((await requireAxisKdaEditor()).ok, true);
  assert.deepEqual(await requireAdmin(), { ok: false, status: 403 });
  assert.equal(await getAdminSession(), null);
  assert.equal(await canEditAxisKda({ ...user, sub: "someone-else" }), false);
  globalThis.axisRoleStore.setKdaEditor("editor", false);
  assert.equal(await canEditAxisKda(user), false);
  globalThis.axisStoreFailure = true;
  assert.equal(await canEditAxisKda(user), false);
  assert.equal(await canEditAxisKda({ ...user, sub: "full-admin" }), true);
});

test("profile linking uses the same signed editor role and stops immediately after revocation", async (t) => {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  process.env.ADMIN_GOOGLE_SUB = "full-admin";
  globalThis.axisRoleStore = createAxisLeagueStore(db);
  globalThis.axisRoleStore.publish([{ id: "123", name: "Player", profile: null }]);
  globalThis.axisStoreFailure = false;
  const request = () => new Request("https://tarkovstats.ru/api/axis-league/profiles", { method: "POST", headers: { origin: "https://tarkovstats.ru", "content-type": "application/json" }, body: JSON.stringify({ discordId: "123", profile: "12345" }) });
  globalThis.axisUser = null;
  assert.equal((await profilesPost(request())).status, 401);
  globalThis.axisUser = { sub: "editor", email: "same@example.test", name: "Editor", picture: "" };
  assert.equal((await profilesPost(request())).status, 403);
  globalThis.axisRoleStore.setKdaEditor("editor", true);
  assert.equal((await profilesPost(request())).status, 200);
  assert.deepEqual(await requireAdmin(), { ok: false, status: 403 });
  globalThis.axisRoleStore.setKdaEditor("editor", false);
  assert.equal((await profilesPost(request())).status, 403);
  globalThis.axisUser = { ...globalThis.axisUser, sub: "someone-else" };
  assert.equal((await profilesPost(request())).status, 403);
  globalThis.axisUser = { ...globalThis.axisUser, sub: "full-admin" };
  assert.equal((await profilesPost(request())).status, 200);
});

test("the configured main administrator can edit AXIS without assigning themselves an editor role", async (t) => {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  process.env.ADMIN_GOOGLE_SUB = "configured-main-admin";
  globalThis.axisRoleStore = createAxisLeagueStore(db);
  globalThis.axisStoreFailure = false;
  globalThis.axisUser = { sub: "configured-main-admin", email: "admin@example.test", name: "Admin", picture: "" };
  assert.equal(globalThis.axisRoleStore.isKdaEditor(globalThis.axisUser.sub), false);
  assert.equal(await canEditAxisKda(globalThis.axisUser), true);
  assert.equal((await requireAxisKdaEditor()).ok, true);
  assert.equal((await requireAdmin()).ok, true);
});


test("photo metadata and files require a current editor role, including after revocation", async t => {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  process.env.ADMIN_GOOGLE_SUB = "full-admin";
  globalThis.axisRoleStore = createAxisLeagueStore(db);
  globalThis.axisStoreFailure = false;
  globalThis.axisUser = null;
  const get = (query = "meta=1") => photoGet(new Request("https://tarkovstats.ru/api/axis-league/match-photo?match=5&" + query));
  assert.equal((await get()).status, 401);
  globalThis.axisUser = { sub: "editor", email: "same@example.test", name: "Editor", picture: "" };
  assert.equal((await get()).status, 403);
  globalThis.axisRoleStore.setKdaEditor("editor", true);
  const metadata = await get(); assert.equal(metadata.status, 200); assert.equal((await metadata.json()).photo, null);
  assert.equal((await get("v=" + "a".repeat(64))).status, 404);
  globalThis.axisRoleStore.setKdaEditor("editor", false);
  assert.equal((await get()).status, 403); assert.equal((await get("v=" + "a".repeat(64))).status, 403);
  globalThis.axisUser = { ...globalThis.axisUser, sub: "full-admin" }; assert.equal((await get()).status, 200);
});


test("existing signed sessions populate Google names without granting editor access and tolerate directory failures", async t => {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  const { GET: me } = await import("../app/api/auth/me/route.ts");
  globalThis.axisRoleStore = createAxisLeagueStore(db);
  globalThis.axisStoreFailure = false;
  globalThis.axisUser = { sub: "returning-user", email: "private@example.test", name: "Имя Google", picture: "" };
  const response = await me();
  assert.equal(response.status, 200);
  assert.equal((await response.json()).canEditAxisKda, false);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM axis_google_accounts").get().n, 0, "session response must not wait for identity persistence");
  await globalThis.axisAfter();
  globalThis.axisRoleStore.setKdaEditor(globalThis.axisUser.sub, true);
  assert.equal(globalThis.axisRoleStore.listKdaEditors()[0].name, "Имя Google");
  globalThis.axisUser = { ...globalThis.axisUser, name: "Новое имя" };
  assert.equal((await (await me()).json()).canEditAxisKda, true);
  await globalThis.axisAfter();
  assert.equal(globalThis.axisRoleStore.listKdaEditors()[0].name, "Новое имя");
  globalThis.axisStoreFailure = true;
  const offline = await me();
  assert.equal(offline.status, 200); assert.equal((await offline.json()).user.sub, "returning-user");
  await assert.doesNotReject(globalThis.axisAfter());
  globalThis.axisUser = null;
  assert.equal((await (await me()).json()).user, null);
});
