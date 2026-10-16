import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

const materialize = (directory) => spawnSync(process.execPath, [
  '--experimental-strip-types', '--experimental-sqlite', '--experimental-loader',
  './scripts/ts-alias-loader.mjs', 'scripts/materialize-average-publications.mjs',
], {
  cwd: process.cwd(), encoding: 'utf8', timeout: 120_000,
  env: {
    ...process.env, AVERAGE_MATERIALIZE_ONCE: 'true', AVERAGE_PUBLICATIONS_ENABLED: 'true',
    // Pin the seasonal flag so an ambient seasonal cycle cannot add a `seasonal:<cycle>` scope.
    SEASONAL_ENABLED: 'false',
    SQLITE_PATH: join(directory, 'players.db'),
    AVERAGE_PUBLICATION_SQLITE_PATH: join(directory, 'publications.db'),
  },
});

test('a one-shot average publication reports an active Arena lease so the daily service retries', () => {
  const directory = mkdtempSync(join(tmpdir(), 'average-once-deferred-'));
  try {
    const db = new DatabaseSync(join(directory, 'players.db'));
    db.exec('CREATE TABLE arena_profile_sync_lease (id INTEGER PRIMARY KEY, heartbeat_at INTEGER);');
    db.prepare('INSERT INTO arena_profile_sync_lease VALUES (1, ?)').run(Date.now());
    db.close();
    const deferred = materialize(directory);
    assert.ifError(deferred.error);
    assert.equal(deferred.status, 75, deferred.stdout + deferred.stderr);
    assert.match(deferred.stderr, /publication deferred.*lease is active/);
    assert.doesNotMatch(deferred.stdout, /average publication completed/);

    const source = new DatabaseSync(join(directory, 'players.db'));
    source.exec('DELETE FROM arena_profile_sync_lease');
    source.close();
    const retried = materialize(directory);
    assert.ifError(retried.error);
    assert.equal(retried.status, 0, retried.stdout + retried.stderr);
    assert.match(retried.stdout, /average publication completed/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a one-shot average publication reports failure and still succeeds when every scope publishes', () => {
  const broken = mkdtempSync(join(tmpdir(), 'average-once-failed-'));
  const healthy = mkdtempSync(join(tmpdir(), 'average-once-published-'));
  try {
    // A source database the store cannot open fails every scope.
    writeFileSync(join(broken, 'players.db'), 'not a database');
    const failed = materialize(broken);
    assert.ifError(failed.error);
    assert.notEqual(failed.status, 0, `stdout: ${failed.stdout} stderr: ${failed.stderr}`);
    for (const scope of ['regular', 'pve', 'arena']) {
      assert.match(failed.stderr, new RegExp(`average publication failed \\(startup\\).*${scope}`, 's'));
    }

    // An empty source database is still a working one: every scope publishes.
    const published = materialize(healthy);
    assert.ifError(published.error);
    assert.equal(published.status, 0, `stdout: ${published.stdout} stderr: ${published.stderr}`);
    for (const scope of ['regular', 'pve', 'arena']) {
      assert.match(published.stdout, new RegExp(`average publication completed \\(startup\\).*${scope}`, 's'));
    }
    assert.doesNotMatch(published.stderr, /average publication failed/);
  } finally {
    rmSync(broken, { recursive: true, force: true });
    rmSync(healthy, { recursive: true, force: true });
  }
});
