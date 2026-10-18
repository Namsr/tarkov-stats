import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { runProfileQueue, runCollector, releaseArenaLease, summaryComplete, PROFILE_QUEUE_MODES } from '../scripts/run-profile-queue.mjs';
import { DatabaseSync } from 'node:sqlite';

test('the parent releases only its dead Arena child lease, including a forced stop', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'arena-dead-child-'));
  const file = join(directory, 'players.db');
  const script = `.arena-lease-${randomUUID()}.mjs`;
  const scriptPath = resolve('scripts', script);
  const previous = process.env.SQLITE_PATH;
  const db = new DatabaseSync(file);
  try {
    db.exec('CREATE TABLE arena_profile_sync_lease (id INTEGER PRIMARY KEY, owner TEXT, heartbeat_at INTEGER)');
    db.prepare('INSERT INTO arena_profile_sync_lease VALUES (1,?,0)').run('other-live-owner');
    await releaseArenaLease('dead-owner', file);
    assert.equal(db.prepare('SELECT owner FROM arena_profile_sync_lease').get().owner, 'other-live-owner');
    db.exec('DELETE FROM arena_profile_sync_lease');
    process.env.SQLITE_PATH = file;
    await writeFile(scriptPath, `import {DatabaseSync} from 'node:sqlite';
      const db=new DatabaseSync(process.env.SQLITE_PATH);
      db.prepare('INSERT INTO arena_profile_sync_lease VALUES (1,?,0)').run(process.env.ARENA_PROFILE_SYNC_RUN_ID);
      process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);`);
    const stopped = await runCollector({ ...PROFILE_QUEUE_MODES[0], script }, 700, Date.now() + 10_000);
    assert.equal(stopped.killed, true);
    assert.equal(db.prepare('SELECT count(*) n FROM arena_profile_sync_lease').get().n, 0);
  } finally {
    if (previous === undefined) delete process.env.SQLITE_PATH; else process.env.SQLITE_PATH = previous;
    db.close(); await rm(scriptPath, { force: true }); await rm(directory, { recursive: true, force: true });
  }
});

const shell = process.platform === 'win32'
  ? resolve(execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(), '../../../bin/bash.exe') : '/bin/sh';

test('temporary daytime catch-up uses one-hour jobs from 09 through 21 without replaying missed ticks', async () => {
  const timer = await readFile('ops/systemd/tarkovstats-profile-catchup.timer', 'utf8');
  assert.match(timer, /^OnCalendar=\*-\*-\* 09\.\.21:00:00 Europe\/Moscow$/m);
  assert.match(timer, /^Unit=tarkovstats-profile-catchup\.service$/m);
  assert.match(timer, /^Persistent=false$/m);
  for (const name of ['queue', 'catchup']) {
    const unit = await readFile(`ops/systemd/tarkovstats-profile-${name}.service`, 'utf8');
    assert.match(unit, /flock \/run\/tarkovstats-data-sync\.lock/);
    assert.match(unit, /ExecCondition=.*tarkovstats-public-profile-importer/);
    assert.doesNotMatch(unit, /^OnSuccess=|^OnFailure=/m, 'a skipped ExecCondition cannot retire recovery');
    if (name === 'catchup') assert.match(unit, /sbin\/tarkovstats-profile-queue catchup$/m);
  }
});
const done = () => ({ code: 0, summary: { feedHttpStatus: 200, backlog: 0, attempted: 1, errors: 0 } });
function harness(handler, totalMs = 3_600_000, controller) {
  let clock = 1_000_000;
  const calls = [], events = [];
  return { calls, events, start: clock, now: () => clock,
    run: () => runProfileQueue({ deadline: clock + totalMs, signal: controller?.signal, now: () => clock,
      wait: async ms => { clock += ms; }, emit: (event, fields) => events.push({ event, ...fields }),
      run: async (mode, budget) => {
        calls.push(mode.name);
        const result = await handler(mode, budget, calls);
        clock += result.elapsed ?? 1000;
        return result;
      } }) };
}

