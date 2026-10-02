import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { gzipSync, gunzipSync } from 'node:zlib';
import test from 'node:test';

const shell = process.platform === 'win32'
  ? resolve(execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(), '../../../bin/bash.exe') : '/bin/sh';
const databases = ['players', 'bans', 'progression', 'community-reports', 'admin-analytics'];

async function fixture(scenario) {
  const dir = await mkdtemp(join(tmpdir(), 'backup-behavior-'));
  const volume = join(dir, 'volume');
  const backups = join(dir, 'backups');
  await mkdir(volume);
  await mkdir(backups);
  for (const name of databases) {
    const db = new DatabaseSync(join(volume, `${name}.db`));
    try {
      db.exec('CREATE TABLE fixture (name TEXT);');
      db.prepare('INSERT INTO fixture VALUES (?)').run(name);
    } finally { db.close(); }
  }
  for (const old of ['backup-old-1', 'backup-old-2']) {
    const path = join(backups, old);
    await mkdir(path);
    for (const name of databases) {
      await writeFile(join(path, `${name}.db.gz`), gzipSync(await readFile(join(volume, `${name}.db`))));
    }
    await writeFile(join(path, '.complete'), '');
  }
  await writeFile(join(backups, 'source-before.tar.gz'), 'unrelated operator archive');
  await writeFile(join(backups, 'players-20261001-040001.db.gz'), 'former database backup');
  if (scenario === 'sqlite-fail') await writeFile(join(volume, 'progression.db'), 'invalid sqlite');

  const source = await readFile('ops/backup-db.sh', 'utf8');
  const mock = `
    renice() { echo "renice $*" >> calls; }
    ionice() { echo "ionice $*" >> calls; }
    flock() {
      echo "flock $*" >> calls
      if [ "$SCENARIO" = sync-wait ] && [ "$*" = 8 ]; then
        touch waiting
        while [ ! -f release ]; do sleep 0.05; done
      fi
    }
    df() {
      echo 'Filesystem 1024-blocks Used Available Capacity Mounted'
      if [ "$SCENARIO" = disk-full ]; then echo 'fixture 1000 999 1 99% volume'
      else echo 'fixture 100000000 1 99999999 1% volume'; fi
    }
    gzip() {
      echo "gzip $*" >> calls
      if [ "$SCENARIO" = gzip-fail ] && [ "$1" = -c ]; then return 1; fi
      if [ "$SCENARIO" = verify-fail ] && [ "$1" = -t ]; then return 1; fi
      command gzip "$@"
    }
    docker() {
      echo "docker $*" >> calls
      case "$1" in
        volume) if [ "$SCENARIO" = invalid-volume ]; then echo /; else echo "$TEST_VOLUME"; fi;;
        exec)
          while [ "$#" -gt 0 ] && [ "$1" != -e ]; do shift; done
          [ "$#" -ge 3 ] || return 99
          shift
          "$TEST_NODE" --experimental-sqlite -e "$1" "$2";;
        *) return 99;;
      esac
    }
  `;
  const script = source.replace('DIR=/opt/tarkovstats/backups', `DIR='${backups.replaceAll('\\', '/')}'\n${mock}`)
    .replace('exec 8>/run/tarkovstats-data-sync.lock', 'exec 8>"$DIR/../data-sync.lock"')
    .replace('exec 7>/run/tarkovstats-leaderboard.lock', 'exec 7>"$DIR/../leaderboard.lock"')
    .replace('const source = `/data/${name}.db`;', 'const source = `${process.env.TEST_VOLUME}/${name}.db`;')
    .replace('const target = "/data/.tarkovstats-backup.db";', 'const target = `${process.env.TEST_VOLUME}/.tarkovstats-backup.db`;');
  for (const path of ['/opt/tarkovstats/backups', '/run/tarkovstats-data-sync.lock', '/run/tarkovstats-leaderboard.lock', '/data/']) {
    assert.ok(!script.includes(path), `backup sandbox left production path ${path}`);
  }
  const file = join(dir, 'backup.sh');
  await writeFile(file, script.replaceAll('\r\n', '\n'));
  return { dir, volume, backups, file, env: {
    ...process.env, SCENARIO: scenario, TEST_VOLUME: volume.replaceAll('\\', '/'), TEST_NODE: process.execPath.replaceAll('\\', '/'),
  } };
}

