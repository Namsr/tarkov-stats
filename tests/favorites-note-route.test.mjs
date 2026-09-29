import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const shim = (name) => ({ shortCircuit: true, url: pathToFileURL(resolve(`tests/fixtures/${name}`)).href });

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "next/server") return nextResolve("next/server.js", context);
    if (specifier === "@/lib/auth/session") return shim("favorite-auth-session-shim.mjs");
    if (specifier.startsWith("@/")) {
      return { shortCircuit: true, url: pathToFileURL(resolve(`${specifier.slice(2)}.ts`)).href };
    }
    return nextResolve(specifier, context);
  },
});

const directory = mkdtempSync(join(tmpdir(), "tarkov-favorites-note-route-"));
process.env.SQLITE_PATH = join(directory, "players.db");

const { getFavoritesStore } = await import("../lib/db.ts");
const { PATCH: patchFavorite } = await import("../app/api/favorites/route.ts");
const { NextRequest } = await import("next/server");

// The sub the session shim signs in as.
const SUB = "favorite-arena-test";
const store = await getFavoritesStore();
assert.ok(store);

// Every test pins its own AID and owns every row it asserts on, so each one
// stands alone under `--test-name-pattern` and does not inherit fixtures from a
// sibling test that happened to run first.
let ip = 0;
const patch = (body) =>
  patchFavorite(new NextRequest("http://local/api/favorites", {
    method: "PATCH",
    headers: { "content-type": "application/json", "x-real-ip": `198.51.100.${ip += 1}` },
    body: JSON.stringify(body),
  }));

const noteOf = async (aid) => (await store.list(SUB, null)).find((f) => f.aid === aid)?.note ?? null;

test("setting a note is applied for a favorite the caller owns", async () => {
  assert.equal(await store.add(SUB, 401, "Owned", null), "ok");

  const response = await patch({ aid: 401, note: "rescue kit" });
  assert.equal(response.status, 200);
  assert.equal(await noteOf(401), "rescue kit");

  // Re-saving the note the row already holds writes the same value, so the
  // route must not read a zero row count as "no such favorite" there either.
  const again = await patch({ aid: 401, note: "rescue kit" });
  assert.equal(again.status, 200);
  assert.equal(await noteOf(401), "rescue kit");

  // Clearing goes through the same statement and must keep answering 200.
  const cleared = await patch({ aid: 401, note: "" });
  assert.equal(cleared.status, 200);
  assert.equal(await noteOf(401), null);
});

test("setting a note is refused for an AID the caller does not own", async () => {
  // `useFavorites().setNote` paints the note locally before the PATCH lands and
  // only rolls it back on a non-2xx answer, so a 200 for a mutation the store
  // never applied left the note showing as saved until the next refresh.
  assert.equal(await store.add(SUB, 402, "Also owned", "keep me"), "ok");

  const response = await patch({ aid: 999_999, note: "not yours" });
  assert.deepEqual(
    { status: response.status, body: await response.json() },
    { status: 404, body: { error: "Favorite not found" } },
  );
  // The refused call must not have written anything, least of all onto the
  // caller's own favorite.
  assert.equal(await noteOf(402), "keep me");
  assert.equal(await noteOf(999_999), null);
});
