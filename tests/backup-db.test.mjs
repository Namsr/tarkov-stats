import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile, utimes, unlink } from 'node:fs/promises';
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
  if (scenario === 'wal-full') await writeFile(join(volume, 'players.db-wal'), Buffer.alloc(4096));

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
      elif [ "$SCENARIO" = snapshot-only-space ]; then echo 'fixture 2000000 1 1048587 48% volume'
      elif [ "$SCENARIO" = below-reserve ]; then echo 'fixture 2000000 1 1048575 48% volume'
      elif [ "$SCENARIO" = estimate-full ]; then echo 'fixture 2000000 1 1048584 48% volume'
      elif [ "$SCENARIO" = wal-full ]; then echo 'fixture 2000000 1 1048586 48% volume'
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
          if [ "$SCENARIO" = gzip-fail ]; then return 1; fi
          "$TEST_NODE" --experimental-sqlite -e "$1" "$2";;
        *) return 99;;
      esac
    }
    runner() {
      echo "runner $*" >> calls
      docker exec "$@"
    }
  `;
  const script = source.replace('DIR=/opt/tarkovstats/backups', `DIR='${backups.replaceAll('\\', '/')}'\n${mock}`)
    .replace('/usr/local/sbin/tarkovstats-run-background', 'runner')
    .replace('exec 8>/run/tarkovstats-data-sync.lock', 'exec 8>"$DIR/../data-sync.lock"')
    .replace('exec 7>/run/tarkovstats-leaderboard.lock', 'exec 7>"$DIR/../leaderboard.lock"')
    .replace('const source = `/data/${name}.db`;', 'const source = `${process.env.TEST_VOLUME}/${name}.db`;')
    .replace('const target = "/data/.tarkovstats-backup.db";', 'const target = `${process.env.TEST_VOLUME}/.tarkovstats-backup.db`;')
    .replace('const space = fs.statfsSync(target);', 'const space = process.env.SCENARIO === "compression-full" ? { bavail: 0, bsize: 4096 } : fs.statfsSync(target);');
  for (const path of ['/opt/tarkovstats/backups', '/run/tarkovstats-data-sync.lock', '/run/tarkovstats-leaderboard.lock', '/usr/local/sbin/tarkovstats-run-background', '/data/']) {
    assert.ok(!script.includes(path), `backup sandbox left production path ${path}`);
  }
  const file = join(dir, 'backup.sh');
  await writeFile(file, script.replaceAll('\r\n', '\n'));
  return { dir, volume, backups, file, env: {
    ...process.env, SCENARIO: scenario, TEST_VOLUME: volume.replaceAll('\\', '/'), TEST_NODE: process.execPath.replaceAll('\\', '/'),
  } };
}

for (const scenario of ['success', 'snapshot-only-space', 'sqlite-fail', 'gzip-fail', 'verify-fail', 'disk-full', 'below-reserve', 'estimate-full', 'wal-full', 'compression-full', 'invalid-volume']) {
  test(`backup verifies publication and retains the last good set: ${scenario}`, { timeout: 20_000 }, async () => {
    const f = await fixture(scenario);
    try {
      const result = spawnSync(shell, [f.file], { cwd: f.dir, env: f.env, encoding: 'utf8', timeout: 10_000 });
      assert.ifError(result.error);
      const success = ['success', 'snapshot-only-space'].includes(scenario);
      assert.equal(result.status === 0, success, `${scenario}: ${result.stderr}`);
      const entries = await readdir(f.backups);
      const sets = entries.filter((name) => name.startsWith('backup-'));
      const calls = await readFile(join(f.dir, 'calls'), 'utf8');
      assert.match(calls, /renice -n 19 -p \d+/);
      assert.match(calls, /ionice -c 3 -p \d+/);
      assert.ok(calls.indexOf('flock 8') < calls.indexOf('flock 7'));
      assert.ok(calls.indexOf('flock 7') < calls.indexOf('docker volume'));
      assert.equal(await readFile(join(f.backups, 'source-before.tar.gz'), 'utf8'), 'unrelated operator archive');
      if (success) {
        assert.equal(sets.length, 1);
        assert.match(calls, /runner worker nice -n 19 ionice -c 3 node/);
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
        if (scenario === 'estimate-full') {
          assert.match(result.stdout, /archive_estimate_source=latest_completed/);
          assert.match(result.stderr, /insufficient estimated free space/);
          assert.doesNotMatch(calls, /runner worker/);
        }
        if (scenario === 'wal-full') {
          assert.match(result.stdout, /wal_bytes=4096/);
          assert.match(result.stderr, /wal=4096/);
          assert.doesNotMatch(calls, /runner worker/);
        }
      }
      await assert.rejects(access(join(f.backups, '.tarkovstats-backup-pending')), { code: 'ENOENT' });
      await assert.rejects(access(join(f.volume, '.tarkovstats-backup.db')), { code: 'ENOENT' });
      await assert.rejects(access(join(f.volume, '.tarkovstats-backup.db.gz')), { code: 'ENOENT' });
    } finally { await rm(f.dir, { recursive: true, force: true }); }
  });
}

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


test('backup age probe detects missing and stale complete sets without starting a worker', async () => {
  const f = await fixture('success');
  try {
    const check = () => spawnSync(shell, [f.file, '--check-age'], { cwd: f.dir, env: f.env, encoding: 'utf8', timeout: 10_000 });
    assert.equal(check().status, 0);
    const old = new Date(Date.now() - 40 * 60 * 60_000);
    for (const set of ['backup-old-1', 'backup-old-2']) await utimes(join(f.backups, set, '.complete'), old, old);
    const stale = check();
    assert.equal(stale.status, 1);
    assert.match(stale.stdout, /BACKUP_STATUS at=\d+ latest_completed=\d+ age_seconds=\d+/);
    const calls = await readFile(join(f.dir, 'calls'), 'utf8').catch(() => '');
    assert.doesNotMatch(calls, /docker|runner|flock/);
    for (const set of ['backup-old-1', 'backup-old-2']) await unlink(join(f.backups, set, '.complete'));
    const missing = check();
    assert.equal(missing.status, 1);
    assert.match(missing.stdout, /latest_completed=0/);
    assert.equal((await readdir(f.backups)).filter((name) => name.startsWith('backup-')).length, 2);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('backup age probe ignores marked sets with missing or empty archives', async () => {
  const f = await fixture('success');
  try {
    const validAt = new Date(Date.now() - 60_000);
    for (const set of ['backup-old-1', 'backup-old-2']) {
      await utimes(join(f.backups, set, '.complete'), validAt, validAt);
    }
    const sourceSet = join(f.backups, 'backup-old-1');
    const missingSet = join(f.backups, 'backup-new-missing');
    await mkdir(missingSet);
    for (const name of databases.slice(0, -1)) {
      await writeFile(join(missingSet, `${name}.db.gz`), await readFile(join(sourceSet, `${name}.db.gz`)));
    }
    await writeFile(join(missingSet, '.complete'), '');
    const emptySet = join(f.backups, 'backup-new-empty');
    await mkdir(emptySet);
    for (const name of databases) {
      await writeFile(join(emptySet, `${name}.db.gz`), await readFile(join(sourceSet, `${name}.db.gz`)));
    }
    await writeFile(join(emptySet, 'progression.db.gz'), '');
    await writeFile(join(emptySet, '.complete'), '');
    const invalidAt = new Date(Date.now() + 7 * 24 * 60 * 60_000);
    for (const set of ['backup-new-missing', 'backup-new-empty']) {
      await utimes(join(f.backups, set, '.complete'), invalidAt, invalidAt);
    }
    const check = spawnSync(shell, [f.file, '--check-age'], { cwd: f.dir, env: f.env, encoding: 'utf8', timeout: 10_000 });
    assert.equal(check.status, 0, check.stderr);
    assert.match(check.stdout, new RegExp(`latest_completed=${Math.floor(validAt.getTime() / 1000)}\\b`));
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('backup failure diagnostics expose the storage budget and service retries are bounded', async () => {
  const f = await fixture('disk-full');
  try {
    const result = spawnSync(shell, [f.file], { cwd: f.dir, env: f.env, encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /BACKUP_SPACE at=\d+ database=players db_bytes=\d+ wal_bytes=0 archive_estimate_bytes=\d+ archive_estimate_source=latest_completed available_kb=1 required_kb=\d+ reserve_kb=1048576/);
    assert.match(result.stderr, /retaining previous set/);
    const service = await readFile('ops/systemd/tarkovstats-backup.service', 'utf8');
    const timer = await readFile('ops/systemd/tarkovstats-backup.timer', 'utf8');
    assert.match(service, /StartLimitIntervalSec=1d/);
    assert.match(service, /StartLimitBurst=3/);
    assert.match(service, /Restart=on-failure\r?\nRestartSec=1h/);
    for (const dependency of ['daily-cycle', 'leaderboard-materialize', 'publications']) {
      assert.match(service, new RegExp('^After=.*tarkovstats-' + dependency + '\\.service', 'm'));
    }
    assert.doesNotMatch(service, /^(Requires|Wants)=.*tarkovstats-(daily-cycle|publications)/m, 'backup must not start another nightly scan');
    assert.match(service, /ExecStartPost=.* --check-age/);
    assert.match(timer, /OnCalendar=\*-\*-\* 04:10:00 UTC/);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});
