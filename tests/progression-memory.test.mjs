import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

test("full progression publication fits a 64 MiB JS heap with 94 MiB of raw snapshot JSON", async () => {
  const { stdout } = await promisify(execFile)(process.execPath, [
    "--max-old-space-size=64", "--experimental-strip-types", "--experimental-sqlite", "tests/fixtures/progression-memory.mjs",
  ], { timeout: 60_000, env: { ...process.env, NODE_NO_WARNINGS: "1" } });
  const result = JSON.parse(stdout);
  assert.equal(result.snapshots, 1500);
  assert.ok(result.inputJsonMiB > 93);
  assert.ok(result.heapMiB < 64);
});

test("120,000 normalized snapshots and 110,000 intervals publish within a 64 MiB JS heap", async () => {
  const { stdout } = await promisify(execFile)(process.execPath, [
    "--max-old-space-size=64", "--expose-gc", "--experimental-strip-types", "--experimental-sqlite", "tests/fixtures/progression-population-memory.mjs",
  ], { timeout: 90_000, env: { ...process.env, NODE_NO_WARNINGS: "1" } });
  const result = JSON.parse(stdout);
  assert.equal(result.snapshots, 120_000);
  assert.equal(result.intervals, 110_000);
  assert.ok(result.heapMiB < 64);
});
