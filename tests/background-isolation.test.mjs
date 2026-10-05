import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const shell = process.platform === "win32"
  ? resolve(execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim(), "../../../bin/bash.exe") : "/bin/sh";
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";

test("VPS containers leave host headroom and all offline jobs use the shared budget", async () => {
  const compose = await readFile("ops/docker-compose.vps.yml", "utf8");
  const web = compose.slice(compose.indexOf("  web:"), compose.indexOf("  worker:"));
  const worker = compose.slice(compose.indexOf("  worker:"), compose.indexOf("  caddy:"));
  assert.match(web, /WEB_BACKGROUND_WORKERS: "false"/);
  assert.match(web, /mem_limit: 896m/);
  assert.match(web, /memswap_limit: 1152m/);
  assert.match(worker, /cgroup_parent: tarkovstats-background.slice/);
  assert.match(worker, /mem_limit: 512m/);
  assert.match(worker, /memswap_limit: 768m/);
  assert.doesNotMatch(worker, /^\s+(ports|expose|build|depends_on):/m);
  assert.match(worker, /profiles: \["background"\]/);
  const slice = await readFile("ops/systemd/tarkovstats-background.slice", "utf8");
  assert.match(slice, /^MemoryMax=512M$/m);
  assert.match(slice, /^MemorySwapMax=256M$/m);
  assert.match(slice, /^CPUQuota=50%$/m);
  assert.match(slice, /^IOReadBandwidthMax=\/dev\/vda 8M$/m);
  assert.match(slice, /^IOWriteBandwidthMax=\/dev\/vda 4M$/m);
  assert.ok(1967 - 896 - 512 - 256 >= 300);
  for (const name of ["arena", "pve", "regular", "seasonal"]) {
    const unit = await readFile(`ops/systemd/tarkovstats-${name}-profile-sync.service`, "utf8");
    assert.match(unit, /tarkovstats-run-background .* worker nice -n 19 node/);
    assert.doesNotMatch(unit, /compose .*exec/);
  }
  for (const name of ["arena", "pve", "player", "seasonal"]) {
    const unit = await readFile(`ops/systemd/tarkovstats-${name}-index-sync.service`, "utf8");
    assert.match(unit, /tarkovstats-run-background worker nice -n 19 node/);
  }
  const leaderboard = await readFile("ops/systemd/tarkovstats-leaderboard-materialize.service", "utf8");
  assert.ok(leaderboard.indexOf("data-sync.lock") < leaderboard.indexOf("leaderboard.lock"));
  assert.match(leaderboard, /tarkovstats-run-background worker/);
  const backup = await readFile("ops/backup-db.sh", "utf8");
  assert.match(backup, /tarkovstats-run-background worker nice -n 19 ionice -c 3 node/);
  assert.doesNotMatch(backup, /docker exec tarkovstats-web/);
  const service = await readFile("ops/systemd/tarkovstats-publications.service", "utf8");
  assert.match(service, /flock -n -E 75 \/run\/tarkovstats-data-sync.lock/);
  assert.match(service, /^RestartSec=1h$/m);
  const timer = await readFile("ops/systemd/tarkovstats-publications.timer", "utf8");
  assert.match(timer, /^OnCalendar=\*-\*-\* 02:30:00 UTC$/m);
});

