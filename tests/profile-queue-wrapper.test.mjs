import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { runProfileQueue, runCollector, summaryComplete, PROFILE_QUEUE_MODES } from '../scripts/run-profile-queue.mjs';

const shell = process.platform === 'win32'
  ? resolve(execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(), '../../../bin/bash.exe') : '/bin/sh';
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

test('warmup retains validation and reports an interrupted or malformed result', async () => {
  for (const summary of [null, { bounded: true, stopped: true, processed: 1 }, { bounded: true, stopped: false, processed: -1 }]) {
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

test('the host wrapper keeps one-hour deadline, isolation, nice priority and writer lock', async () => {
  const source = await readFile('ops/profile-queue.sh','utf8');
  const dir = await mkdtemp(join(tmpdir(),'round-queue-wrapper-'));
  try {
    const path = dir.replaceAll('\\','/');
    const script = source.replace('cd /opt/tarkovstats-auto || exit 1',`cd '${path}' || exit 1`)
      .replace('exec /usr/local/sbin/tarkovstats-run-background','printf \'%s\\n\'');
    const file = join(dir,'queue.sh'); await writeFile(file,script);
    const before = Date.now();
    const result = spawnSync(shell,[file],{encoding:'utf8',timeout:10_000});
    assert.ifError(result.error); assert.equal(result.status,0,result.stderr);
    const deadline = Number(/PROFILE_QUEUE_DEADLINE_MS=(\d+)/.exec(result.stdout)[1]);
    assert.ok(deadline >= before+3_600_000-2000 && deadline <= Date.now()+3_600_000);
    assert.match(result.stdout,/worker\nnice\n-n\n19\nnode/);
    assert.match(result.stdout,/scripts\/run-profile-queue.mjs/);
  } finally { await rm(dir,{recursive:true,force:true}); }
  const service = await readFile('ops/systemd/tarkovstats-profile-queue.service','utf8');
  assert.match(service,/flock \/run\/tarkovstats-data-sync\.lock/);
  assert.match(service,/ExecCondition=.*tarkovstats-public-profile-importer/);
  assert.match(await readFile('ops/systemd/tarkovstats-profile-queue-no-restart.conf','utf8'),/^Restart=no$/m);
  assert.match(await readFile('Dockerfile','utf8'),/COPY.*scripts\/run-profile-queue\.mjs/);
});
