import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

const entry = resolve("scripts/start-web.mjs");
const binary = resolve("rust/backend/target/release", `tarkov-backend${process.platform === "win32" ? ".exe" : ""}`);

async function fixture(t, env = {}) {
  const directory = await mkdtemp(join(tmpdir(), "rust-http-supervisor-"));
  await mkdir(join(directory, "scripts"));
  await writeFile(join(directory, "scripts/web-runtime-health.mjs"), "globalThis.preloadFixturePid = process.pid; console.log(JSON.stringify({event:\"preload_fixture_ready\",pid:process.pid}));\n");
  await writeFile(join(directory, "server.js"), `
    if (globalThis.preloadFixturePid !== process.pid) throw new Error("Next runtime preload was not attached to its child");
    console.log(JSON.stringify({event:"next_fixture_ready",pid:process.pid}));
    if(process.env.SUPERVISOR_FIXTURE_EXIT) setTimeout(()=>process.exit(Number(process.env.SUPERVISOR_FIXTURE_EXIT)),30);
    else { process.stdin.resume(); process.stdin.on("data",data=>{ const match=String(data).match(/^exit:(\\d+)/); if(match)process.exit(Number(match[1])); }); }
    process.on("SIGTERM",()=>process.exit(0));
  `);
  const child = spawn(process.execPath, [entry], { cwd: directory, windowsHide: true,
    env: { ...process.env, WEB_BACKGROUND_WORKERS: "false", RUNTIME_HEALTH_ENABLED: "false",
      SEASONAL_API_UPSTREAM: "web:3000", RUST_API_BIND: "127.0.0.1:0", RUST_API_BIN: binary, ...env },
    stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  const done = new Promise((resolve) => { child.once("close", (code, signal) => resolve({ code, signal })); });
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const events = () => stdout.split("\n").flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  const waitEvent = async (predicate) => {
    for (let count = 0; count < 300; count++) {
      const value = events().find(predicate); if (value) return value;
      if (child.exitCode !== null || child.signalCode !== null) assert.fail(`Exited before readiness: ${stdout} ${stderr}`);
      await delay(10);
    }
    assert.fail(`No readiness event: ${stdout} ${stderr}`);
  };
  t.after(async () => {
    // PIDs come only from this test's own child records; never enumerate or kill unrelated work.
    for (const event of events().filter((event) => event.event === "web_critical_process_v1")) {
      try { process.kill(event.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    }
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await done;
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith("rust-http-supervisor-"));
    await rm(directory, { recursive: true, force: true });
  });
  return { child, done, events, waitEvent, stdout: () => stdout, stderr: () => stderr, directory };
}
function stopped(pid) {
  try { process.kill(pid, 0); return false; }
  catch (error) { if (error.code === "ESRCH") return true; throw error; }
}

test("web startup rejects unknown routing and does not require Rust for the default backend", { timeout: 20000 }, async (t) => {
  const invalid = await fixture(t, { SEASONAL_API_UPSTREAM: "other:3001" });
  assert.equal((await invalid.done).code, 1);
  assert.match(invalid.stderr(), /SEASONAL_API_UPSTREAM must be/);
  assert.deepEqual(invalid.events(), []);
  const original = await fixture(t, { RUST_API_BIN: resolve("missing-rust-http-server"), SUPERVISOR_FIXTURE_EXIT: "0" });
  assert.equal((await original.done).code, 0);
  assert.equal(original.events().filter((event) => event.name === "Rust API").length, 0);
  assert.ok(original.events().some((event) => event.event === "next_fixture_ready"));
});

test("opted-in Rust spawn failure prevents a falsely healthy Next server", { timeout: 20000 }, async (t) => {
  const run = await fixture(t, { SEASONAL_API_UPSTREAM: "web:3001", RUST_API_BIN: resolve("missing-rust-http-server") });
  assert.equal((await run.done).code, 1);
  assert.match(run.stderr(), /Rust API spawn failed/);
  assert.equal(run.events().some((event) => event.event === "next_fixture_ready"), false);
});

test("both critical HTTP processes stop together and Rust readiness precedes Next startup", { timeout: 30000 }, async (t) => {
  assert.ok(existsSync(binary), "build the Rust HTTP backend before running supervisor integration tests");
  const run = await fixture(t, { SEASONAL_API_UPSTREAM: "web:3001" });
  const next = await run.waitEvent((event) => event.event === "next_fixture_ready");
  const preload = run.events().find((event) => event.event === "preload_fixture_ready");
  assert.equal(preload.pid, next.pid, "the preload belongs to Next, not the supervisor");
  assert.notEqual(preload.pid, run.child.pid);
  const native = run.events().find((event) => event.event === "web_critical_process_v1" && event.name === "Rust API");
  assert.ok(native);
  assert.ok(run.events().findIndex((event) => event.event === "rust_api_ready") < run.events().findIndex((event) => event.event === "next_fixture_ready"));
  run.child.stdin.write("exit:7\n");
  assert.equal((await run.done).code, 7);
  assert.equal(stopped(next.pid), true);
  assert.equal(stopped(native.pid), true);
});

test("a Rust API crash tears down Next and fails the web container", { timeout: 30000 }, async (t) => {
  const run = await fixture(t, { SEASONAL_API_UPSTREAM: "web:3001" });
  const next = await run.waitEvent((event) => event.event === "next_fixture_ready");
  const native = run.events().find((event) => event.event === "web_critical_process_v1" && event.name === "Rust API");
  process.kill(native.pid, "SIGKILL");
  assert.equal((await run.done).code, 1);
  assert.equal(stopped(next.pid), true);
});

test("shutdown force-stops a critical process that ignores SIGTERM", {
  skip: process.platform === "win32" && "Windows does not deliver POSIX SIGTERM handlers", timeout: 20000,
}, async (t) => {
  const setup = await fixture(t, { SUPERVISOR_FIXTURE_EXIT: "0" });
  await setup.done;
  const stubborn = join(setup.directory, "stubborn.cjs");
  await writeFile(stubborn, `#!/usr/bin/env node
    const http=require("node:http");
    const server=http.createServer((_,res)=>res.end("ok"));
    server.listen(0,"127.0.0.1",()=>console.log(JSON.stringify({event:"rust_api_ready",address:"127.0.0.1:"+server.address().port})));
    process.on("SIGTERM",()=>{});
  `);
  await chmod(stubborn, 0o755);
  const started = Date.now();
  const run = await fixture(t, { SEASONAL_API_UPSTREAM: "web:3001", RUST_API_BIN: stubborn, SUPERVISOR_FIXTURE_EXIT: "0" });
  assert.equal((await run.done).code, 0);
  const native = run.events().find((event) => event.name === "Rust API");
  assert.equal(stopped(native.pid), true);
  assert.ok(Date.now() - started >= 4900, "wait for the real graceful deadline before force kill");
  assert.ok(Date.now() - started < 15000, "shutdown must remain bounded");
});
