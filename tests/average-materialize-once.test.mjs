import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const materialize = (directory) => spawnSync(process.execPath, [
  '--experimental-strip-types', '--experimental-sqlite', '--experimental-loader',
  './scripts/ts-alias-loader.mjs', 'scripts/materialize-average-publications.mjs',
], {
  cwd: process.cwd(), encoding: 'utf8', timeout: 120_000,
  env: {
    ...process.env, AVERAGE_MATERIALIZE_ONCE: 'true', AVERAGE_PUBLICATIONS_ENABLED: 'true',
    SQLITE_PATH: join(directory, 'players.db'),
    AVERAGE_PUBLICATION_SQLITE_PATH: join(directory, 'publications.db'),
  },
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
