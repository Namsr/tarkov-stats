import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { selectCiScope } from "../scripts/ci-scope.mjs";

test("CI selects the union of affected groups and keeps unknown changes on the full gate", () => {
  const counter = selectCiScope(["lib/home-counter-sampler.ts", "tests/public-index-coverage.test.ts"], "pull_request");
  assert.equal(counter.home_counter, true);
  assert.equal(counter.full, false);
  assert.equal(counter.benchmarks, false);
  const mixed = selectCiScope(["lib/home-counter.ts", "scripts/start-web.mjs", "components/SiteHeader.tsx", "ops/Caddyfile"], "pull_request");
  for (const key of ["home_counter", "ops", "proxy", "navigation", "arena_browser", "runtime_contract", "image"]) assert.equal(mixed[key], true, key);
  assert.equal(mixed.full, false);
  for (const path of ["package.json", "package-lock.json", "lib/db.ts", "rust/backend/src/main.rs", "tests/new.test.mjs", "new\nfile.ts"]) {
    const scope = selectCiScope(["lib/home-counter.ts", path], "pull_request");
    for (const key of ["full", "benchmarks", "runtime_contract", "arena_browser", "image"]) assert.equal(scope[key], true, path + ":" + key);
  }
});

test("CI scopes AXIS seasons with shared store callers and composes mixed changes", () => {
  const axisPaths = ["lib/axis-seasons.ts", "lib/admin/axis-league-db.ts", "tests/axis-league.test.mjs"];
  for (const event of ["pull_request", "push"]) {
    for (const paths of axisPaths.map(path => [path]).concat([axisPaths])) {
      const scope = selectCiScope(paths, event);
      assert.equal(scope.axis_seasons, true);
      assert.equal(scope.image, true);
      for (const key of ["full", "benchmarks", "runtime_contract", "arena_browser"]) assert.equal(scope[key], false, key);
    }
    const mixed = selectCiScope([...axisPaths, "scripts/ci-scope.mjs", ".github/workflows/vps-image.yml", "tests/background-isolation.test.mjs"], event);
    assert.equal(mixed.full, false);
    assert.equal(mixed.axis_seasons, true);
    assert.equal(mixed.ops, true);
    assert.equal(mixed.runtime_contract, true);
    assert.equal(mixed.benchmarks, false);
    assert.equal(mixed.arena_browser, false);
    for (const path of ["package.json", "lib/axis-history.ts", "lib/axis-win-probability.ts", "rust/backend/src/axis_stats.rs"]) {
      const scope = selectCiScope([...axisPaths, path], event);
      assert.equal(scope.full, true, path);
      assert.equal(scope.benchmarks, true, path);
    }
  }
});

test("CI retains full manual and missing-diff runs, and builds every deployed main revision", () => {
  for (const paths of [null, []]) assert.equal(selectCiScope(paths, "pull_request").full, true);
  assert.equal(selectCiScope(["lib/home-counter.ts"], "workflow_dispatch").full, true);
  const docs = selectCiScope(["docs/architecture.md", "README.md"], "pull_request");
  assert.equal(docs.full, false);
  assert.equal(docs.image, false);
  assert.equal(selectCiScope(["README.md"], "push").image, true);
  const ci = selectCiScope([".github/workflows/vps-image.yml", "scripts/ci-scope.mjs", "tests/background-isolation.test.mjs"], "pull_request");
  assert.equal(ci.ops, true);
  assert.equal(ci.runtime_contract, true);
  assert.equal(ci.full, false);
});

