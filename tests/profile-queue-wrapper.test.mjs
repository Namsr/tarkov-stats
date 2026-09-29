import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
const shell = process.platform === 'win32'
  ? resolve(execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(), '../../../bin/bash.exe') : '/bin/sh';
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

test('queue retries only failures, preserves error status and runs one warmup after freshness', async () => {
  const source = await readFile('ops/profile-queue.sh', 'utf8');
  assert.ok(source.indexOf('run_mode arena') < source.indexOf('run_mode regular'));
  assert.ok(source.indexOf('run_mode regular') < source.indexOf('run_mode pve'));
  assert.ok(source.indexOf('run_mode pve') < source.indexOf('run_mode seasonal'));
  assert.match(source, /run_mode arena dc -e ARENA_PROFILE_SYNC_RPS=2 -e ARENA_PROFILE_SYNC_CONCURRENCY=2 -e ARENA_PROFILE_SYNC_MAX_RUN_MS=1500000/);
  for (const scenario of ['success', 'retry', 'persistent', 'starved', 'stopped', 'invalid', 'budget', 'warn']) {
    const dir = await mkdtemp(join(tmpdir(), 'queue-behavior-'));
    try {
      const path = dir.replaceAll('\\', '/');
      const mock = `dc() {
        case "$*" in
          *warmup-leaderboard-profiles*) echo warmup >> calls; echo '{"bounded":true,"stopped":false,"processed":100}'
            if [ "$SCENARIO" = warn ]; then echo 'unreadable leaderboard warmup checkpoint at /data/leaderboard-warmup-state.json; starting from a fresh checkpoint' >&2; fi;;
          *sync-regular-profiles*) echo regular >> calls
            if [ "$SCENARIO" = persistent ]; then return 7; fi
            if [ "$SCENARIO" = retry ] && [ ! -f retried ]; then touch retried; return 7; fi;;
          *sync-pve-profiles*) echo pve >> calls;;
          *sync-arena-profiles*) echo arena >> calls
            if [ "$SCENARIO" = starved ] && [ ! -f retried ]; then touch retried; return 5; fi;;
          *sync-seasonal-profiles*) echo seasonal >> calls;;
          *) return 88;;
        esac
      }
      sleep() { :; }
      date() {
        if [ "$SCENARIO" = starved ] && [ "$*" = +%s ]; then
          if [ -f started ]; then echo $(( \$(command date +%s) + 3255 )); else touch started; command date +%s; fi
          return 0
        fi
        if [ "$SCENARIO" = budget ] && [ "$*" = +%s ] && [ -f calls ]; then echo 4102444800; else command date "$@"; fi
      }
      python3() { cat >/dev/null; case "$SCENARIO" in stopped) echo stopped;; invalid) return 1;; *) echo done;; esac; }
      `;
      // Both rewrites below are literal needles. If either line is renamed or
      // reformatted the replace silently does nothing and the script writes to the
      // real /var/log on a Linux runner, so the assertion fails here instead.
      assert.match(source, /^log=/m);
      assert.match(source, /^warn=/m);
      const script = source.replace('cd /opt/tarkovstats-auto || exit 1', `cd ${quote(path)} || exit 1`)
        .replace(/^dc\(\).*$/m, () => mock)
        .replace('log=/var/log/tarkovstats-warmup-batch.json', `log=${quote(path + '/warmup.json')}`)
        .replace('warn=/var/log/tarkovstats-warmup-batch.warn', `warn=${quote(path + '/warmup.warn')}`);
      const file = join(dir, 'queue.sh');
      await writeFile(file, script.replaceAll('\r\n','\n'));
      const result = spawnSync(shell, [file], { env: { ...process.env, SCENARIO: scenario }, encoding: 'utf8', timeout: 10_000 });
      assert.ifError(result.error);
      assert.equal(result.status, scenario === 'persistent' || scenario === 'invalid' || scenario === 'starved' ? 1 : scenario === 'stopped' ? 143 : 0, `${scenario}: ${result.stderr}\n${result.stdout}`);
      assert.deepEqual((await readFile(join(dir, 'calls'),'utf8')).trim().split(/\r?\n/),
        scenario === 'budget' ? ['arena'] : ['arena', ...Array(scenario === 'retry' || scenario === 'persistent' ? 2 : 1).fill('regular'), 'pve','seasonal','warmup']);
      if (scenario === 'budget') assert.match(result.stdout, /status=deferred-budget/);
      if (scenario === 'warn') {
        // The operator sees the warning in the journal, framed like every other queue line.
        assert.match(result.stdout, /WARMUP_WARN unreadable leaderboard warmup checkpoint at/);
        assert.doesNotMatch(result.stdout, /state-parse-failed/);
        // ...and the JSON log stays pure stdout, so the last line the state parser
        // reads is still the summary and a healthy batch is not reported as a parse failure.
        assert.deepEqual((await readFile(join(dir, 'warmup.json'), 'utf8')).trim().split(/\r?\n/),
          ['{"bounded":true,"stopped":false,"processed":100}']);
        assert.match((await readFile(join(dir, 'warmup.warn'), 'utf8')), /unreadable leaderboard warmup checkpoint/);
      }
      if (scenario === 'starved') {
        // A retry that cannot get a real run window must not turn the failure into
        // a success: the bounded run aborts on its first checkpoint and exits 0.
        assert.match(result.stdout, /MODE_RETRY mode=arena attempt=skipped .*reason=insufficient-budget/);
        assert.match(result.stdout, /MODE_RESULT mode=arena status=5/);
        assert.match(result.stdout, /QUEUE_SUMMARY ok=false failures="arena:5"/);
        assert.doesNotMatch(result.stdout, /ok=true/);
      }
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
  const [dropIn, service, timer] = await Promise.all([
    readFile('ops/systemd/tarkovstats-profile-queue-no-restart.conf', 'utf8'),
    readFile('ops/systemd/tarkovstats-profile-queue.service', 'utf8'),
    readFile('ops/systemd/tarkovstats-profile-queue.timer', 'utf8'),
  ]);
  assert.match(dropIn, /^Restart=no$/m);
  assert.match(service, /ExecCondition=.*tarkovstats-public-profile-importer/);
  assert.match(service, /ConditionPathExists=\/usr\/local\/sbin\/tarkovstats-profile-queue/);
  assert.match(service, /flock \/run\/tarkovstats-data-sync\.lock/);
  assert.match(service, /\/usr\/local\/sbin\/tarkovstats-profile-queue/);
  assert.match(timer, /OnCalendar=hourly/);
});
