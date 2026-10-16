import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createAxisLeagueStore } from "../lib/admin/axis-league-db.ts";

const mock = source => ({ shortCircuit: true, url: "data:text/javascript," + encodeURIComponent(source) });
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === "server-only") return mock("");
  if (specifier === "@/lib/auth/session") return mock("export async function getSession() { return globalThis.axisUser; }");
  if (specifier === "@/lib/admin/axis-league-db") return mock("export async function getAxisLeagueStore() { if (globalThis.axisStoreFailure) throw Error('offline'); return globalThis.axisRoleStore; }");
  if (specifier.startsWith("@/")) return { shortCircuit: true, url: pathToFileURL(resolve(specifier.slice(2) + ".ts")).href };
  return nextResolve(specifier, context);
} });
const { canEditAxisKda, requireAxisKdaEditor } = await import("../lib/axis-access.ts");
const { requireAdmin, getAdminSession } = await import("../lib/admin-auth.ts");
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