test('backup publishes exactly one restorable set and retains the last good set on failure', { timeout: 60_000 }, async () => {
  for (const scenario of ['success', 'sqlite-fail', 'gzip-fail', 'verify-fail', 'disk-full', 'invalid-volume']) {
    const f = await fixture(scenario);
    try {
      const result = spawnSync(shell, [f.file], { cwd: f.dir, env: f.env, encoding: 'utf8', timeout: 10_000 });
      assert.ifError(result.error);
      assert.equal(result.status === 0, scenario === 'success', `${scenario}: ${result.stderr}`);
      const entries = await readdir(f.backups);
      const sets = entries.filter((name) => name.startsWith('backup-'));
      const calls = await readFile(join(f.dir, 'calls'), 'utf8');
      assert.match(calls, /renice -n 19 -p \d+/);
      assert.match(calls, /ionice -c 3 -p \d+/);
      assert.ok(calls.indexOf('flock 8') < calls.indexOf('flock 7'));
      assert.ok(calls.indexOf('flock 7') < calls.indexOf('docker volume'));
      assert.equal(await readFile(join(f.backups, 'source-before.tar.gz'), 'utf8'), 'unrelated operator archive');
      if (scenario === 'success') {
        assert.equal(sets.length, 1);
        assert.match(calls, /docker exec tarkovstats-web-1 nice -n 19 ionice -c 3 node/);
        assert.doesNotMatch(sets[0], /old/);
        assert.equal((await readdir(join(f.backups, sets[0]))).length, databases.length + 1);
        for (const name of databases) {
          const archive = await readFile(join(f.backups, sets[0], `${name}.db.gz`));
          const restored = join(f.dir, `restored-${name}.db`);
          await writeFile(restored, gunzipSync(archive));
          const db = new DatabaseSync(restored, { readOnly: true });
          try { assert.equal(db.prepare('SELECT name FROM fixture').get().name, name); }
          finally { db.close(); }
        }
        assert.ok(!entries.includes('players-20261001-040001.db.gz'));
      } else {
        assert.deepEqual(sets.sort(), ['backup-old-1', 'backup-old-2']);
        for (const set of sets) {
          assert.equal((await readdir(join(f.backups, set))).length, databases.length + 1);
          await access(join(f.backups, set, '.complete'));
        }
        assert.ok(entries.includes('players-20261001-040001.db.gz'));
      }
      await assert.rejects(access(join(f.backups, '.tarkovstats-backup-pending')), { code: 'ENOENT' });
      await assert.rejects(access(join(f.volume, '.tarkovstats-backup.db')), { code: 'ENOENT' });
    } finally { await rm(f.dir, { recursive: true, force: true }); }
  }
});

test('backup waits for the shared sync lock before creating snapshots', { timeout: 20_000 }, async () => {
  const f = await fixture('sync-wait');
  const child = spawn(shell, [f.file], { cwd: f.dir, env: f.env, stdio: 'pipe' });
  const closed = once(child, 'close');
  let stderr = '';
  child.stderr.on('data', (data) => { stderr += data; });
  try {
    let waiting = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { await access(join(f.dir, 'waiting')); waiting = true; break; } catch { await delay(20); }
    }
    assert.ok(waiting, stderr);
    await assert.rejects(access(join(f.volume, '.tarkovstats-backup.db')), { code: 'ENOENT' });
    await assert.rejects(access(join(f.backups, '.tarkovstats-backup-pending')), { code: 'ENOENT' });
    await writeFile(join(f.dir, 'release'), '');
    const [code] = await closed;
    assert.equal(code, 0, stderr);
    assert.equal((await readdir(f.backups)).filter((name) => name.startsWith('backup-')).length, 1);
  } finally {
    child.kill();
    await closed;
    await rm(f.dir, { recursive: true, force: true });
  }
});
