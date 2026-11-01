import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const RELEASE_CONFIG = 'sha256:b7c1ad5c860e8037e1a174902fd0560d35d24267514aa7855e16b5ed5fdc6741';
const RELEASE_MANIFEST = 'sha256:c75304f9b148b1010ebe4a8149425e351e2fde55bac7ef0024a93199b1d52115';
const OBSERVED_VPS_IMAGE = 'sha256:c75304f9b148b1010ebe4a8149425e351e2fde55bac7ef0024a93199b1d52115';
const REVISION = '14490e2039a135e312a5d1b5f3d73f474887c3bc';
const NATIVE = 'f2e4ee25851e890a312fe29540778140bcac6de4059425fd3dcba54d5e62618c';
const ARCHIVE = '3a4342c382b49821e2d37aab634c3435595ce967e6b798134a485e8dcae97ebb';
const RELEASE_TAG = `tarkovstats-web:${REVISION}`;
const MEMORY = 512 * 1024 ** 2;
const ORDER = ['typescript', 'rust', 'rust', 'typescript'];
const SCENARIOS = ['all', '90d'].flatMap(period => ['hours', 'pmc_raids'].flatMap(dimension =>
  ['matched', 'population'].flatMap(group => ['median', 'trimmed_mean'].flatMap(statistic =>
    [['miss', 1], ['miss', 4], ['hit', 4]].map(([cache, concurrency]) => `${group}/${statistic}/${period}/${dimension}/${cache}/${concurrency}`)))));
