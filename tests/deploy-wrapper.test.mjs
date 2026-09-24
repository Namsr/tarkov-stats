import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
const shell = process.platform === 'win32'
  ? resolve(execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(), '../../../bin/bash.exe') : '/bin/sh';

test('deploy uses live revision and rolls back build, signal and startup failures', async () => {
  const source = await readFile('ops/deploy.sh', 'utf8');
  for (const scenario of ['current', 'checkout-ahead', 'sync-busy', 'build-fail', 'signal', 'start-fail', 'health-fail']) {
    const dir = await mkdtemp(join(tmpdir(), 'deploy-behavior-'));
    try {
      const mock = `
      git() {
        echo "git $*" >> calls
        case "$*" in
          'rev-parse HEAD') echo remote;;
          'rev-parse origin/main') echo remote;;
        esac
      }
      docker() {
        echo "docker $*" >> calls
        case "$*" in
          *'ps -q web') echo web;;
          *inspect*)
            case "$*" in
              *'.Image'*) echo old-image;;
              *) if [ "$SCENARIO" = current ] || [ -f started ]; then echo remote; else echo old; fi;;
            esac;;
          *'build --build-arg'*)
            if [ "$SCENARIO" = build-fail ]; then return 3; fi
            if [ "$SCENARIO" = signal ]; then kill -TERM $$; fi;;
          *'up -d --no-build web')
            if [ "$SCENARIO" = start-fail ]; then return 4; fi
            touch started;;
          *'exec -T web node'*) [ "$SCENARIO" != health-fail ];;
        esac
      }
      logger() { echo "logger $*" >> calls; }
      flock() { echo "flock $*" >> calls; if [ "$SCENARIO" = sync-busy ]; then return 1; fi; return 0; }
      sleep() { :; }
      `;
      const script = source.replace('APP=/opt/tarkovstats-auto', () => `APP='${dir.replaceAll('\\','/')}'\n${mock}`)
        .replace('exec 9>/run/tarkovstats-data-sync.lock', 'exec 9>"$APP/data-sync.lock"')
        .replace('state=/var/lib/tarkovstats-deploy', 'state="$APP/state"');
      const file = join(dir,'deploy.sh');
      await writeFile(file, script.replaceAll('\r\n','\n'));
      const result = spawnSync(shell,[file],{env:{...process.env, SCENARIO:scenario},encoding:'utf8',timeout:10_000});
      assert.ifError(result.error);
      const calls=await readFile(join(dir,'calls'),'utf8');
      assert.equal(result.status === 0, ['current','checkout-ahead'].includes(scenario), `${scenario}: ${result.stderr}\n${calls}`);
      if (scenario === 'sync-busy') {
        assert.equal(result.status, 75);
        assert.doesNotMatch(calls,/build --build-arg/);
        assert.doesNotMatch(calls,/git reset --hard/);
      } else if(scenario==='current') {
        assert.doesNotMatch(calls,/build --build-arg/);
        assert.doesNotMatch(calls,/^flock /m);
      } else assert.match(calls,/build --build-arg SOURCE_REVISION=remote/);
      if(!['current','checkout-ahead','sync-busy'].includes(scenario)) {
        assert.match(calls,/git reset --hard remote/);
        assert.match(calls,/image tag old-image tarkovstats-web/);
      }
      if(scenario==='signal') assert.equal(result.status,143, result.stderr + '\n' + calls);
      if (scenario === 'build-fail') {
        await writeFile(join(dir, 'calls'), '');
        const retry = spawnSync(shell, [file], { env: { ...process.env, SCENARIO: scenario }, encoding: 'utf8', timeout: 10_000 });
        assert.equal(retry.status, 0);
        assert.doesNotMatch(await readFile(join(dir, 'calls'), 'utf8'), /build --build-arg/);
      }
    } finally { await rm(dir,{recursive:true,force:true}); }
  }
});
