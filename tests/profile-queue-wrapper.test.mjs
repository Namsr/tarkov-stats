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
  for (const scenario of ['success', 'retry', 'persistent', 'stopped', 'invalid', 'budget']) {
    const dir = await mkdtemp(join(tmpdir(), 'queue-behavior-'));
    try {
      const path = dir.replaceAll('\\', '/');
      const mock = `dc() {
        case "$*" in
          *warmup-leaderboard-profiles*) echo warmup >> calls; echo '{"bounded":true,"stopped":false,"processed":100}';;
          *sync-regular-profiles*) echo regular >> calls
            if [ "$SCENARIO" = persistent ]; then return 7; fi
            if [ "$SCENARIO" = retry ] && [ ! -f retried ]; then touch retried; return 7; fi;;
          *sync-pve-profiles*) echo pve >> calls;;
          *sync-arena-profiles*) echo arena >> calls;;
          *sync-seasonal-profiles*) echo seasonal >> calls;;
          *) return 88;;
        esac
      }
      sleep() { :; }
      date() { if [ "$SCENARIO" = budget ] && [ "$*" = +%s ] && [ -f calls ]; then echo 4102444800; else command date "$@"; fi; }
      python3() { cat >/dev/null; case "$SCENARIO" in stopped) echo stopped;; invalid) return 1;; *) echo done;; esac; }
      `;
      const script = source.replace('cd /opt/tarkovstats-auto || exit 1', `cd ${quote(path)} || exit 1`)
        .replace(/^dc\(\).*$/m, () => mock)
        .replace('log=/var/log/tarkovstats-warmup-batch.json', `log=${quote(path + '/warmup.json')}`);
      const file = join(dir, 'queue.sh');
      await writeFile(file, script.replaceAll('\r\n','\n'));
      const result = spawnSync(shell, [file], { env: { ...process.env, SCENARIO: scenario }, encoding: 'utf8', timeout: 10_000 });
      assert.ifError(result.error);
      assert.equal(result.status, scenario === 'persistent' || scenario === 'invalid' ? 1 : scenario === 'stopped' ? 143 : 0, result.stderr);
      assert.deepEqual((await readFile(join(dir, 'calls'),'utf8')).trim().split(/\r?\n/),
        scenario === 'budget' ? ['regular'] : [...Array(scenario === 'retry' || scenario === 'persistent' ? 2 : 1).fill('regular'), 'pve','arena','seasonal','warmup']);
      if (scenario === 'budget') assert.match(result.stdout, /status=deferred-budget/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
  const dropIn = await readFile('ops/systemd/tarkovstats-profile-queue-no-restart.conf','utf8');
  assert.match(dropIn, /^Restart=no$/m);
});