test('rounds continue incomplete and failed modes while completed modes are skipped', async () => {
  const counts = new Map();
  const h = harness(mode => {
    const count = (counts.get(mode.name) ?? 0) + 1; counts.set(mode.name, count);
    if (mode.name === 'warmup') return { code: 0, summary: { bounded: true, stopped: false, processed: 100 } };
    if (mode.name === 'arena' && count === 1) return { code: 1, summary: null };
    if (mode.name === 'regular' && count === 1) return { ...done(), summary: { feedHttpStatus: 304, backlog: 3, attempted: 2, errors: 0 } };
    return done();
  });
  const result = await h.run();
  assert.equal(result.ok, true);
  assert.deepEqual(h.calls, ['arena','regular','pve','seasonal','regular','arena','warmup']);
  assert.equal(h.events.filter(x => x.event === 'MODE_RESULT' && x.mode === 'regular')[0].complete, false);
  assert.ok(h.now() - h.start >= 60_000, 'the failed mode waits before its next attempt');
});

test('one shared hour bounds every slice and unfinished modes remain reported', async () => {
  const h = harness((_mode, budget) => ({ code: 0, elapsed: budget,
    summary: { feedHttpStatus: 200, backlog: 10, attempted: 100, errors: 0 } }));
  const result = await h.run();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'deadline');
  assert.deepEqual(h.calls.slice(0,4), ['arena','regular','pve','seasonal']);
  assert.ok(h.calls.filter(x => x === 'arena').length > 1);
  assert.ok(h.now() - h.start <= 3_600_000);
  assert.ok(h.events.filter(x => x.event === 'MODE_START').every(x => x.budgetMs <= 300_000));
  assert.ok(Object.values(result.modes).every(x => !x.complete && x.backlog === 10));
  assert.ok(!h.calls.includes('warmup'));
});

test('a busy night can finish beyond the first hour without repeating completed modes', async () => {
  let arenaTime = 0;
  const h = harness((mode, budget) => {
    if (mode.name === 'warmup') return { code: 0, summary: { bounded: false, stopped: false, processed: 0 } };
    if (mode.name !== 'arena') return done();
    arenaTime += budget;
    return { ...done(), elapsed: budget, summary: { ...done().summary, backlog: arenaTime >= 90 * 60_000 ? 0 : 10 } };
  }, 18_000_000);
  assert.equal((await h.run()).ok, true);
  assert.ok(h.now() - h.start > 3_600_000);
  assert.ok(h.now() - h.start < 18_000_000);
  for (const mode of ['regular', 'pve', 'seasonal']) assert.equal(h.calls.filter(name => name === mode).length, 1);
});

test('obsolete upstream targets stay visible as deferred in the completed queue', async () => {
  const h = harness(mode => mode.name === 'regular' ? { ...done(), summary: { ...done().summary, deferred: 3 } }
    : mode.name === 'warmup' ? { code: 0, summary: { bounded: false, stopped: false, processed: 0 } } : done());
  const result = await h.run();
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'complete_with_deferred');
  assert.equal(result.deferred, 3);
  assert.equal(result.modes.regular.deferred, 3);
  assert.equal(h.events.find(x => x.event === 'MODE_RESULT' && x.mode === 'regular').deferred, 3);
});

test('failed feeds, empty reports and profile errors cannot masquerade as completion', async () => {
  assert.equal(summaryComplete({ ...done(), killed: true }), false);
  assert.equal(summaryComplete({ code: 0, summary: null }), false);
  assert.equal(summaryComplete({ code: 0, summary: { backlog: 0, feedHttpStatus: 0 } }), false);
  assert.equal(summaryComplete({ code: 0, summary: { backlog: 0, feedHttpStatus: 200, feedError: 'offline' } }), false);
  const h = harness(mode => mode.name === 'arena'
    ? { code: 0, summary: { feedHttpStatus: 200, backlog: 1, attempted: 1, errors: 1 } } : done());
  const result = await h.run();
  assert.equal(result.ok, false);
  assert.equal(result.modes.arena.complete, false);
  assert.ok(h.calls.filter(x => x === 'arena').length < 20, 'persistent errors back off instead of spinning');
  assert.equal(h.calls.filter(x => x === 'pve').length, 1);
});

test('an exception or shutdown preserves unfinished modes and never blocks the next mode', async () => {
  let failed = false;
  const h = harness(mode => {
    if (mode.name === 'arena' && !failed) { failed = true; throw new Error('spawn failure'); }
    if (mode.name === 'warmup') return { code: 0, summary: { bounded: true, stopped: false, processed: 0 } };
    return done();
  });
  assert.equal((await h.run()).ok, true);
  assert.deepEqual(h.calls.slice(0,4), ['arena','regular','pve','seasonal']);
  const controller = new AbortController();
  const stopped = harness(() => { controller.abort(); return done(); }, 3_600_000, controller);
  assert.equal((await stopped.run()).reason, 'signal');
  assert.deepEqual(stopped.calls, ['arena']);
});

