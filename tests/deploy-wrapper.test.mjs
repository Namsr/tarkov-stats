import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
const shell = process.platform === 'win32'
  ? resolve(execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(), '../../../bin/bash.exe') : '/bin/sh';

// Rewrites the production APP, data-sync lock and state paths in ops/deploy.sh
// to a temp dir so the spawned script exercises deploy logic, not the VPS. The
// rewrites are literal string replacements, so a reworded or requoted line
// silently no-ops and spawns deploy logic against the real production paths.
function sandboxDeployScript(source, dir, mock) {
  const target = dir.replaceAll('\\', '/');
  const script = source.replace('APP=/opt/tarkovstats-auto', () => `APP='${target}'\n${mock}`)
    .replaceAll('exec 9>/run/tarkovstats-data-sync.lock', 'exec 9>"$APP/data-sync.lock"')
    .replace('state=/var/lib/tarkovstats-deploy', 'state="$APP/state"');
  for (const [applied, rewritten] of [
    [`APP='${target}'`, 'sets APP=/opt/tarkovstats-auto'],
    ['exec 9>"$APP/data-sync.lock"', 'opens exec 9>/run/tarkovstats-data-sync.lock'],
    ['state="$APP/state"', 'sets state=/var/lib/tarkovstats-deploy'],
  ]) assert.ok(script.includes(applied), `sandbox rewrite did not apply: ops/deploy.sh no longer ${rewritten}`);
  for (const production of ['/opt/tarkovstats-auto', '/run/tarkovstats-data-sync.lock', '/var/lib/tarkovstats-deploy'])
    assert.ok(!script.includes(production), `sandbox rewrite left the production path ${production} in the spawned script`);
  return script;
}

