import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { authSecretKey } from "../lib/auth/secret.ts";

// Next's Node server loads `node-environment` first, which is the only reason
// `after()`'s work store is a real AsyncLocalStorage instead of a fake whose
// `run()` throws. Reproduce that one line before any Next module is loaded.
globalThis.AsyncLocalStorage ??= AsyncLocalStorage;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "next/server") return nextResolve("next/server.js", context);
    if (specifier === "next/headers") return nextResolve("next/headers.js", context);
    if (specifier.startsWith("@/")) {
      return { shortCircuit: true, url: pathToFileURL(resolve(`${specifier.slice(2)}.ts`)).href };
    }
    return nextResolve(specifier, context);
  },
});

const directory = mkdtempSync(join(tmpdir(), "tarkov-auth-routes-"));
process.env.SQLITE_PATH = join(directory, "players.db");
process.env.ADMIN_ANALYTICS_SQLITE_PATH = join(directory, "admin-analytics.db");
// `encryptSession` signs with AUTH_SECRET. The callback's `after()` task is
// deliberately dropped by the no-op work context below, so no analytics are
// written here; the store paths stay off the container's /data regardless, in
// case that context ever stops being a no-op.
process.env.AUTH_SECRET = "auth-routes-test-secret";
process.env.PUBLIC_BASE_URL = "https://example.test";
process.env.OBSERVABILITY_SAMPLE_RATE = "0";

const { NextRequest } = await import("next/server");
const { decryptSession } = await import("../lib/auth/session.ts");
// `after()` reads Next's own work-context AsyncLocalStorage and throws without
// one, which drops the success branch into its `login_failed` catch. Borrowing
// the store is the only way to invoke that branch outside a real request.
// The deep path is acceptable because it is the very module `next/server`
// itself loads (next/server.js -> after/index.js -> after.js ->
// work-async-storage.external): renaming it breaks Next wholesale rather than
// this one test, and `next` ships no `exports` map offering a stabler route.
const { workAsyncStorage } = await import("next/dist/server/app-render/work-async-storage.external.js");
const { POST: logout } = await import("../app/api/auth/logout/route.ts");
const { GET: startGoogleLogin } = await import("../app/api/auth/google/route.ts");
const { GET: finishGoogleLogin } = await import("../app/api/auth/google/callback/route.ts");

const callbackUrl = "http://local/api/auth/google/callback";

test("production sessions reject AUTH_SECRET values shorter than 32 UTF-8 bytes", () => {
  assert.throws(() => authSecretKey("too-short", "production"), /at least 32 bytes in production/);
  assert.equal(authSecretKey("x".repeat(32), "production").byteLength, 32);
});

test("development keeps short local secrets usable", () => {
  assert.equal(authSecretKey("local-only", "development").byteLength, 10);
  assert.throws(() => authSecretKey(undefined, "development"), /AUTH_SECRET is not set/);
});