const key = row => `${row.scenario}/${row.statistic}/${row.period}/${row.dimension}/${row.cache}/${row.concurrency}`;
// Independent divisibility oracle for generated peer nulls and date partition;
// the seven other owners are fresh and have every metric.
function expectedCounts(period, matched = false) {
  const counts = { kd_ratio: 7, pmc_kd_ratio: 7, kills_per_raid: 7, killed_pmc_per_raid: 7,
    pmc_survival_rate: 7, longest_win_streak: 7, level: 7 };
  let n = 7;
  for (let aid = 1; aid <= 60000; aid++) {
    if (period === '90d' && aid > 50000) continue;
    const hours = 50 + (aid * 37) % 4950 + (aid % 10) / 10;
    const raids = 20 + (aid * 13) % 1500;
    if (matched && !(hours >= 900 && hours <= 1100 && raids >= 450 && raids <= 550)) continue;
    n++;
    if (aid % 29 && aid % 31) counts.kd_ratio++;
    if (aid % 31) counts.kills_per_raid++;
    if (aid % 17 && aid % 23) counts.killed_pmc_per_raid++;
    counts.pmc_kd_ratio++; counts.pmc_survival_rate++; counts.longest_win_streak++; counts.level++;
  }
  return { n, counts };
}
// Matched targets have only three other matched owners in their window.
const EXPECTED = Object.fromEntries(['all', '90d'].map(period => {
  const matched = expectedCounts(period, true);
  matched.n -= 4;
  for (const key of Object.keys(matched.counts)) matched.counts[key] -= 4;
  return [period, { population: expectedCounts(period), matched }];
}));
function distribution(value, count, raw) {
  assert.ok(Array.isArray(raw)); assert.equal(raw.length, count); assert.equal(value.samples, count);
  for (const n of raw) assert.ok(typeof n === 'number' && Number.isFinite(n) && n >= 0);
  const sorted = [...raw].sort((a, b) => a - b);
  const percentile = fraction => sorted.length ? Number(sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)].toFixed(3)) : null;
  assert.equal(value.p50Ms, percentile(.5)); assert.equal(value.p95Ms, percentile(.95)); assert.equal(value.maxMs, percentile(1));
}
// Same arithmetic tolerance and exact remaining fields as the pinned fixture's assertNativeParity.
function assertPayloadParity(actual, expected, context) {
  const normalized = structuredClone(actual);
  function normalize(got, wanted, path) {
    if (typeof wanted === 'number' && (path.endsWith('.value') || path.includes('.coverage.'))) {
      assert.equal(typeof got, 'number', `${context}: ${path}`);
      assert.ok(Number.isFinite(got) && Math.abs(got - wanted) <= 1e-12 * Math.max(1, Math.abs(wanted)), `${context}: ${path}`);
      return wanted;
    }
    if (wanted && typeof wanted === 'object') {
      assert.ok(got && typeof got === 'object', `${context}: ${path}`);
      for (const [key, value] of Object.entries(wanted)) got[key] = normalize(got[key], value, `${path}.${key}`);
    }
    return got;
  }
  assert.deepEqual(normalize(normalized, expected, 'body'), expected, context);
}
export function validateSeasonalProof(runs, provenance, imageProvenance) {
  const initialFields = ['testedImageId', 'releaseManifestDigest', 'releaseConfigDigest', 'observedVpsImageDigest', 'releaseTag', 'sourceRevision', 'archiveSha256'];
  assert.deepEqual(imageProvenance, Object.fromEntries(initialFields.map(field => [field, provenance[field]])));
  assert.deepEqual({ testedImageId: provenance.testedImageId, releaseManifestDigest: provenance.releaseManifestDigest,
    releaseConfigDigest: provenance.releaseConfigDigest, observedVpsImageDigest: provenance.observedVpsImageDigest,
    sourceRevision: provenance.sourceRevision, nativeSha256: provenance.nativeSha256, archiveSha256: provenance.archiveSha256, releaseTag: provenance.releaseTag },
    { testedImageId: RELEASE_CONFIG, releaseManifestDigest: RELEASE_MANIFEST, releaseConfigDigest: RELEASE_CONFIG,
      observedVpsImageDigest: OBSERVED_VPS_IMAGE, sourceRevision: REVISION, nativeSha256: NATIVE, archiveSha256: ARCHIVE, releaseTag: RELEASE_TAG });
  assert.match(provenance.ownershipToken, /^[0-9a-f]{32}$/);
  assert.match(provenance.hashContainerId, /^[0-9a-f]{64}$/); assert.equal(provenance.hashContainerImageId, provenance.testedImageId); assert.equal(provenance.hashContainerRemoved, true);
  assert.equal(runs.length, 4); assert.equal(new Set(runs.map(run => run.inspect.id)).size, 4);
  assert.ok(runs.every(run => run.inspect.id !== provenance.hashContainerId));
  for (let i = 0; i < runs.length; i++) {
    const { report: r, inspect: d, cleanup, timing } = runs[i], backend = ORDER[i];
    assert.match(timing.startedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/); assert.match(timing.finishedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    assert.ok(Number.isSafeInteger(timing.elapsedSeconds) && timing.elapsedSeconds >= 0);
    assert.deepEqual(cleanup, { removed: true, runnerExit: 0 });
    assert.equal(d.owner, provenance.ownershipToken); assert.match(d.id, /^[0-9a-f]{64}$/); assert.equal(d.imageId, provenance.testedImageId); assert.equal(d.sourceRevision, REVISION);
    assert.equal(d.exitCode, 0); assert.equal(d.oomKilled, false); assert.ok(['nextjs', '1001', '1001:1001'].includes(d.user));
    assert.equal(d.network, 'none'); assert.equal(d.ipcMode, 'private'); assert.equal(d.readOnly, true);
    assert.equal(d.memory, MEMORY); assert.equal(d.memorySwap, MEMORY); assert.equal(d.nanoCpus, 500000000); assert.equal(d.pidsLimit, 64);
    assert.equal(d.privileged, false); assert.ok(!d.capAdd || d.capAdd.length === 0); assert.ok(d.capDrop.includes('ALL'));
    assert.ok(d.securityOpt.some(item => /^no-new-privileges(?:(?:=|:)true)?$/.test(item)));
    assert.ok(!d.portBindings || Object.keys(d.portBindings).length === 0);
    assert.deepEqual(Object.keys(d.tmpfs), ['/tmp']);
    for (const part of ['noexec', 'nosuid', 'nodev', 'size=128m', 'mode=1777']) assert.ok(d.tmpfs['/tmp'].split(',').includes(part));
    const allowed = ['/app/app', '/app/tests', '/app/scripts/benchmark-rust-cohort.mjs', '/app/scripts/benchmark-worker-resources.mjs'].sort();
    const binds = d.mounts.filter(mount => mount.Type === 'bind');
    assert.deepEqual(binds.map(mount => mount.Destination).sort(), allowed); assert.ok(binds.every(mount => mount.RW === false));
    assert.ok(d.mounts.every(mount => mount.Type === 'bind' || (mount.Type === 'tmpfs' && mount.Destination === '/tmp')));
    assert.equal(r.formatVersion, 1); assert.equal(r.environment.os, 'linux'); assert.match(r.environment.node, /^v22\./);
    assert.equal(r.fixture.mode, 'seasonal'); assert.equal(r.fixture.synthetic, true); assert.equal(r.fixture.players, 60000);
    assert.equal(r.fixture.peerAccounts, 60000); assert.equal(r.fixture.normalizedPeerRows, 60000); assert.equal(r.fixture.owners, 8);
    assert.equal(r.methodology.iterations, 20); assert.equal(r.methodology.backendSelection, backend); assert.deepEqual(r.methodology.backendOrder, [backend]);
    assert.equal(r.methodology.warmupRequestsPerScenario, 1);
    assert.equal(r.results.length, 49);
    const cold = r.results.filter(item => item.scenario === 'first_request_fresh_worker');
    assert.equal(cold.length, 1); assert.equal(cold[0].backend, backend); assert.ok(Number.isFinite(cold[0].coldHttpMs) && cold[0].coldHttpMs >= 0);
    const results = r.results.filter(item => item.http);
    assert.deepEqual(results.map(key).sort(), [...SCENARIOS].sort());
    for (const row of results) {
      const misses = row.cache === 'miss'; assert.equal(row.backend, backend); assert.deepEqual(row.errors, []);
      assert.ok(Array.isArray(row.rawSamples)); assert.equal(row.rawSamples.length, 20);
      const baseline = runs[0].report.results.find(item => key(item) === key(row));
      assert.ok(baseline && baseline.rawSamples.length === 20);
      for (let index = 0; index < row.rawSamples.length; index++) {
        const sample = row.rawSamples[index], expected = baseline.rawSamples[index];
        const aid = (row.scenario === 'matched' ? 60001 : 60005) + (index % row.concurrency);
        const query = new URLSearchParams({ mode: 'seasonal', aid: String(aid), statistic: row.statistic,
          period: row.period, dimension: row.dimension, cycle: 'native-s1' }).toString();
        assert.equal(sample.query, query); assert.equal(sample.status, 200);
        assert.ok(sample.body && Buffer.byteLength(JSON.stringify(sample.body)) <= 65536);
        const body = sample.body;
        assert.equal(body.mode, 'seasonal'); assert.equal(body.cycleId, 'native-s1'); assert.equal(body.aid, aid);
        assert.deepEqual(body.identity, { aid, mode: 'seasonal', cycleId: 'native-s1' });
        assert.equal(body.strategy, row.scenario); assert.equal(body.statistic, row.statistic);
        assert.equal(body.period, row.period); assert.equal(body.dimension, row.dimension);
        assert.equal(body.reason, null); assert.equal(body.percentiles, null);
        assert.ok(Number.isSafeInteger(body.n) && body.n >= (row.scenario === 'matched' ? 20 : 1));
        const oracle = EXPECTED[row.period][row.scenario];
        assert.equal(body.percent, row.scenario === 'matched' ? 10 : 30);
        assert.deepEqual(Object.keys(body.averages).sort(), Object.keys(oracle.counts).sort());
        assert.equal(body.n, oracle.n);
        for (const [metric, count] of Object.entries(oracle.counts)) {
          assert.equal(body.averages[metric].count, count);
          assert.ok(typeof body.averages[metric].value === 'number' && Number.isFinite(body.averages[metric].value));
        }
        assert.equal(expected.query, sample.query); assert.equal(expected.status, sample.status);
        assertPayloadParity(sample.body, expected.body, `${i}/${key(row)}/${index}`);
      }
      distribution(row.http, 20, row.rawSamples.map(sample => sample.totalMs));
      distribution(row.server, 20, row.rawServerMs);
      distribution(row.queue, misses ? 20 : 0, row.rawQueueMs); distribution(row.worker, misses ? 20 : 0, row.rawWorkerMs);
      assert.equal(row.workerJobs, misses ? 20 : 0); assert.equal(row.cacheHits, misses ? 0 : 20);
      assert.deepEqual(row.workerBackends, misses ? [backend] : []); assert.ok(Number.isSafeInteger(row.responseBytes) && row.responseBytes > 0);
    }
    assert.equal(r.resourceResults.length, 1); const child = r.resourceResults[0];
    assert.equal(child.backend, backend); assert.equal(child.available, true); assert.equal(child.workers.length, 1);
    assert.ok(Number.isFinite(child.workerCpuMs) && child.workerCpuMs >= 0);
    assert.ok(Number.isSafeInteger(child.workers[0].peakWorkingSetBytes) && child.workers[0].peakWorkingSetBytes > 0);
    const c = r.containerResources; assert.equal(c.available, true); assert.equal(c.version, 2);
    assert.equal(c.memory.maxBytes, MEMORY); assert.equal(c.memory.swapMaxBytes, 0); assert.equal(c.cpu.quotaUs / c.cpu.periodUs, .5);
    assert.ok(Number.isSafeInteger(c.memory.peakBytes) && c.memory.peakBytes > 0 && c.memory.peakBytes <= MEMORY);
    for (const field of ['usageUs', 'userUs', 'systemUs']) assert.ok(Number.isSafeInteger(c.cpu[field]) && c.cpu[field] >= 0);
    assert.equal(c.memoryEvents.oomKill, 0);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = process.argv[2]; assert.ok(dir);
  const names = ['seasonal-round1-typescript', 'seasonal-round1-rust', 'seasonal-round2-rust', 'seasonal-round2-typescript'];
  const read = file => JSON.parse(readFileSync(join(dir, file), 'utf8'));
  const runs = names.map(name => ({ report: read(name + '.json'), inspect: read(name + '.inspect.json'), cleanup: read(name + '.cleanup.json'), timing: read(name + '.timing.json') }));
  const provenance = read('provenance.json'), imageProvenance = read('image-provenance.json'); validateSeasonalProof(runs, provenance, imageProvenance);
  assert.deepEqual(read('image-observation.json'), { observedImageId: provenance.testedImageId, expectedConfigDigest: provenance.releaseConfigDigest });
  const lines = ['# Synthetic Seasonal cohort resource proof', '',
    'Four fresh benchmark containers, 50,000 fresh synthetic peers, 10,000 peers older than 90 days and eight owners. Both periods, dimensions, statistics, strategies and backend orders use 20 samples per scenario. The proposed live cap remains 50,000 peers. Loopback HTTP uses the existing source route adapter; /app/lib and native executable come from the pinned image. This is not live-data parity, production HTTP or evidence of a production gain.', '',
    '| Round | Scenario | TS p95 ms | Rust p95 ms | Difference |', '| --- | --- | ---: | ---: | ---: |'];
  lines.splice(4, 0, 'The independently verified release archive contains manifest digest c753 referencing config digest b7c1. The CI Docker image ID is the config digest; the previously observed VPS image digest is the manifest digest. These distinct identifiers are not asserted equal. This synthetic run does not establish live parity or current runtime state.', '');
  for (const [index, round] of [[0, 1], [2, 2]]) {
    const ts = runs[index + (round === 1 ? 0 : 1)].report.results.filter(x => x.http);
    const rust = runs[index + (round === 1 ? 1 : 0)].report.results.filter(x => x.http);
    for (const row of ts) {
      const other = rust.find(x => key(x) === key(row)); const delta = row.http.p95Ms ? `${((other.http.p95Ms / row.http.p95Ms - 1) * 100).toFixed(1)}%` : 'n/a';
      lines.push(`| ${round} | ${key(row)} | ${row.http.p95Ms} | ${other.http.p95Ms} | ${delta} |`);
    }
  }
  lines.push('', '| Run | Wall seconds | Warm worker CPU ms | Worker lifetime peak bytes | Cgroup lifetime CPU ms | Cgroup lifetime peak bytes |', '| --- | ---: | ---: | ---: | ---: | ---: |');
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i].report, c = r.containerResources, child = r.resourceResults[0];
    lines.push(`| ${names[i]} | ${runs[i].timing.elapsedSeconds} | ${child.workerCpuMs} | ${child.workers[0].peakWorkingSetBytes} | ${c.cpu.usageUs / 1000} | ${c.memory.peakBytes} |`);
  }
  lines.push('', 'Cgroup CPU and charged memory peak include fixture setup, page cache/tmpfs, parent and children, through the in-container snapshot; these are not timed-only RSS or VPS-wide values. Worker CPU covers the warm series; worker peak is lifetime. The operator-only instrumented copy retains each timed response and raw timing after the original HTTP timing bracket. Retention and report serialization add overhead, affect subsequent requests and contribute to cgroup resources. The validator checks response parity with the pinned fixture tolerance and recomputes quantiles from raw observations. This synthetic proof does not establish live-data parity.', '');
  const summary = lines.join('\n'); writeFileSync(join(dir, 'summary.md'), summary); process.stdout.write(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
}
