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
    env: { ...process.env, SEASONAL_API_UPSTREAM: `127.0.0.1:${rustPort}`, HOME_SHOWCASE_API_UPSTREAM: `127.0.0.1:${rustPort}`, ARENA_UI_UPSTREAM: `127.0.0.1:${rustPort}`, PVE_UI_UPSTREAM: `127.0.0.1:${nextPort}`, REGULAR_UI_UPSTREAM: `127.0.0.1:${nextPort}`, GOMEMLIMIT: "192MiB",
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
    for (const path of ["/api/seasonal/cohort?aid=1", "/api/seasonal/cohort/?aid=1", "/api/home/showcase", "/api/home/showcase/?x=1", "/population/arena", "/average/arena?x=1", "/_rust/arena/hash/tarkov_ui.js", "/api/average?mode=arena", "/api/average?mode=arena&mode=pve", "/api/average?m%6Fde=%61r%65%6Ea"]) {
      const result = await request(port, path, host);
      assert.equal(result.status, 200); assert.equal(JSON.parse(result.body).backend, "rust");
      assert.equal(JSON.parse(result.body).path, path);
      assert.equal(JSON.parse(result.body).clientIp, "127.0.0.1");
      assert.equal(result.headers.server, undefined);
      assert.match(result.headers["strict-transport-security"], /max-age=31536000/);
    }
    for (const path of ["/api/seasonal/profile", "/api/seasonal/cohort-extra", "/api/home/showcase-extra", "/api/home/coverage", "/healthz", "/population/pve", "/api/average?mode=pve&mode=arena", "/api/average?mode=&mode=arena", "/api/average?MODE=arena", "/api/average?mode=arenax", "/api/average?mode=arena%20", "/api/average?mode=pve"]) {
      assert.equal(JSON.parse((await request(port, path, host)).body).backend, "next");
    }
  }
  const before = nextCount, nativeBefore = rustCount;
  fail = true;
  assert.equal((await request(port, "/api/seasonal/cohort?aid=1")).status, 503);
  assert.equal(rustCount, nativeBefore + 1); assert.equal(nextCount, before);
  assert.equal((await request(port, "/api/home/showcase")).status, 503);
  assert.equal(nextCount, before);
  fail = false; reset = true;
  assert.equal((await request(port, "/api/seasonal/cohort?aid=1")).status, 502);
  assert.equal((await request(port, "/api/home/showcase")).status, 502);
  assert.equal(nextCount, before); reset = false;

  // The two real upstream addresses have separate 32-request bounds. Confirm
  // the mixed limit instead of retaining the former one-address global claim.
  hold = true;
  const heldPaths = ["/api/seasonal/cohort", "/api/home/showcase", "/api/average?mode=arena", "/population/arena", "/_rust/arena/hash/tarkov_ui.js"];
  const heldRequests = Array.from({ length: 32 }, (_, i) => request(port, heldPaths[i % heldPaths.length], i % 2 ? "tarkovstats.online" : "tarkovstats.ru"));
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
  // Enter handle_errors on refused dial first, then accept and reset. A GET
  // retry policy here would replay after the application accepted this request.
  reset = true;
  const acceptedBefore = rustCount;
  const resumed = new Promise((resolve, reject) => {
    setTimeout(() => listen(native, rustPort).then(resolve, reject), 650);
  });
  const afterRefused = await request(port, "/api/home/showcase");
  await resumed;
  assert.equal(afterRefused.status, 502);
  assert.equal(rustCount, acceptedBefore + 1, "no replay after refused dial recovers to a connected reset");
  assert.equal(nextCount, before + 32, "refused native home never falls back to Next");
  reset = false;
  const recoveredHome = await request(port, "/api/home/showcase");
  assert.equal(recoveredHome.status, 200);
  const recovered = await request(port, "/api/seasonal/cohort");
  assert.equal(recovered.status, 200); assert.equal(JSON.parse(recovered.body).backend, "rust");
});