test("HTTP-only startup launches no materializers and still supervises HTTP exit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "http-only-"));
  try {
    await mkdir(join(dir, "scripts"));
    await writeFile(join(dir, "scripts/web-runtime-health.mjs"), "");
    await writeFile(join(dir, "server.js"), 'console.log("HTTP_STARTED"); process.exitCode = 7;');
    const result = spawnSync(process.execPath, [resolve("scripts/start-web.mjs")], {
      cwd: dir, encoding: "utf8", timeout: 20_000,
      env: { ...process.env, WEB_BACKGROUND_WORKERS: "false" },
    });
    assert.ifError(result.error);
    assert.equal(result.status, 7, result.stderr);
    assert.match(result.stdout, /HTTP_STARTED/);
    // No materializer files exist in the temporary cwd. Spawning one is a failure.
    assert.doesNotMatch(result.stderr, /materialize-|MODULE_NOT_FOUND|retry in/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("one-shot progression terminates and reports source failures without five-minute startup delay", async () => {
  for (const broken of [false, true]) {
    const dir = await mkdtemp(join(tmpdir(), "progression-once-"));
    try {
      if (broken) await writeFile(join(dir, "players.db"), "not sqlite");
      else execFileSync(process.execPath, ["--experimental-sqlite", "-e", `
        const { DatabaseSync } = require("node:sqlite");
        const db = new DatabaseSync(process.argv[1]);
        db.exec("CREATE TABLE players (aid INTEGER PRIMARY KEY, hours REAL, achievements TEXT);" +
          "CREATE TABLE mode_players (mode TEXT, aid INTEGER, hours REAL, achievements TEXT);" +
          "CREATE TABLE excluded_players (aid INTEGER PRIMARY KEY);");
        db.close();
      `, join(dir, "players.db")], { timeout: 10_000 });
      const result = spawnSync(process.execPath, [
        "--experimental-strip-types", "--experimental-sqlite", "scripts/materialize-progression-population.mjs",
      ], {
        encoding: "utf8", timeout: 90_000,
        env: { ...process.env, PROGRESSION_MATERIALIZE_ONCE: "true", SEASONAL_ENABLED: "false",
          SQLITE_PATH: join(dir, "players.db"), PROGRESSION_SQLITE_PATH: join(dir, "progression.db") },
      });
      assert.ifError(result.error);
      assert.equal(result.status, broken ? 1 : 0, result.stdout + result.stderr);
      if (broken) assert.match(result.stderr, /achievement baseline materialization failed/);
      else assert.match(result.stdout, /progression population checked/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
});

test("background runner pins the live image, refuses missing limits and propagates job errors", async () => {
  const source = await readFile("ops/run-background.sh", "utf8");
  for (const scenario of ["ok", "job-failed", "interrupted", "no-slice", "unlimited", "wrong-swap", "busy", "no-web"]) {
    const dir = await mkdtemp(join(tmpdir(), "background-run-"));
    try {
      const target = dir.replaceAll("\\", "/");
      const mock = `
systemctl() {
  case "$*" in
    is-active*) [ "$SCENARIO" != no-slice ];;
    *MemoryMax*) if [ "$SCENARIO" = unlimited ]; then echo infinity; else echo 536870912; fi;;
    *MemorySwapMax*) if [ "$SCENARIO" = wrong-swap ]; then echo infinity; else echo 268435456; fi;;
    *) return 91;;
  esac
}
flock() { [ "$SCENARIO" != busy ]; }
docker() {
  case "$*" in
    *"ps -q web") [ "$SCENARIO" = no-web ] || echo live-container;;
    "inspect --format {{.Image}} live-container") echo sha256:live-image;;
    *" run "*)
      for argument in "$@"; do
        case "$argument" in --no-build) echo "unknown flag: --no-build" >&2; return 125;; esac
      done
      printf '%s\\n' "$TARKOVSTATS_WORKER_IMAGE $*" >> calls
      if [ "$SCENARIO" = interrupted ]; then kill -TERM "$$"; fi
      [ "$SCENARIO" != job-failed ] || return 9;;
    "stop -t 30 tarkovstats-background-job") echo stop >> calls;;
    *) echo "unexpected docker command: $*" >&2; return 92;;
  esac
}
`;
      assert.match(source, /^APP=\/opt\/tarkovstats-auto$/m);
      const script = source.replace("APP=/opt/tarkovstats-auto", () => `APP=${quote(target)}\n${mock}`)
        .replace("exec 8>/run/tarkovstats-background-job.lock", 'exec 8>"$APP/job.lock"');
      assert.doesNotMatch(script, /\/opt\/tarkovstats-auto|\/run\/tarkovstats-background-job.lock/);
      const file = join(dir, "runner.sh");
      await writeFile(file, script.replaceAll("\r\n", "\n"));
      const result = spawnSync(shell, [file, "-e", "BUDGET=123", "worker", "nice", "-n", "19", "node", "job.mjs"], {
        encoding: "utf8", timeout: 20_000, env: { ...process.env, SCENARIO: scenario },
      });
      assert.ifError(result.error);
      const calls = await readFile(join(dir, "calls"), "utf8").catch(() => "");
      if (scenario === "ok" || scenario === "job-failed" || scenario === "interrupted") {
        assert.equal(result.status, scenario === "ok" ? 0 : scenario === "interrupted" ? 143 : 9, result.stderr);
        assert.match(calls, /^sha256:live-image /);
        assert.match(calls, /run --rm --no-deps --pull never -T --name tarkovstats-background-job -e BUDGET=123 worker nice -n 19 node job.mjs/);
        if (scenario === "interrupted") assert.match(calls, /\nstop\n/);
      } else {
        assert.notEqual(result.status, 0, scenario);
        assert.equal(calls, "", scenario);
        if (scenario === "busy") assert.equal(result.status, 75);
      }
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
});

test("daily refresh remains sequential and tries progression even after average failure", async () => {
  const source = await readFile("ops/materialize-publications.sh", "utf8");
  const dir = await mkdtemp(join(tmpdir(), "daily-publications-"));
  try {
    const mock = `runner() {
      case "$*" in
        *AVERAGE_MATERIALIZE_ONCE*) echo average; return 9;;
        *PROGRESSION_MATERIALIZE_ONCE*) echo progression; return 0;;
        *) return 88;;
      esac
    }
`;
    const file = join(dir, "daily.sh");
    await writeFile(file, mock + source.replaceAll("/usr/local/sbin/tarkovstats-run-background", "runner"));
    const result = spawnSync(shell, [file], { encoding: "utf8", timeout: 10_000 });
    assert.ifError(result.error);
    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(result.stdout.trim().split(/\r?\n/), ["average", "progression"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
