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

const directory = mkdtempSync(join(tmpdir(), "tarkov-favorites-route-"));
process.env.SQLITE_PATH = join(directory, "players.db");

const { getFavoritesStore } = await import("../lib/db.ts");
const { PATCH: patchFavorite } = await import("../app/api/favorites/route.ts");
const { NextRequest } = await import("next/server");

// The sub the session shim signs in as.
const SUB = "favorite-arena-test";
const store = await getFavoritesStore();
assert.ok(store);

let ip = 0;
const patch = (body) =>
  patchFavorite(new NextRequest("http://local/api/favorites", {
    method: "PATCH",
    headers: { "content-type": "application/json", "x-real-ip": `198.51.100.${ip += 1}` },
    body: JSON.stringify(body),
  }));

const mainAids = async () => (await store.list(SUB, null)).filter((f) => f.isMain).map((f) => f.aid);

test("setting the main flag succeeds for a favorite the caller owns", async () => {
  assert.equal(await store.add(SUB, 11, "Owned", null), "ok");
  assert.equal(await store.add(SUB, 22, "Also owned", null), "ok");

  const response = await patch({ aid: 11, main: true });
  assert.equal(response.status, 200);
  assert.deepEqual(await mainAids(), [11]);

  // Re-pinning the same AID writes the same value, so the route must not read a
  // zero row count as "no such favorite" there either.
  const again = await patch({ aid: 11, main: true });
  assert.equal(again.status, 200);
  assert.deepEqual(await mainAids(), [11]);

  const switched = await patch({ aid: 22, main: true });
  assert.equal(switched.status, 200);
  assert.deepEqual(await mainAids(), [22]);
});

test("setting the main flag is refused for an AID the caller does not own", async () => {
  // `useFavorites().setMain` paints the badge locally before the PATCH lands and
  // only rolls it back on a non-2xx answer, so a 200 for a mutation the store
  // never applied left the wrong main badge on screen until the next refresh.
  const response = await patch({ aid: 999_999, main: true });
  assert.deepEqual({ status: response.status, body: await response.json() }, { status: 404, body: { error: "Favorite not found" } });
  // The refused call must not have moved the flag off the caller's own favorite.
  assert.deepEqual(await mainAids(), [22]);
});
