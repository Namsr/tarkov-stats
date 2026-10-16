import assert from "node:assert/strict";
import test from "node:test";
import zlib, { brotliDecompressSync } from "node:zlib";
import { syncBuiltinESMExports } from "node:module";
import { compressedJsonResponse } from "../lib/compressed-json-response.ts";

const timeline = { identity: { mode: "regular", cycleId: "persistent", aid: 1 },
  metrics: { xp: { player: Array.from({ length: 600 }, (_, i) => ({ date: `2026-${i}`, value: i / 7, n: i })), nearby: [], overall: [] } } };
const headers = { "Cache-Control": "no-store", "X-Statistics-Stale": "1", "X-Statistics-Generated-At": "123", "Retry-After": "5", Vary: "Origin" };
const request = (encoding?: string) => new Request("https://local/api/progression/timeline", { headers: encoding ? { "Accept-Encoding": encoding } : {} });

test("Brotli preserves every timeline value and statistics response header", async () => {
  const response = await compressedJsonResponse(request("gzip, br"), timeline, headers);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Encoding"), "br");
  assert.equal(response.headers.get("Content-Type"), "application/json");
  assert.equal(response.headers.get("Content-Length"), null);
  for (const [name, value] of Object.entries(headers)) if (name !== "Vary") assert.equal(response.headers.get(name), value);
  assert.equal(response.headers.get("Vary"), "Origin, Accept-Encoding");
  const bytes = new Uint8Array(await response.arrayBuffer());
  const decoded = brotliDecompressSync(bytes).toString();
  assert.equal(decoded, JSON.stringify(timeline));
  assert.deepEqual(JSON.parse(decoded), timeline);
  assert.ok(bytes.length < Buffer.byteLength(decoded));
});

test("identity and gzip clients keep the same JSON and accept-encoding variation", async () => {
  for (const encoding of [undefined, "gzip", "br;q=0", "br;q=0, *;q=1", "gzip;q=1, br;q=0.5", "identity;q=1, br;q=0.5", "br;q=bogus"]) {
    const response = await compressedJsonResponse(request(encoding), timeline, headers);
    assert.equal(response.headers.get("Content-Encoding"), null, encoding);
    assert.equal(await response.text(), JSON.stringify(timeline));
    assert.equal(response.headers.get("Vary"), "Origin, Accept-Encoding");
  }
  for (const encoding of ["BR", "gzip;q=0, br;q=0.5", "*;q=1"]) {
    const response = await compressedJsonResponse(request(encoding), timeline, { Vary: "Accept-Encoding" });
    assert.equal(response.headers.get("Content-Encoding"), "br");
    assert.equal(response.headers.get("Vary"), "Accept-Encoding");
  }
  const small = await compressedJsonResponse(request("br"), { n: 0 }, { Vary: "*" });
  assert.equal(small.headers.get("Content-Encoding"), null);
  assert.equal(small.headers.get("Vary"), "*");
  assert.deepEqual(await small.json(), { n: 0 });
});

test("compression failure serves the usable JSON with its original statistics headers", async (t) => {
  t.mock.method(zlib, "brotliCompress", (_input: unknown, _options: unknown, callback: (error: Error) => void) => callback(new Error("fixture compression failed")));
  syncBuiltinESMExports();
  try {
    const response = await compressedJsonResponse(request("br"), timeline, headers);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Content-Encoding"), null);
    assert.deepEqual(await response.json(), timeline);
    assert.equal(response.headers.get("X-Statistics-Stale"), "1");
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});
