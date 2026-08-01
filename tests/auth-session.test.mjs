import assert from "node:assert/strict";
import test from "node:test";
import { authSecretKey } from "../lib/auth/secret.ts";

test("production sessions reject AUTH_SECRET values shorter than 32 UTF-8 bytes", () => {
  assert.throws(() => authSecretKey("too-short", "production"), /at least 32 bytes in production/);
  assert.equal(authSecretKey("x".repeat(32), "production").byteLength, 32);
});

test("development keeps short local secrets usable", () => {
  assert.equal(authSecretKey("local-only", "development").byteLength, 10);
  assert.throws(() => authSecretKey(undefined, "development"), /AUTH_SECRET is not set/);
});
