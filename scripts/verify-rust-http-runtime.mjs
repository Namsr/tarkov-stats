// Runs inside the built image against real production Next and Rust listeners.
import assert from "node:assert/strict";

const next = process.env.NEXT_HTTP_URL || "http://127.0.0.1:3000";
const native = process.env.RUST_HTTP_URL || "http://127.0.0.1:3001";
for (const base of [next, native]) {
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1000) });
      await response.body?.cancel();
      if (response.status === 200) { ready = true; break; }
    } catch { /* Wait only for these freshly started local listeners. */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.ok(ready, `${base} did not become healthy`);
}
const headers = ["content-security-policy", "x-frame-options", "x-content-type-options",
  "referrer-policy", "permissions-policy", "x-dns-prefetch-control", "strict-transport-security",
  "content-type", "cache-control", "allow", "location", "refresh", "access-control-allow-origin", "set-cookie"];
const cases = [
  ["GET", "/api/seasonal/cohort"],
  ["GET", "/api/seasonal/cohort?aid=invalid&cycle=native-s1"],
  ["GET", "/api/seasonal/cohort?aid=1&cycle=native-s1"],
  ["HEAD", "/api/seasonal/cohort?aid=1&cycle=native-s1"],
  ["OPTIONS", "/api/seasonal/cohort"],
  ["POST", "/api/seasonal/cohort"],
  ["GET", "/api/seasonal/cohort/?aid=1&cycle=native-s1"],
  ["HEAD", "/api/seasonal/cohort/?aid=1&cycle=native-s1"],
  ["POST", "/api/seasonal/cohort/?aid=1&cycle=native-s1"],
];
const mismatches = [];
for (const [method, path] of cases) {
  const replies = await Promise.all([next, native].map(async (base) => {
    const response = await fetch(`${base}${path}`, { method, redirect: "manual", signal: AbortSignal.timeout(5000) });
    return { status: response.status, headers: response.headers, body: await response.text() };
  }));
  const [expected, actual] = replies;
  if (actual.status !== expected.status) mismatches.push({ method, path, field: "status", actual: actual.status, expected: expected.status });
  for (const name of headers) if (actual.headers.get(name) !== expected.headers.get(name)) {
    mismatches.push({ method, path, field: name, actual: actual.headers.get(name), expected: expected.headers.get(name) });
  }
  if (method !== "HEAD" && expected.headers.get("content-type")?.includes("application/json")) {
    assert.deepEqual(JSON.parse(actual.body), JSON.parse(expected.body), `${method} ${path} JSON`);
  } else if (actual.body !== expected.body) mismatches.push({ method, path, field: "body", actual: actual.body, expected: expected.body });
}
assert.deepEqual(mismatches, [], "production HTTP boundary differences");
console.log(JSON.stringify({ event: "rust_http_runtime_verified", cases: cases.length,
  scope: "Production Next HTTP versus Rust HTTP: methods, error/gate JSON, redirect and global security headers; not a load or production-VPS test" }));