test('deploy uses live revision and rolls back build, signal and startup failures', async () => {
  const source = await readFile('ops/deploy.sh', 'utf8');
  const compose = await readFile('ops/docker-compose.vps.yml', 'utf8');
  const builderUnit = await readFile('ops/systemd/tarkovstats-deploy-limited-builder.conf', 'utf8');
  assert.doesNotMatch(compose, /NEXT_PUBLIC_TURNSTILE_SITE_KEY/);
  assert.doesNotMatch(builderUnit, /ExecStopPost/);
  assert.match(builderUnit, /# Install as \/etc\/systemd\/system\/tarkovstats-deploy\.service\.d\//);
  for (const scenario of ['current', 'current-sick', 'current-redirect', 'current-no-ip', 'current-unreachable', 'current-sync-busy', 'current-restart-fail', 'checkout-ahead', 'tag-fail', 'sync-busy', 'build-fail', 'signal', 'start-fail', 'health-fail', 'no-builder']) {
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
              *'.NetworkSettings.Networks'*)
                if [ "$SCENARIO" != current-no-ip ]; then echo 172.18.0.3; fi;;
              *'.Image'*) echo old-image;;
              *) case "$SCENARIO" in current*) echo remote;; *) if [ -f started ]; then echo remote; else echo old; fi;; esac;;
            esac;;
          *'build --build-arg'*)
            if [ "$SCENARIO" = build-fail ]; then return 3; fi
            if [ "$SCENARIO" = signal ]; then kill -TERM $$; fi;;
          *'up -d --no-build web')
            if [ "$SCENARIO" = start-fail ]; then return 4; fi
            touch started;;
          *'restart -t 10 web')
            if [ "$SCENARIO" = current-restart-fail ]; then return 4; fi;;
          *'image tag old-image tarkovstats-web-previous')
            if [ "$SCENARIO" = tag-fail ]; then return 1; fi;;
        esac
      }
      curl() {
        echo "curl $*" >> calls
        case "$SCENARIO" in
          current-redirect) echo 308;;
          current-unreachable) return 7;;
          current-*|health-fail) echo 503;;
          *) echo 200;;
        esac
      }
      logger() { echo "logger $*" >> calls; }
      flock() { echo "flock $*" >> calls; if [ "$SCENARIO" = sync-busy ] || [ "$SCENARIO" = current-sync-busy ]; then return 1; fi; return 0; }
      sleep() { :; }
      `;
      const script = sandboxDeployScript(source, dir, mock);
      const file = join(dir,'deploy.sh');
      await writeFile(file, script.replaceAll('\r\n','\n'));
      const result = spawnSync(shell,[file],{env:{...process.env, SCENARIO:scenario, BUILDX_BUILDER:scenario==='no-builder'?'':'tarkovstats-limited'},encoding:'utf8',timeout:10_000});
      assert.ifError(result.error);
      const calls=await readFile(join(dir,'calls'),'utf8');
      const current = scenario.startsWith('current');
      assert.equal(result.status === 0, current || ['checkout-ahead','tag-fail','no-builder'].includes(scenario), `${scenario}: ${result.stderr}\n${calls}`);
      assert.doesNotMatch(calls, /exec -T web node/);
      if ((current && scenario !== 'current-no-ip') || ['checkout-ahead','tag-fail','health-fail','no-builder'].includes(scenario)) {
        assert.match(calls, /curl .*--noproxy \* .*--max-time 5 .*http:\/\/172\.18\.0\.3:3000\/healthz/);
      }
      if (scenario === 'sync-busy') {
        assert.equal(result.status, 75);
        assert.doesNotMatch(calls,/build --build-arg/);
        assert.doesNotMatch(calls,/git reset --hard/);
        assert.doesNotMatch(calls,/buildx stop/);
      } else if(current) {
        assert.doesNotMatch(calls,/build --build-arg/);
        assert.doesNotMatch(calls,/^flock /m);
        assert.doesNotMatch(calls,/buildx stop/);
      } else assert.match(calls,/build --build-arg SOURCE_REVISION=remote/);
      if (scenario === 'no-builder') {
        assert.doesNotMatch(calls,/buildx stop/);
        assert.match(calls,/limited builder not reclaimed/);
        assert.doesNotMatch(calls,/^git reset --hard/m);
      } else if (!current && scenario !== 'sync-busy') assert.match(calls,/buildx stop tarkovstats-limited/);
      if (scenario === 'checkout-ahead') {
        assert.match(calls,/image tag old-image tarkovstats-web-previous/);
        assert.match(calls,/image prune -f --filter until=24h/);
      } else if (scenario === 'tag-fail') {
        assert.match(calls,/image tag old-image tarkovstats-web-previous/);
        assert.doesNotMatch(calls,/image prune -f --filter until=24h/);
      }
      else if (scenario !== 'no-builder') assert.doesNotMatch(calls,/image prune -f --filter until=24h/);
      if(!current && !['checkout-ahead','tag-fail','sync-busy','no-builder'].includes(scenario)) {
        assert.match(calls,/git reset --hard remote/);
        assert.match(calls,/image tag old-image tarkovstats-web/);
      }
      if(scenario==='signal') assert.equal(result.status,143, result.stderr + '\n' + calls);
      if (scenario === 'build-fail') {
        await writeFile(join(dir, 'calls'), '');
        const retry = spawnSync(shell, [file], { env: { ...process.env, SCENARIO: scenario, BUILDX_BUILDER: 'tarkovstats-limited' }, encoding: 'utf8', timeout: 10_000 });
        assert.equal(retry.status, 0);
        assert.doesNotMatch(await readFile(join(dir, 'calls'), 'utf8'), /build --build-arg/);
      }
      if (current && scenario !== 'current') {
        for (let probe = 2; probe <= 6; probe++) {
          const retry = spawnSync(shell, [file], { env: { ...process.env, SCENARIO: scenario, BUILDX_BUILDER: 'tarkovstats-limited' }, encoding: 'utf8', timeout: 10_000 });
          assert.ifError(retry.error);
          const expected = scenario === 'current-sync-busy' && probe >= 3 ? 75
            : scenario === 'current-restart-fail' && probe === 3 ? 4 : 0;
          assert.equal(retry.status, expected, `${scenario} probe ${probe}: ${retry.stderr}`);
        }
        const recoveryCalls = await readFile(join(dir, 'calls'), 'utf8');
        assert.doesNotMatch(recoveryCalls, /build --build-arg|buildx stop|git reset --hard/);
        assert.equal((recoveryCalls.match(/restart -t 10 web/g) ?? []).length, scenario === 'current-sync-busy' ? 0 : 1);
        if (scenario !== 'current-sync-busy') assert.match(recoveryCalls, /restart cooldown/);
        const recovered = spawnSync(shell, [file], { env: { ...process.env, SCENARIO: 'current' }, encoding: 'utf8', timeout: 10_000 });
        assert.equal(recovered.status, 0, recovered.stderr);
        const { access } = await import('node:fs/promises');
        await assert.rejects(access(join(dir, 'state', 'unhealthy')), { code: 'ENOENT' });
      }
    } finally { await rm(dir,{recursive:true,force:true}); }
  }
});

test('deploy sandbox rewrite refuses to spawn the production paths', async () => {
  const source = await readFile('ops/deploy.sh', 'utf8');
  const dir = join(tmpdir(), 'deploy-behavior-abc123').replaceAll('\\', '/');
  // Quoting the value is a no-op for the shell and a no-op for the rewrite: a
  // plausible refactor that would otherwise leave APP on the production checkout.
  const refactored = source.replace('APP=/opt/tarkovstats-auto', 'APP="/opt/tarkovstats-auto"');
  assert.notEqual(refactored, source, 'fixture drift: quoting APP must still change the source text');
  assert.throws(() => sandboxDeployScript(refactored, dir, 'git() { :; }'), /sandbox rewrite/);
  const script = sandboxDeployScript(source, dir, 'git() { :; }');
  assert.ok(script.includes(`APP='${dir}'`));
  for (const production of ['/opt/tarkovstats-auto', '/run/tarkovstats-data-sync.lock', '/var/lib/tarkovstats-deploy'])
    assert.ok(!script.includes(production), `sandbox rewrite left the production path ${production} in the spawned script`);
});
