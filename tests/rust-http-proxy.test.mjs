import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

const caddy = process.env.CADDY_BIN;
const request = (port, path, host = "tarkovstats.ru") => new Promise((resolve, reject) => {
  const req = http.get({ host: "127.0.0.1", port, path, headers: { Host: host }, timeout: 10000 }, (res) => {
    let body = ""; res.setEncoding("utf8"); res.on("data", (chunk) => { body += chunk; });
    res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
  });
  req.on("error", reject); req.on("timeout", () => req.destroy(new Error("proxy fixture timed out")));
});
async function listen(server, port = 0) {
  server.listen(port, "127.0.0.1"); await once(server, "listening"); return server.address().port;
}
async function close(server) {
  server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
}

test("production proxy selects the Rust endpoint, bounds each upstream and never retries on Next", {
  skip: !caddy && "Set CADDY_BIN for the real production-proxy integration test", timeout: 40000,
}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "rust-http-proxy-"));
  let nextCount = 0, rustCount = 0, hold = false, fail = false, reset = false;
  const heldNext = [], heldRust = [];
  const handler = (backend, held) => (req, res) => {
    if (backend === "rust") rustCount++; else nextCount++;
    if (backend === "rust" && reset) { req.socket.destroy(); return; }
    if (hold) { held.push(res); return; }
    res.writeHead(backend === "rust" && fail ? 503 : 200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ backend, path: req.url, clientIp: req.headers["x-real-ip"] }));
  };
  const next = http.createServer(handler("next", heldNext));
  const native = http.createServer(handler("rust", heldRust));
  const nextPort = await listen(next), rustPort = await listen(native);
  const probe = http.createServer(); const port = await listen(probe); await close(probe);
  const source = await readFile("ops/Caddyfile", "utf8");
  const config = source.replace("{", `{\n    admin off\n    persist_config off\n    auto_https off\n    default_bind 127.0.0.1`)
    .replaceAll("web:3000", `127.0.0.1:${nextPort}`)
    .replace(/^tarkovstats\.ru, www\.tarkovstats\.ru \{/m, `http://tarkovstats.ru:${port}, http://www.tarkovstats.ru:${port} {`)
    .replace(/^tarkovstats\.online, www\.tarkovstats\.online \{/m, `http://tarkovstats.online:${port}, http://www.tarkovstats.online:${port} {`);
  await mkdir(join(directory, "data"));
  const path = join(directory, "Caddyfile"); await writeFile(path, config);
  const child = spawn(caddy, ["run", "--config", path, "--adapter", "caddyfile"], {
    cwd: directory, windowsHide: true, stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, SEASONAL_API_UPSTREAM: `127.0.0.1:${rustPort}`, GOMEMLIMIT: "192MiB",
      APPDATA: directory, XDG_DATA_HOME: directory, XDG_CONFIG_HOME: directory },
  });
  let logs = ""; child.stderr.setEncoding("utf8"); child.stderr.on("data", (chunk) => { logs = `${logs}${chunk}`.slice(-16000); });
  const stopped = once(child, "close");
  t.after(async () => {
    for (const res of [...heldNext, ...heldRust]) res.destroy();
    child.kill(); await stopped;
    await close(next); await close(native);
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith("rust-http-proxy-"));
    await rm(directory, { recursive: true, force: true });
  });
  const deadline = Date.now() + 10000;
  while (true) {
    assert.equal(child.exitCode, null, logs);
    try { await request(port, "/proxy-ready"); break; } catch { assert.ok(Date.now() < deadline, logs); await delay(20); }
  }
  for (const host of ["tarkovstats.ru", "tarkovstats.online"]) {
    for (const path of ["/api/seasonal/cohort?aid=1", "/api/seasonal/cohort/?aid=1"]) {
      const result = await request(port, path, host);
      assert.equal(result.status, 200); assert.equal(JSON.parse(result.body).backend, "rust");
      assert.equal(JSON.parse(result.body).path, path);
      assert.equal(JSON.parse(result.body).clientIp, "127.0.0.1");
      assert.equal(result.headers.server, undefined);
      assert.match(result.headers["strict-transport-security"], /max-age=31536000/);
    }
    for (const path of ["/api/seasonal/profile", "/api/seasonal/cohort-extra", "/healthz"]) {
      assert.equal(JSON.parse((await request(port, path, host)).body).backend, "next");
    }
  }
  const before = nextCount, nativeBefore = rustCount;
  fail = true;
  assert.equal((await request(port, "/api/seasonal/cohort?aid=1")).status, 503);
  assert.equal(rustCount, nativeBefore + 1); assert.equal(nextCount, before);
  fail = false; reset = true;
  assert.equal((await request(port, "/api/seasonal/cohort?aid=1")).status, 502);
  assert.equal(nextCount, before); reset = false;

  // The two real upstream addresses have separate 32-request bounds. Confirm
  // the mixed limit instead of retaining the former one-address global claim.
  hold = true;
  const heldRequests = Array.from({ length: 32 }, (_, i) => request(port, "/api/seasonal/cohort", i % 2 ? "tarkovstats.online" : "tarkovstats.ru"));
  const nextRequests = Array.from({ length: 32 }, (_, i) => request(port, "/api/seasonal/profile", i % 2 ? "tarkovstats.online" : "tarkovstats.ru"));
  while (heldRust.length !== 32 || heldNext.length !== 32) {
    assert.ok(Date.now() < deadline + 10000, `mixed admission did not fill both pools: ${heldRust.length}/${heldNext.length} ${logs}`);
    await delay(10);
  }
  assert.equal((await request(port, "/api/seasonal/cohort")).status, 503);
  assert.equal((await request(port, "/api/seasonal/profile")).status, 503);
  hold = false;
  for (const res of [...heldNext, ...heldRust]) { res.writeHead(200); res.end("released"); }
  for (const result of await Promise.all([...heldRequests, ...nextRequests])) assert.equal(result.status, 200);

  await close(native);
  assert.equal((await request(port, "/api/seasonal/cohort")).status, 502);
  assert.equal(nextCount, before + 32);
  await listen(native, rustPort);
  const recovered = await request(port, "/api/seasonal/cohort");
  assert.equal(recovered.status, 200); assert.equal(JSON.parse(recovered.body).backend, "rust");
});
