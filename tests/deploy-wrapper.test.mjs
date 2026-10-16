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

test('deploy consumes verified CI images and preserves recovery and rollback', async () => {
  const source = await readFile('ops/deploy.sh', 'utf8');
  const compose = await readFile('ops/docker-compose.vps.yml', 'utf8');
  assert.doesNotMatch(compose, /NEXT_PUBLIC_TURNSTILE_SITE_KEY/);
  assert.match(compose, /image: tarkovstats-web:latest\s+pull_policy: never/);
  const { createHash } = await import('node:crypto');
  const checksum = createHash('sha256').update('fixture').digest('hex');
  const scenarios = ['current', 'current-sick', 'current-redirect', 'current-no-ip',
    'current-unreachable', 'current-sync-busy', 'current-isolated-sync-busy', 'current-restart-fail', 'checkout-ahead',
    'tag-fail', 'sync-busy', 'image-missing', 'download-fail', 'checksum-fail',
    'invalid-checksum', 'multiline-checksum', 'load-fail', 'revision-mismatch', 'tag-target-fail', 'merge-fail',
    'signal', 'start-fail', 'health-fail'];
  for (const scenario of scenarios) {
    const dir = await mkdtemp(join(tmpdir(), 'deploy-behavior-'));
    try {
      const mock = `
      git() {
        echo "git $*" >> "$APP/calls"
        case "$*" in
          'rev-parse HEAD'|'rev-parse origin/main') echo remote;;
          'merge --ff-only origin/main') [ "$SCENARIO" != merge-fail ];;
        esac
      }
      docker() {
        echo "docker $*" >> "$APP/calls"
        case "$*" in
          *'ps -q web') echo web;;
          'image inspect '*) if [ "$SCENARIO" = revision-mismatch ]; then echo wrong; else echo remote; fi;;
          *inspect*)
            case "$*" in
              *'.NetworkSettings.Networks'*) if [ "$SCENARIO" != current-no-ip ]; then echo 172.18.0.3; fi;;
              *'.Image'*) echo old-image;;
              *'.Config.Env'*) if [ "$SCENARIO" = current-isolated-sync-busy ]; then echo WEB_BACKGROUND_WORKERS=false; fi;;
              *) case "$SCENARIO" in current*) echo remote;; *) if [ -f "$APP/started" ]; then echo remote; else echo old; fi;; esac;;
            esac;;
          'image load '*)
            if [ "$SCENARIO" = load-fail ]; then return 3; fi
            if [ "$SCENARIO" = signal ]; then kill -TERM $$; fi;;
          'image tag tarkovstats-web:remote tarkovstats-web:latest') [ "$SCENARIO" != tag-target-fail ];;
          *'up -d --no-build web')
            if [ "$SCENARIO" = start-fail ]; then return 4; fi
            touch "$APP/started";;
          *'restart -t 10 web') [ "$SCENARIO" != current-restart-fail ];;
          'image tag old-image tarkovstats-web-previous') [ "$SCENARIO" != tag-fail ];;
        esac
      }
      curl() {
        echo "curl $*" >> "$APP/calls"
        output=
        while [ "$#" -gt 0 ]; do
          case "$1" in --output) output=$2; shift;; esac
          shift
        done
        case "$output" in
          *.sha256)
            [ "$SCENARIO" != image-missing ] || return 22
            if [ "$SCENARIO" = invalid-checksum ]; then printf 'invalid  /etc/passwd\\n' > "$output"
            elif [ "$SCENARIO" = multiline-checksum ]; then printf '${checksum}  web.tar.gz\\n${checksum}  /etc/passwd\\n' > "$output"
            elif [ "$SCENARIO" = checksum-fail ]; then printf '%064d  web.tar.gz\\n' 0 > "$output"
            else printf '${checksum}  web.tar.gz\\n' > "$output"; fi;;
          */web.tar.gz)
            [ "$SCENARIO" != download-fail ] || return 22
            printf fixture > "$output";;
          /dev/null)
            case "$SCENARIO" in
              current-redirect) echo 308;; current-unreachable) return 7;;
              current-*|health-fail) echo 503;; *) echo 200;;
            esac;;
          *) return 90;;
        esac
      }
      logger() { echo "logger $*" >> "$APP/calls"; }
      flock() { echo "flock $*" >> "$APP/calls"; [ "$SCENARIO" != sync-busy ] && [ "$SCENARIO" != current-sync-busy ] && [ "$SCENARIO" != current-isolated-sync-busy ]; }
      sleep() { :; }
      `;
      const script = sandboxDeployScript(source, dir, mock);
      const file = join(dir, 'deploy.sh');
      await writeFile(file, script.replaceAll('\r\n', '\n'));
      const run = (value = scenario) => spawnSync(shell, [file], {
        env: { ...process.env, SCENARIO: value }, encoding: 'utf8', timeout: 10_000,
      });
      const result = run();
      assert.ifError(result.error);
      const calls = await readFile(join(dir, 'calls'), 'utf8');
      const current = scenario.startsWith('current');
      const succeeds = current || ['checkout-ahead', 'tag-fail', 'image-missing'].includes(scenario);
      assert.equal(result.status === 0, succeeds, `${scenario}: ${result.stderr}\n${calls}`);
      assert.doesNotMatch(calls, /compose .*build --|buildx|docker pull|exec -T web node/);
      if ((current && scenario !== 'current-no-ip') || ['checkout-ahead', 'tag-fail', 'health-fail'].includes(scenario)) {
        assert.match(calls, /curl .*--noproxy \* .*--max-time 5 .*http:\/\/172\.18\.0\.3:3000\/healthz/);
      }
      if (scenario === 'sync-busy') {
        assert.equal(result.status, 75);
        assert.doesNotMatch(calls, /releases\/download|git reset --hard|git merge/);
      } else if (current) {
        assert.doesNotMatch(calls, /releases\/download|^flock /m);
      } else {
        assert.match(calls, /--proto =https --proto-redir =https .*container-remote\/web.tar.gz.sha256/);
        if (scenario === 'image-missing') {
          assert.doesNotMatch(calls, /image load|git reset --hard|git merge|up -d|image prune/);
          assert.match(calls, /ready image unavailable/);
          assert.equal(run().status, 0, 'missing images must retry without the failure cooldown');
          const repeated = await readFile(join(dir, 'calls'), 'utf8');
          assert.equal((repeated.match(/container-remote\/web.tar.gz.sha256/g) ?? []).length, 2);
        } else if (['download-fail', 'checksum-fail', 'invalid-checksum', 'multiline-checksum'].includes(scenario)) {
          assert.doesNotMatch(calls, /image load|git merge|up -d/);
        } else if (['load-fail', 'revision-mismatch', 'tag-target-fail', 'signal'].includes(scenario)) {
          assert.doesNotMatch(calls, /git merge|up -d/);
        } else {
          assert.match(calls, /image tag tarkovstats-web:remote tarkovstats-web:latest/);
          assert.ok(calls.indexOf('image inspect') < calls.indexOf('git merge'));
        }
      }
      if (['checkout-ahead', 'tag-fail'].includes(scenario)) {
        assert.match(calls, /image tag old-image tarkovstats-web-previous/);
        if (scenario === 'tag-fail') assert.doesNotMatch(calls, /^docker image prune/m);
        else assert.match(calls, /image prune -f --filter until=24h/);
      } else assert.doesNotMatch(calls, /image prune/);
      if (!succeeds && scenario !== 'sync-busy') {
        assert.match(calls, /git reset --hard remote/);
        assert.match(calls, /image tag old-image tarkovstats-web/);
        await writeFile(join(dir, 'calls'), '');
        assert.equal(run().status, 0, 'failed image/deploy must enter the retry cooldown');
        assert.doesNotMatch(await readFile(join(dir, 'calls'), 'utf8'), /releases\/download|git merge/);
      }
      if (scenario === 'signal') assert.equal(result.status, 143);
      if (!current && scenario !== 'sync-busy') {
        const { readdir } = await import('node:fs/promises');
        assert.deepEqual((await readdir(join(dir, 'state'))).filter((name) => name.startsWith('image.')), [], 'download staging must be cleaned');
      }
      if (current && scenario !== 'current') {
        for (let probe = 2; probe <= 6; probe++) {
          const retry = run();
          assert.ifError(retry.error);
          const expected = scenario === 'current-sync-busy' && probe >= 3 ? 75
            : scenario === 'current-restart-fail' && probe === 3 ? 1 : 0;
          assert.equal(retry.status, expected, `${scenario} probe ${probe}: ${retry.stderr}`);
        }
        const recoveryCalls = await readFile(join(dir, 'calls'), 'utf8');
        assert.doesNotMatch(recoveryCalls, /releases\/download|git reset --hard/);
        assert.equal((recoveryCalls.match(/restart -t 10 web/g) ?? []).length, scenario === 'current-sync-busy' ? 0 : 1);
        if (scenario === 'current-isolated-sync-busy') assert.doesNotMatch(recoveryCalls, /^flock /m);
        if (scenario !== 'current-sync-busy') assert.match(recoveryCalls, /restart cooldown/);
        assert.equal(run('current').status, 0);
        const { access } = await import('node:fs/promises');
        await assert.rejects(access(join(dir, 'state', 'unhealthy')), { code: 'ENOENT' });
      }
    } finally { await rm(dir, { recursive: true, force: true }); }
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