test("logging out clears the session and answers no-store, so a shared cache cannot replay it", async () => {
  // The route takes no request and checks no session: its whole point is to drop
  // a cookie that may be absent, so an anonymous caller reaches this branch too.
  const response = await logout();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.match(response.headers.get("set-cookie") ?? "", /^session=;/);
  // What used to be missing: nothing told the shared cache in front of the app
  // that this credential-clearing response must not be stored.
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("both Google login redirects are no-store, including the not-configured fallback", async () => {
  // Unconfigured credentials: the graceful redirect that the catch returns.
  delete process.env.GOOGLE_CLIENT_ID;
  const unconfigured = await startGoogleLogin(new NextRequest("http://local/api/auth/google"));
  assert.equal(unconfigured.status, 307);
  assert.equal(unconfigured.headers.get("location"), "https://example.test/?auth_error=not_configured");
  assert.equal(unconfigured.headers.get("cache-control"), "no-store");

  process.env.GOOGLE_CLIENT_ID = "test-client-id";
  const started = await startGoogleLogin(new NextRequest("http://local/api/auth/google"));
  assert.equal(started.status, 307);
  assert.match(started.headers.get("location") ?? "", /^https:\/\/accounts\.google\.com\//);
  assert.match(started.headers.get("set-cookie") ?? "", /^oauth_state=/);
  // The CSRF state cookie is minted per request, so the redirect must not be
  // shared either.
  assert.equal(started.headers.get("cache-control"), "no-store");
});

test("every reachable Google callback redirect is no-store", async () => {
  // Google reported an error back to us.
  const denied = await finishGoogleLogin(new NextRequest(`${callbackUrl}?error=access_denied`));
  assert.equal(denied.status, 307);
  assert.equal(denied.headers.get("location"), "https://example.test/?auth_error=access_denied");
  assert.equal(denied.headers.get("cache-control"), "no-store");

  // CSRF check failed: missing or mismatched state cookie.
  const invalid = await finishGoogleLogin(new NextRequest(`${callbackUrl}?code=c&state=s`));
  assert.equal(invalid.status, 307);
  assert.equal(invalid.headers.get("location"), "https://example.test/?auth_error=invalid_state");
  assert.equal(invalid.headers.get("cache-control"), "no-store");

  // Matching state, but the token exchange fails and lands in the catch.
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.reject(new Error("token endpoint unreachable"));
  const failed = await finishGoogleLogin(
    new NextRequest(`${callbackUrl}?code=c&state=s`, { headers: { cookie: "oauth_state=s" } })
  );
  globalThis.fetch = realFetch;
  assert.equal(failed.status, 307);
  assert.equal(failed.headers.get("location"), "https://example.test/?auth_error=login_failed");
  assert.match(failed.headers.get("set-cookie") ?? "", /^oauth_state=;/);
  assert.equal(failed.headers.get("cache-control"), "no-store");
});

test("the callback's session-issuing redirect is no-store when it is actually reached", async () => {
  // Unlike the other six branches this one signs a real session, so it is the
  // response a shared cache must never replay. Drive it live rather than
  // reading the source: the branch used to hide behind an `after()` call that
  // threw outside a request scope, and nothing here would have noticed.
  process.env.GOOGLE_CLIENT_ID = "test-client-id";
  process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";

  // Answer both Google endpoints so the route gets past the CSRF check and
  // signs a session instead of landing in its `login_failed` catch.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url) => {
    const body = String(url).startsWith("https://oauth2.googleapis.com/token")
      ? { access_token: "test-access-token" }
      : { sub: "google-user-1", email: "player@example.test", name: "Player" };
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  };
  let res;
  try {
    res = await workAsyncStorage.run(
      { afterContext: { after: () => {} } },
      () => finishGoogleLogin(
        new NextRequest(`${callbackUrl}?code=c&state=s`, { headers: { cookie: "oauth_state=s" } })
      )
    );
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.GOOGLE_CLIENT_SECRET;
  }

  assert.equal(res.status, 307);
  assert.equal(res.headers.get("location"), "https://example.test/");
  // A deletion also emits `session=`, so decode the value instead: this branch
  // has to hand back a session cookie the app itself would accept.
  const setCookies = res.headers.getSetCookie();
  assert.ok(setCookies.some((cookie) => /^oauth_state=;/.test(cookie)));
  const sessionCookie = setCookies.find((cookie) => cookie.startsWith("session=")) ?? "";
  const token = /^session=([^;]+)/.exec(sessionCookie)?.[1];
  assert.ok(token, `the success branch must hand back a session cookie, got: ${sessionCookie}`);
  // Without the HttpOnly flag the cookie is readable by any script on the page.
  assert.match(sessionCookie, /;\s*HttpOnly(?:;|$)/i);
  assert.equal((await decryptSession(token))?.sub, "google-user-1");
  assert.equal(res.headers.get("cache-control"), "no-store");
});

test("the auth routes single-source the directive and never redirect bare", async () => {
  const [logoutRoute, googleRoute, callbackRoute] = await Promise.all([
    readFile("app/api/auth/logout/route.ts", "utf8"),
    readFile("app/api/auth/google/route.ts", "utf8"),
    readFile("app/api/auth/google/callback/route.ts", "utf8"),
  ]);

  // logout has a single json branch; the two OAuth routes redirect on every path.
  assert.equal(
    (logoutRoute.match(/NextResponse\.json\(\{ ok: true \}, \{ headers: noStore \}\)/g) ?? []).length,
    1
  );
  for (const [name, source, expected] of [
    ["auth/google", googleRoute, 2],
    ["auth/google/callback", callbackRoute, 4],
  ]) {
    const redirects = (source.match(/NextResponse\.redirect\(/g) ?? []).length;
    assert.equal(redirects, expected, `${name} gained or lost a response branch`);
    const guarded = (source.match(/NextResponse\.redirect\([\s\S]{0,60}?\{ headers: noStore \}\)/g) ?? []).length;
    assert.equal(guarded, redirects, `every ${name} redirect must carry no-store`);
    // Keep the directive single-sourced rather than re-spelled at a return site.
    assert.equal((source.match(/"Cache-Control"/g) ?? []).length, 1, `${name} re-spells the directive`);
    assert.doesNotMatch(source, /NextResponse\.redirect\((?:home|authUrl)\);/);
  }
});