test("CI selector consumes NUL-delimited paths and writes only boolean step outputs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ci-scope-"));
  try {
    const paths = join(dir, "paths");
    const output = join(dir, "output");
    await writeFile(paths, "lib/home-counter-sampler.ts\0scripts/start-web.mjs\0");
    execFileSync(process.execPath, ["scripts/ci-scope.mjs", paths], {
      env: { ...process.env, GITHUB_EVENT_NAME: "pull_request", GITHUB_OUTPUT: output },
      timeout: 10_000,
    });
    const values = Object.fromEntries((await readFile(output, "utf8")).trim().split("\n").map(line => line.split("=")));
    assert.equal(values.home_counter, "true");
    assert.equal(values.ops, "true");
    assert.equal(values.full, "false");
    assert.equal(values.benchmarks, "false");
    assert.ok(Object.values(values).every(value => value === "true" || value === "false"));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("workflow keeps scoped tests, full fallback and cached image validation wired to the selector", async () => {
  const workflow = (await readFile(".github/workflows/vps-image.yml", "utf8")).replaceAll("\r\n", "\n");
  assert.doesNotMatch(workflow, /ui_proxy_only/);
  assert.match(workflow, /node scripts\/ci-scope\.mjs "\$RUNNER_TEMP\/check-paths"/);
  assert.match(workflow, /else\s+node scripts\/ci-scope\.mjs/);
  assert.match(workflow, /if: steps\.scope\.outputs\.full == 'true'\s+run: npm test/);
  assert.match(workflow, /home_counter == 'true'\s+run: node .*tests\/public-index-coverage\.test\.ts tests\/home-showcase-mode\.test\.mjs/);
  assert.match(workflow, /ops == 'true'\s+run: node .*tests\/background-isolation\.test\.mjs tests\/deploy-wrapper\.test\.mjs/);
  const axisStep = workflow.match(/- name: Run the affected AXIS season and shared store tests\n([\s\S]*?)(?=\n      - )/);
  assert.ok(axisStep);
  assert.match(axisStep[1], /full != 'true' && steps\.scope\.outputs\.axis_seasons == 'true'/);
  // Every existing test that imports the shared store or season detector belongs
  // in this group, including auth, access and submission callers outside history.
  for (const file of ["axis-league", "axis-player-profile", "axis-league-routes", "axis-win-probability", "axis-access", "axis-history-access", "axis-match-submission", "axis-submission-storage", "axis-discord-submission", "axis-ocr-context", "client-axis-league", "auth-session"]) {
    assert.ok(axisStep[1].includes(`tests/${file}.test.mjs`), file);
  }
  assert.match(workflow, /if: needs\.checks\.outputs\.image == 'true'/);
  for (const name of ["Benchmark isolated TypeScript and Rust API workloads", "Benchmark production Next and Rust HTTP endpoints"]) {
    assert.ok(workflow.includes(`name: ${name}\n        if: needs.checks.outputs.benchmarks == 'true'`));
  }
  assert.match(workflow, /cache-from: type=gha,scope=vps-image/);
  assert.match(workflow, /load: true/);
  assert.match(workflow, /name: Verify the runtime image\s+run:/);
});

const shell = process.platform === "win32"
  ? resolve(execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim(), "../../../bin/bash.exe") : "/bin/sh";
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";

test("VPS containers leave host headroom and all offline jobs use the shared budget", async () => {
  const compose = await readFile("ops/docker-compose.vps.yml", "utf8");
  const web = compose.slice(compose.indexOf("  web:"), compose.indexOf("  worker:"));
  const worker = compose.slice(compose.indexOf("  worker:"), compose.indexOf("  caddy:"));
  assert.match(web, /WEB_BACKGROUND_WORKERS: "false"/);
  // The dedicated service owns the sampler in this deployment; the web child is
  // only the fallback for composes that predate that service.
  assert.match(web, /HOME_COUNTER_SAMPLER: "false"/);
  assert.match(web, /mem_limit: 896m/);
  assert.match(web, /memswap_limit: 1152m/);
  assert.match(web, /^\s+- \/tmp:size=64m$/m);
  assert.match(web, /^\s+- \/app\/\.next\/cache:uid=1001,gid=1001,mode=0700,size=256m$/m);
  assert.match(worker, /cgroup_parent: tarkovstats-background.slice/);
  assert.match(worker, /mem_limit: 512m/);
  assert.match(worker, /memswap_limit: 768m/);
  assert.doesNotMatch(worker, /^\s+(ports|expose|build|depends_on):/m);
  assert.match(worker, /profiles: \["background"\]/);
  assert.match(compose, /worker: &background-worker/);
  assert.match(compose, /axis-league:\s+<<: \*background-worker\s+profiles: \[\]/);
  assert.match(web, /depends_on:\s+- axis-league/);
  assert.match(compose, /home-counter-sampler:\s+<<: \*background-worker\s+profiles: \[\]/);
  assert.match(web, /- home-counter-sampler/);
  assert.match(compose, /command: \["node", "--experimental-strip-types", "--experimental-sqlite", "scripts\/sample-home-coverage\.mjs"\]/);
  const dockerfile = await readFile("Dockerfile", "utf8");
  assert.match(dockerfile, /COPY .*scripts\/sample-home-coverage\.mjs/);
  // The web container also samples the counter, so an outdated compose file
  // cannot leave the public total frozen until the next index swap.
  assert.match(dockerfile, /ENV HOME_COUNTER_SAMPLER=true/);
  const startup = await readFile("scripts/start-web.mjs", "utf8");
  assert.match(startup, /HOME_COUNTER_SAMPLER === "true"/);
  assert.match(startup, /"scripts\/sample-home-coverage\.mjs"/);
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
  assert.match(service, /flock -w 7200 -E 75 \/run\/tarkovstats-data-sync.lock/);
  assert.match(service, /^TimeoutStartSec=5h$/m);
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
      // The statistics upstream defaults to the Rust process (web:3001), which does
      // not exist in this temporary HTTP-only directory. Keep the run Next-only.
      env: { ...process.env, WEB_BACKGROUND_WORKERS: "false", AXIS_STATISTICS_API_UPSTREAM: "web:3000" },
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

test("daily refresh remains sequential and tries progression and achievement tempo even after average failure", async () => {
  const source = await readFile("ops/materialize-publications.sh", "utf8");
  const dir = await mkdtemp(join(tmpdir(), "daily-publications-"));
  try {
    const mock = `runner() {
      case "$*" in
        *AVERAGE_MATERIALIZE_ONCE*) echo average; return 9;;
        *PROGRESSION_MATERIALIZE_ONCE*) echo progression; return 0;;
        *materialize-achievement-tempo.mjs*) echo tempo; return 0;;
        *) return 88;;
      esac
    }
`;
    for (const [name, setup, expected] of [
      ["average-failure", mock, 1],
      ["tempo-failure", mock.replace("echo average; return 9", "echo average; return 0").replace("echo tempo; return 0", "echo tempo; return 7"), 1],
      ["success", mock.replace("echo average; return 9", "echo average; return 0"), 0],
    ]) {
      const file = join(dir, `${name}.sh`);
      await writeFile(file, setup + source.replaceAll("/usr/local/sbin/tarkovstats-run-background", "runner"));
      const result = spawnSync(shell, [file], { encoding: "utf8", timeout: 10_000 });
      assert.ifError(result.error);
      assert.equal(result.status, expected, result.stderr);
      assert.deepEqual(result.stdout.trim().split(/\r?\n/), ["average", "progression", "tempo"]);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