test('warmup accepts successful capped, fully completed and empty batches', async () => {
  for (const summary of [
    { bounded: true, stopped: false, processed: 100 },
    { bounded: false, stopped: false, processed: 3 },
    { bounded: false, stopped: false, processed: 0 },
  ]) {
    const h = harness(mode => mode.name === 'warmup' ? { code: 0, summary } : done());
    const result = await h.run();
    assert.equal(result.ok, true, JSON.stringify(summary));
    assert.equal(result.reason, 'complete');
    assert.deepEqual(h.calls, ['arena', 'regular', 'pve', 'seasonal', 'warmup']);
  }
});

test('warmup retains validation and reports an interrupted or malformed result', async () => {
  for (const summary of [null,
    { bounded: true, stopped: true, processed: 1 },
    { bounded: false, stopped: true, processed: 0 },
    { bounded: true, stopped: false, processed: -1 },
    { stopped: false, processed: 0 },
    { bounded: 'false', stopped: false, processed: 0 },
    { bounded: null, stopped: false, processed: 0 },
  ]) {
    const h = harness(mode => mode.name === 'warmup' ? { code: 0, summary } : done());
    const result = await h.run();
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'warmup_failed');
  }
  const failed = harness(mode => { if (mode.name === 'warmup') throw new Error('warmup spawn failure'); return done(); });
  assert.equal((await failed.run()).reason, 'warmup_failed');
});

test('real child reports are parsed and a child that ignores termination is reaped', async () => {
  const script = `.queue-test-${randomUUID()}.mjs`;
  const file = resolve('scripts',script);
  try {
    await writeFile(file, `console.log(new Date().toISOString()+' SUMMARY '+JSON.stringify({feedHttpStatus:200,backlog:1,attempted:1,errors:0}));`);
    const result = await runCollector({ ...PROFILE_QUEUE_MODES[0], script }, 10_000, Date.now()+20_000);
    assert.equal(result.code, 0);
    assert.equal(result.summary.backlog, 1);
    assert.equal(summaryComplete(result), false);
    await writeFile(file, `process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);`);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 500);
    const stopped = await runCollector({ ...PROFILE_QUEUE_MODES[0], script }, 10_000, Date.now()+20_000, controller.signal);
    clearTimeout(timeout);
    assert.equal(stopped.killed, true);
    assert.notEqual(stopped.code, 0);
  } finally { await rm(file, {force:true}); }
});

test('host budgets stop the night at 07:00 and allow one recovery hour with isolation and writer lock', async () => {
  const source = await readFile('ops/profile-queue.sh','utf8');
  const dir = await mkdtemp(join(tmpdir(),'round-queue-wrapper-'));
  try {
    const path = dir.replaceAll('\\','/');
    const script = source.replace('cd /opt/tarkovstats-auto || exit 1',`cd '${path}' || exit 1`)
      .replace('/usr/local/sbin/tarkovstats-run-background','printf \'%s\\n\'')
      .replaceAll('/usr/bin/systemctl', 'systemctl');
    const file = join(dir,'queue.sh');
    const nightStart = Date.UTC(2026, 9, 17, 23) / 1000; // 02:00 Moscow
    const nightEnd = nightStart + 5 * 3600;
    for (const [args, now, seconds, status] of [
      [[], nightStart, 18000, 0], [['nightly'], nightStart, 18000, 0],
      [['nightly'], nightStart + 2 * 3600, 10800, 0],
      [['nightly'], nightEnd, 0, 75], [['nightly'], nightEnd + 3600, 0, 75],
      [['catchup'], nightEnd + 2 * 3600, 3600, 0], [['invalid'], nightStart, 0, 2],
    ]) {
      const mock = `date() {
        if [ "$*" = +%s ]; then printf '%s\\n' ${now}; else
          [ "$TZ" = Europe/Moscow ] || return 92
          [ "$*" = '-d today 07:00:00 +%s' ] || return 93
          printf '%s\\n' ${nightEnd}
        fi
      }
      systemctl() { [ "$1" != is-enabled ] || return 1; }
`;
      await writeFile(file, mock + script);
      const result = spawnSync(shell,[file, ...args],{encoding:'utf8',timeout:10_000});
      assert.ifError(result.error); assert.equal(result.status,status,result.stderr);
      if (status !== 0) {
        assert.doesNotMatch(result.stdout, /PROFILE_QUEUE_DEADLINE_MS/);
        continue;
      }
      const deadline = Number(/PROFILE_QUEUE_DEADLINE_MS=(\d+)/.exec(result.stdout)[1]);
      assert.equal(deadline, (now + seconds) * 1000);
      assert.match(result.stdout,/worker\nnice\n-n\n19\nnode/);
      assert.match(result.stdout,/scripts\/run-profile-queue.mjs/);
    }
  } finally { await rm(dir,{recursive:true,force:true}); }
  const service = await readFile('ops/systemd/tarkovstats-profile-queue.service','utf8');
  assert.match(service,/flock \/run\/tarkovstats-data-sync\.lock/);
  assert.match(service,/ExecCondition=.*tarkovstats-public-profile-importer/);
  assert.match(await readFile('ops/systemd/tarkovstats-profile-queue-no-restart.conf','utf8'),/^Restart=no$/m);
  assert.match(await readFile('Dockerfile','utf8'),/COPY.*scripts\/run-profile-queue\.mjs/);
});