test("persistent UI selectors independently route decoded modes, assets and every population API", {
  skip: !caddy && "Set CADDY_BIN for the real production-proxy integration test", timeout: 60000,
}, async t => {
  const directory = await mkdtemp(join(tmpdir(), "rust-persistent-proxy-"));
  let nextCount = 0, rustCount = 0, hold = false, fail = false, reset = false;
  const held = [];
  const next = http.createServer((req, res) => { nextCount++; res.end(JSON.stringify({ backend: "next", path: req.url })); });
  const native = http.createServer((req, res) => {
    rustCount++;
    if (reset) { req.socket.destroy(); return; }
    if (hold) { held.push(res); return; }
    res.writeHead(fail ? 503 : 200); res.end(JSON.stringify({ backend: "rust", path: req.url }));
  });
  const nextPort = await listen(next), rustPort = await listen(native);
  let running;
  t.after(async () => {
    for (const response of held) response.destroy();
    if (running) { running.child.kill(); await running.stopped; }
    await close(next); await close(native);
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith("rust-persistent-proxy-"));
    await rm(directory, { recursive: true, force: true });
  });
  const source = await readFile("ops/Caddyfile", "utf8");
  const families = ["/api/average", "/api/average/metrics", "/api/progression/average", "/api/average/achievements"];
  const asset = "/_rust/persistent/hash/tarkov_ui_bg.wasm";
  for (const [pve, regular] of [[false, false], [true, false], [false, true], [true, true]]) {
    const probe = http.createServer(), port = await listen(probe); await close(probe);
    const config = source.replace("{", "{\n admin off\n persist_config off\n auto_https off\n default_bind 127.0.0.1")
      .replaceAll("web:3000", `127.0.0.1:${nextPort}`)
      .replace(/^tarkovstats\.ru, www\.tarkovstats\.ru \{/m, `http://tarkovstats.ru:${port} {`)
      .replace(/^tarkovstats\.online, www\.tarkovstats\.online \{/m, `http://tarkovstats.online:${port} {`);
    const file = join(directory, `Caddyfile-${pve}-${regular}`); await writeFile(file, config);
    const child = spawn(caddy, ["run", "--config", file, "--adapter", "caddyfile"], {
      windowsHide: true, stdio: ["ignore", "ignore", "pipe"], cwd: directory,
      env: { ...process.env, PVE_UI_UPSTREAM: `127.0.0.1:${pve ? rustPort : nextPort}`,
        REGULAR_UI_UPSTREAM: `127.0.0.1:${regular ? rustPort : nextPort}`,
        ARENA_UI_UPSTREAM: `127.0.0.1:${nextPort}`, SEASONAL_API_UPSTREAM: `127.0.0.1:${nextPort}`,
        HOME_SHOWCASE_API_UPSTREAM: `127.0.0.1:${nextPort}`, GOMEMLIMIT: "192MiB",
        APPDATA: directory, XDG_CONFIG_HOME: directory, XDG_DATA_HOME: directory },
    });
    let logs = ""; child.stderr.on("data", value => { logs = (logs + value).slice(-16000); });
    running = { child, stopped: once(child, "close") };
    const deadline = Date.now() + 10000;
    while (true) {
      assert.equal(child.exitCode, null, logs);
      try { await request(port, "/proxy-ready"); break; } catch { assert.ok(Date.now() < deadline, logs); await delay(20); }
    }
    const check = async (path, selected, host = "tarkovstats.ru") => {
      const response = await request(port, path, host);
      assert.equal(response.status, 200, `${pve}/${regular} ${path} ${logs}`);
      assert.equal(JSON.parse(response.body).backend, selected ? "rust" : "next", `${pve}/${regular} ${path}`);
      assert.equal(JSON.parse(response.body).path, path);
    };
    for (const family of families) for (const trailing of ["", "/"]) {
      for (const query of ["", "?statistic=median", "?MODE=pve", "?mo+de=pve", "?m%256fde=pve", "?mode=regular", "?mode=regular&mode=pve", "?%6d%6f%64%65=%72eg%75lar"]) await check(family + trailing + query, regular);
      for (const query of ["?mode=pve", "?mode=pve&mode=regular", "?m%6Fde=%70%76%65", "?MODE=regular&mode=pve"]) await check(family + trailing + query, pve, "tarkovstats.online");
      for (const query of ["?mode", "?mode=", "?mode=&mode=regular", "?mode=Regular", "?mode=%20regular", "?mode=%2570ve", "?mode=arena", "?mode=seasonal"]) await check(family + trailing + query, false);
    }
    for (const path of ["/population/pve", "/population/pve/", "/average/pve", "/average/pve/"]) await check(path, pve);
    for (const path of ["/population/regular", "/population/regular/", "/average/regular", "/average/regular/"]) await check(path, regular);
    await check(asset, pve || regular);
    for (const path of ["/population/pvex", "/average/regular-extra", "/api/average/metrics-extra?mode=pve", "/_rust/persistent-extra/hash/app.js"]) await check(path, false);
    if (pve || regular) {
      const chosen = pve ? "pve" : "regular", beforeNext = nextCount;
      fail = true;
      for (const family of families) {
        const beforeRust = rustCount;
        assert.equal((await request(port, family + "?mode=" + chosen)).status, 503);
        assert.equal(rustCount, beforeRust + 1, "accepted overload never replays");
      }
      fail = false;
      if (!pve || !regular) {
        for (const path of [asset, pve ? "/api/progression/average?mode=pve" : "/api/average/metrics"]) {
          await close(native); reset = true;
          const beforeRust = rustCount;
          let resumeTimer;
          const resumed = new Promise((resolve, reject) => { resumeTimer = setTimeout(() => listen(native, rustPort).then(resolve, reject), 650); });
          try {
            const response = await request(port, path);
            await resumed;
            assert.equal(response.status, 502);
            assert.equal(rustCount, beforeRust + 1, "refused dial retries same selected backend without accepted replay: " + path);
          } finally { clearTimeout(resumeTimer); }
          reset = false;
        }
      }
      assert.equal(nextCount, beforeNext, "native failures never fall back to Next");
    }
    if (pve && regular) {
      hold = true;
      const paths = [...families.map(path => path + "?mode=pve"), ...families.map(path => path + "?mode=regular"), "/population/pve", "/average/regular", asset];
      const pending = Array.from({ length: 32 }, (_, i) => request(port, paths[i % paths.length]));
      const filled = Date.now() + 5000;
      while (held.length !== 32) { assert.ok(Date.now() < filled, logs); await delay(10); }
      assert.equal((await request(port, "/api/average/metrics?mode=regular")).status, 503);
      assert.equal((await request(port, asset)).status, 503);
      await check("/healthz", false);
      hold = false;
      for (const res of held) { res.writeHead(200); res.end("released"); }
      for (const response of await Promise.all(pending)) assert.equal(response.status, 200);
    }
    child.kill(); await running.stopped; running = undefined;
  }
});