test('only a successful worker disables recovery; a failed run leaves the timer enabled', async () => {
  const source = await readFile('ops/profile-queue.sh', 'utf8');
  const dir = await mkdtemp(join(tmpdir(), 'profile-recovery-complete-'));
  try {
    const file = join(dir, 'queue.sh');
    for (const [workerCode, enabled, disables] of [[0, true, true], [1, true, false], [0, false, false]]) {
      const mock = `worker() { return ${workerCode}; }
        systemctl() {
          printf 'SYSTEMCTL %s\\n' "$*"
          if [ "$1" = is-enabled ]; then return ${enabled ? 0 : 1}; fi
        }\n`;
      await writeFile(file, mock + source
        .replace('cd /opt/tarkovstats-auto || exit 1', `cd '${dir.replaceAll('\\','/')}' || exit 1`)
        .replace('/usr/local/sbin/tarkovstats-run-background', 'worker')
        .replaceAll('/usr/bin/systemctl', 'systemctl'));
      const result = spawnSync(shell, [file, 'catchup'], { encoding: 'utf8', timeout: 10_000 });
      assert.ifError(result.error);
      assert.equal(result.status, workerCode, result.stderr);
      assert.equal(result.stdout.includes('SYSTEMCTL disable --now tarkovstats-profile-catchup.timer'), disables);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

async function dailyCycle({ indexSeconds = 300, profileSeconds = 18000, failures = [] } = {}) {
  const source = await readFile('ops/daily-cycle.sh', 'utf8');
  const directory = await mkdtemp(join(tmpdir(), 'daily-cycle-'));
  const midnight = Date.UTC(2026, 9, 7, 21) / 1000;
  try {
    const mock = `
clock=${midnight}
date() {
  if [ "$*" = +%s ]; then
    printf '%s\\n' "$clock"
  else
    [ "$TZ" = Europe/Moscow ] || return 92
    # Git Bash lacks IANA zoneinfo; Moscow is UTC+3 throughout these fixtures.
    TZ=UTC-3 command date "$@"
  fi
}
sleep() { clock=$((clock + $1)); }
systemctl() {
  [ "$1" = start ] || return 90
  started=$clock
  case "$2" in
    tarkovstats-*-index-sync.service) clock=$((clock + ${indexSeconds}));;
    tarkovstats-profile-queue.service) clock=$((clock + ${profileSeconds}));;
    tarkovstats-leaderboard-materialize.service|tarkovstats-publications.service) clock=$((clock + 120));;
    *) return 91;;
  esac
  printf 'CALL %s %s %s\\n' "$2" "$started" "$clock"
  case ' ${failures.join(' ')} ' in *" $2 "*) return 1;; esac
}
`;
    const file = join(directory, 'cycle.sh');
    await writeFile(file, source.replace('cycle_day=$(TZ=Europe/Moscow date +%F)',
      `${mock}\ncycle_day=2026-10-08`));
    const result = spawnSync(shell, [file], { encoding: 'utf8', timeout: 10_000 });
    assert.ifError(result.error);
    const calls = [...result.stdout.matchAll(/^CALL (\S+) (\d+) (\d+)$/gm)].map(([, unit, start, end]) =>
      ({ unit, start: Number(start) - midnight, end: Number(end) - midnight }));
    return { ...result, calls };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

const dailyUnits = ['player-index-sync', 'seasonal-index-sync', 'pve-index-sync', 'arena-index-sync',
  'profile-queue', 'leaderboard-materialize', 'publications'].map(name => `tarkovstats-${name}.service`);

test('one daily cycle completes all indexes before the 02:00 shared scan and publications', async () => {
  const result = await dailyCycle();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls.map(call => call.unit), dailyUnits);
  assert.equal(result.calls[4].start, 2 * 3600);
  assert.equal(result.calls[4].end, 7 * 3600);
  assert.equal(result.calls[5].start, 7 * 3600);
  assert.equal(result.calls[6].start, 7 * 3600 + 120);
  assert.match(result.stdout, /CYCLE_SUMMARY status=0/);
});

test('an empty night queue exits early and retains the original publication times', async () => {
  const result = await dailyCycle({ profileSeconds: 30 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.calls[4].end, 2 * 3600 + 30);
  assert.equal(result.calls[5].start, 4 * 3600 + 20 * 60);
  assert.equal(result.calls[6].start, 5 * 3600 + 30 * 60);
});

test('late indexes move the nightly profile budget and publications forward without overlapping or waiting until tomorrow', async () => {
  for (const indexSeconds of [3150, 5400]) {
    const result = await dailyCycle({ indexSeconds });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls.map(call => call.unit), dailyUnits);
    assert.equal(result.calls[4].start, indexSeconds * 4);
    assert.equal(result.calls[4].end - result.calls[4].start, 18000);
    for (let index = 1; index < result.calls.length; index++) {
      assert.ok(result.calls[index].start >= result.calls[index - 1].end, result.calls[index].unit);
    }
    assert.equal(result.calls[5].start, result.calls[4].end);
    assert.ok(result.calls[6].end < 24 * 3600, 'missed clock times are not deferred until the next day');
  }
});

test('failed indexes, an unfinished nightly pass and a failed leaderboard do not replay the scan or skip later publications', async () => {
  const result = await dailyCycle({ failures: [dailyUnits[0], dailyUnits[4], dailyUnits[5]] });
  assert.equal(result.status, 1);
  assert.deepEqual(result.calls.map(call => call.unit), dailyUnits);
  for (const unit of [dailyUnits[0], dailyUnits[4], dailyUnits[5]]) assert.match(result.stderr,
    new RegExp(`CYCLE_FAILED ${unit.slice('tarkovstats-'.length, -'.service'.length)}`));
  assert.match(result.stdout, /CYCLE_DONE publications/);
  assert.match(result.stdout, /CYCLE_SUMMARY status=1/);
});

test('daily cycle units retain importer protection, one daily activation and child-owned locks', async () => {
  const service = await readFile('ops/systemd/tarkovstats-daily-cycle.service', 'utf8');
  const timer = await readFile('ops/systemd/tarkovstats-daily-cycle.timer', 'utf8');
  assert.match(service, /^ExecStart=\/usr\/local\/sbin\/tarkovstats-daily-cycle$/m);
  assert.match(service, /ExecCondition=.*tarkovstats-public-profile-importer/);
  assert.match(service, /^Restart=no$/m);
  assert.doesNotMatch(service, /^ExecStart=.*flock/m, 'a parent writer lock would deadlock every child');
  assert.match(timer, /^OnCalendar=\*-\*-\* 00:00:00 Europe\/Moscow$/m);
  assert.match(timer, /^Persistent=true$/m);
  const standalone = await readFile('ops/systemd/tarkovstats-profile-queue.timer', 'utf8');
  assert.match(standalone, /^OnCalendar=\*-\*-\* 02:00:00 Europe\/Moscow$/m);
  assert.doesNotMatch(standalone, /OnCalendar=hourly/);
  const leaderboard = await readFile('ops/systemd/tarkovstats-leaderboard-materialize.service', 'utf8');
  assert.match(leaderboard, /flock \/run\/tarkovstats-data-sync.lock .*flock \/run\/tarkovstats-leaderboard.lock/);
  assert.doesNotMatch(leaderboard, /flock -n/);
});
