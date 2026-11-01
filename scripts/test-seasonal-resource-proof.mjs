import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { syntheticSeasonalRows } from '../tests/fixtures/rust-arena-seasonal-data.mjs';
import { validateSeasonalProof } from './summarize-seasonal-resource-proof.mjs';

const image = 'sha256:b7c1ad5c860e8037e1a174902fd0560d35d24267514aa7855e16b5ed5fdc6741';
const manifest = 'sha256:c75304f9b148b1010ebe4a8149425e351e2fde55bac7ef0024a93199b1d52115';
const revision = '14490e2039a135e312a5d1b5f3d73f474887c3bc';
const provenance = { testedImageId:image, releaseManifestDigest:manifest, releaseConfigDigest:image, observedVpsImageDigest:manifest,
  releaseTag:`tarkovstats-web:${revision}`, sourceRevision:revision,
  nativeSha256:'f2e4ee25851e890a312fe29540778140bcac6de4059425fd3dcba54d5e62618c',
  archiveSha256:'3a4342c382b49821e2d37aab634c3435595ce967e6b798134a485e8dcae97ebb',
  hashContainerId:'f'.repeat(64), hashContainerImageId:image, hashContainerRemoved:true, ownershipToken:'b'.repeat(32) };
const initialFields = ['testedImageId','releaseManifestDigest','releaseConfigDigest','observedVpsImageDigest','releaseTag','sourceRevision','archiveSha256'];
const initial = Object.fromEntries(initialFields.map(field => [field, provenance[field]]));
const memory = 512 * 1024 ** 2;

// Derive an oracle directly from the canonical generated peer rows, then add
// seven other owners using the fixture's documented non-null defaults.
function fixtureCounts(period, matched = false) {
  const counts = Object.fromEntries(['kd_ratio','pmc_kd_ratio','kills_per_raid','killed_pmc_per_raid',
    'pmc_survival_rate','longest_win_streak','level'].map(name => [name, matched ? 3 : 7]));
  for (const row of syntheticSeasonalRows(60000)) {
    if (period === '90d' && row.aid > 50000) continue;
    if (matched && !(row.lifetime_pvp_hours >= 900 && row.lifetime_pvp_hours <= 1100 && row.pmc_raids >= 450 && row.pmc_raids <= 550)) continue;
    if (row.deaths != null && row.total_kills != null) counts.kd_ratio++;
    if (row.killed_pmc != null) counts.pmc_kd_ratio++;
    if (row.total_kills != null) counts.kills_per_raid++;
    if (row.pvp_stats_version === 1 && row.pmc_killed_pmc != null) counts.killed_pmc_per_raid++;
    if (row.pmc_survived != null) counts.pmc_survival_rate++;
    if (row.longest_win_streak != null) counts.longest_win_streak++;
    if (row.level != null) counts.level++;
  }
  return counts;
}
const counts = Object.fromEntries(['all','90d'].map(period => [period,
  { population:fixtureCounts(period), matched:fixtureCounts(period,true) }]));
function fakeRuns() {
  return ['typescript','rust','rust','typescript'].map((backend,index) => {
    const results=[{backend,scenario:'first_request_fresh_worker',coldHttpMs:1,phases:{}}];
    for (const period of ['all','90d']) for (const dimension of ['hours','pmc_raids'])
    for (const scenario of ['matched','population']) for (const statistic of ['median','trimmed_mean'])
    for (const [cache,concurrency] of [['miss',1],['miss',4],['hit',4]]) {
      const miss=cache==='miss', dist=count=>({samples:count,p50Ms:count?1:null,p95Ms:count?3:null,maxMs:count?3:null});
      const raw=[1,1,2,3];
      const rawSamples=raw.map((totalMs,i)=>{const aid=(scenario==='matched'?60001:60005)+(i%concurrency); return {
        query:new URLSearchParams({mode:'seasonal',aid:String(aid),statistic,period,dimension,cycle:'native-s1'}).toString(),
        status:200,totalMs,phases:{}, body:{aid,mode:'seasonal',cycleId:'native-s1',strategy:scenario,statistic,period,dimension,
          n:scenario==='population'?(period==='all'?60007:50007):(period==='all'?168:138),percent:scenario==='matched'?10:30,
          identity:{aid,mode:'seasonal',cycleId:'native-s1'},
          averages:Object.fromEntries(Object.entries(counts[period][scenario]).map(([key,count])=>[key,{value:2.5,count}])),
          percentiles:null,reason:null}
      };});
      results.push({backend,scenario,statistic,period,dimension,cache,concurrency,errors:[],http:dist(4),server:dist(4),queue:dist(miss?4:0),
        worker:dist(miss?4:0),rawSamples,rawServerMs:raw,rawQueueMs:miss?raw:[],rawWorkerMs:miss?raw:[],
        workerJobs:miss?4:0,workerBackends:miss?[backend]:[],cacheHits:miss?0:4,responseBytes:500});
    }
    return {report:{formatVersion:1,environment:{os:'linux',node:'v22.0.0'},fixture:{mode:'seasonal',players:60000,peerAccounts:60000,normalizedPeerRows:60000,owners:8,synthetic:true},
      methodology:{iterations:4,backendSelection:backend,backendOrder:[backend],warmupRequestsPerScenario:1},results,
      resourceResults:[{backend,available:true,workerCpuMs:1,workers:[{peakWorkingSetBytes:100}]}],
      containerResources:{available:true,version:2,memory:{maxBytes:memory,swapMaxBytes:0,peakBytes:1000},cpu:{quotaUs:50000,periodUs:100000,usageUs:10,userUs:8,systemUs:2},memoryEvents:{oomKill:0}}},
      inspect:{owner:provenance.ownershipToken,id:String(index+1).repeat(64),imageId:image,sourceRevision:revision,exitCode:0,oomKilled:false,user:'nextjs',network:'none',ipcMode:'private',readOnly:true,memory,memorySwap:memory,nanoCpus:500000000,pidsLimit:64,privileged:false,capAdd:null,capDrop:['ALL'],securityOpt:['no-new-privileges'],portBindings:null,tmpfs:{'/tmp':'rw,noexec,nosuid,nodev,size=128m,mode=1777'},mounts:['/app/app','/app/tests','/app/scripts/benchmark-rust-cohort.mjs','/app/scripts/benchmark-worker-resources.mjs'].map(Destination=>({Type:'bind',Destination,RW:false}))},
      cleanup:{removed:true,runnerExit:0},timing:{startedAt:'2026-10-28T00:00:00Z',finishedAt:'2026-10-28T00:00:01Z',elapsedSeconds:1}};
  });
}
test('full Seasonal matrix validates count and finite-value oracles independently of parity',()=>{
  assert.deepEqual(counts.all.population, {kd_ratio:56070,pmc_kd_ratio:60007,kills_per_raid:58072,killed_pmc_per_raid:54023,
    pmc_survival_rate:60007,longest_win_streak:60007,level:60007});
  assert.deepEqual(counts['90d'].population, {kd_ratio:46726,pmc_kd_ratio:50007,kills_per_raid:48395,killed_pmc_per_raid:45020,
    pmc_survival_rate:50007,longest_win_streak:50007,level:50007});
  const good=fakeRuns(); validateSeasonalProof(good,provenance,initial);
  const rounded=structuredClone(good); rounded[1].report.results[1].rawSamples[0].body.averages.kd_ratio.value += 1e-13;
  validateSeasonalProof(rounded,provenance,initial);
  for(const mutate of [
    runs=>{runs[1].inspect.id=runs[0].inspect.id;},
    runs=>{runs[1].report.results.pop();},
    runs=>{runs[1].report.results[1].workerJobs=3;},
    runs=>{runs[1].report.results[1].rawServerMs[0]=NaN;},
    runs=>{runs[1].report.results[1].rawSamples.pop();},
    runs=>{runs[1].report.methodology.iterations=20;},
    runs=>{runs[1].report.results[1].http.p95Ms=99;},
    runs=>{runs[1].report.results[1].rawSamples[0].body.averages.kd_ratio.value=3;},
    runs=>{runs[1].report.results[1].rawSamples[0].body.dimension='hours-wrong';},
    runs=>{runs[1].report.results[1].rawSamples[0].query='wrong';},
    runs=>{runs[1].inspect.mounts.push({Type:'bind',Destination:'/app/lib',RW:false});},
    runs=>{runs[3].cleanup.removed=false;},
    runs=>{runs[2].inspect.oomKilled=true;},
    runs=>{runs[0].report.fixture.players=30000;},
  ]) {const invalid=structuredClone(good); mutate(invalid); assert.throws(()=>validateSeasonalProof(invalid,provenance,initial));}
  for (const field of ['n','kd_ratio','pmc_kd_ratio','kills_per_raid','killed_pmc_per_raid','pmc_survival_rate','longest_win_streak','level','null']) {
    const invalid=structuredClone(good);
    for (const run of invalid) for (const row of run.report.results.filter(item=>item.scenario==='population')) for (const sample of row.rawSamples) {
      if (field==='n') sample.body.n=1;
      else if (field==='null') sample.body.averages.kd_ratio.value=null;
      else sample.body.averages[field].count=1;
    }
    assert.throws(()=>validateSeasonalProof(invalid,provenance,initial), field);
  }
  const ignoresPeriod=structuredClone(good);
  for (const run of ignoresPeriod) for (const row of run.report.results.filter(item=>item.scenario==='population' && item.period==='90d')) for (const sample of row.rawSamples) {
    sample.body.n=60007;
    for (const [metric, count] of Object.entries(counts.all.population)) sample.body.averages[metric].count=count;
  }
  assert.throws(()=>validateSeasonalProof(ignoresPeriod,provenance,initial));
  const wrongMatched=structuredClone(good);
  for (const run of wrongMatched) for (const row of run.report.results.filter(item=>item.scenario==='matched')) for (const sample of row.rawSamples) sample.body.n=20;
  assert.throws(()=>validateSeasonalProof(wrongMatched,provenance,initial));
  for (const field of ['testedImageId','releaseManifestDigest','releaseConfigDigest','observedVpsImageDigest']) {
    const wrong={...provenance,[field]:'sha256:'+('a'.repeat(64))};
    const wrongInitial={...initial,[field]:wrong[field]};
    assert.throws(()=>validateSeasonalProof(good,wrong,wrongInitial),field);
  }
  assert.throws(()=>validateSeasonalProof(good,{...provenance,nativeSha256:'f'.repeat(64)},initial));
  assert.throws(()=>validateSeasonalProof(good,{...provenance,hashContainerRemoved:false},initial));
  assert.throws(()=>validateSeasonalProof(good,{...provenance,archiveSha256:'f'.repeat(64)},{...initial,archiveSha256:'f'.repeat(64)}));
});
test('manual workflow and runner use current pinned source and bounded isolated recipe',()=>{
  const workflow=readFileSync(new URL('../.github/workflows/vps-image.yml',import.meta.url),'utf8');
  const runner=readFileSync(new URL('./benchmark-seasonal-resource-proof.sh',import.meta.url),'utf8');
  assert.match(workflow,/workflow_dispatch:/); assert.doesNotMatch(workflow,/\b(?:push|pull_request):/);
  assert.match(workflow,/3a4342c382b49821e2d37aab634c3435595ce967e6b798134a485e8dcae97ebb/);
  assert.ok(workflow.indexOf('[[ $expected == 3a4342') < workflow.indexOf('docker --context default load'));
  assert.match(workflow,/contents: read/); assert.doesNotMatch(workflow,/docker\s+build|release upload|npm ci|cargo build/);
  assert.match(workflow,/git diff --exit-code "\$SOURCE_REVISION" -- app\/api\/average\/cohort\/route\.ts app\/api\/seasonal\/cohort\/route\.ts/);
  for (const file of ['rust-cohort-data.mjs','rust-arena-seasonal-data.mjs','next-cache-shim.mjs','next-server-entry.mjs','benchmark-rust-cohort.mjs','benchmark-worker-resources.mjs']) assert.ok(workflow.includes(file));
  assert.match(runner,/--rows 60000 --iterations 4/); assert.match(runner,/--pids-limit 64/);
  assert.match(runner,/--memory 512m --memory-swap 512m/); assert.match(runner,/--kill-after=15s 480s/);
  assert.match(runner,/--network none --ipc private/); assert.match(runner,/backends=\(rust typescript\)/);
  assert.match(runner,/benchmark-seasonal-resource-driver\.mjs/); assert.match(runner,/driver-source\.sha256/);
  assert.match(runner,/driver-copy\.sha256/); assert.match(runner,/cmp -s .*driver-source\.sha256.*driver-copy\.sha256/); assert.match(runner,/driver\.patch/);
});

const bash = process.platform === "win32"
  ? resolve(execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim(), "../../../bin/bash.exe") : "bash";

test("Seasonal image cleanup removes only owned containers and requires positive absence proof", () => {
  const source = readFileSync(resolve("scripts/benchmark-seasonal-resource-proof.sh"), "utf8").replace(/\r\n/g, "\n");
  const start = source.indexOf("cleanup() {"), end = source.indexOf("\non_exit() {", start);
  assert.ok(start >= 0 && end > start);
  const cleanup = source.slice(start, end);
  assert.match(source, /docker\(\) \{ timeout --signal=TERM --kill-after=5s 15s/);
  assert.ok(source.includes('--label "org.tarkovstats.seasonal-proof=$token"'));
  assert.ok(source.includes('if created=$(docker create'));
  const directory = mkdtempSync(join(tmpdir(), "seasonal-cleanup-"));
  const owner = "a".repeat(32), id = "b".repeat(64);
  try {
    for (const scenario of [
      { name:"known", active:id, calls:["rm","container"], ok:true },
      { name:"lost-create", inspect:owner+" "+id, calls:["inspect","rm","container"], ok:true },
      { name:"foreign", inspect:"c".repeat(32)+" "+id, calls:["inspect"], ok:false },
      { name:"invalid-id", inspect:owner+" partial", calls:["inspect"], ok:false },
      { name:"inspect-error", inspectFail:true, calls:["inspect"], ok:false },
      { name:"remove-error-still-present", active:id, rmFail:true, remaining:id, calls:["rm","container"], ok:false },
      { name:"remove-error-verified-absent", active:id, rmFail:true, calls:["rm","container"], ok:true },
      { name:"list-error", active:id, listFail:true, calls:["rm","container"], ok:false },
      { name:"still-present", active:id, remaining:id, calls:["rm","container"], ok:false },
    ]) {
      const calls = join(directory, "calls-" + scenario.name);
      const script = `set -u
active_id="$TEST_ACTIVE"
active_name=owned
token="$TEST_OWNER"
docker() {
  printf '%s\\n' "$1" >> "$TEST_CALLS"
  case "$1" in
    inspect) [[ "$TEST_INSPECT_FAIL" == 0 ]] || return 1; printf '%s\\n' "$TEST_INSPECT";;
    rm) [[ "$TEST_RM_FAIL" == 0 ]];;
    container) [[ "$TEST_LIST_FAIL" == 0 ]] || return 1; printf '%s' "$TEST_REMAINING";;
    *) return 1;;
  esac
}
${cleanup}
if cleanup; then printf 'confirmed:%s:%s' "$active_id" "$active_name"; else printf 'unconfirmed'; fi
`;
      const result = spawnSync(bash, ["-c", script], {
        encoding:"utf8", env:{ ...process.env, TEST_ACTIVE:scenario.active ?? "", TEST_OWNER:owner, TEST_CALLS:calls,
          TEST_INSPECT:scenario.inspect ?? "", TEST_INSPECT_FAIL:scenario.inspectFail ? "1" : "0",
          TEST_RM_FAIL:scenario.rmFail ? "1" : "0", TEST_LIST_FAIL:scenario.listFail ? "1" : "0", TEST_REMAINING:scenario.remaining ?? "" },
      });
      assert.equal(result.status, 0, scenario.name + ": " + result.stderr);
      assert.equal(result.stdout, scenario.ok ? "confirmed::" : "unconfirmed", scenario.name);
      assert.deepEqual(readFileSync(calls, "utf8").trim().split("\n"), scenario.calls, scenario.name);
    }
  } finally { rmSync(directory, { recursive:true, force:true }); }
});


test("Seasonal exit trap fails closed on unconfirmed cleanup without masking a prior failure", () => {
  const source = readFileSync(resolve("scripts/benchmark-seasonal-resource-proof.sh"), "utf8").replace(/\r\n/g, "\n");
  const start = source.indexOf("on_exit() {"), end = source.indexOf("\ntrap on_exit EXIT", start);
  assert.ok(start >= 0 && end > start);
  const handler = source.slice(start, end), directory = mkdtempSync(join(tmpdir(), "seasonal-cleanup-exit-"));
  try {
    for (const [cleanupStatus, requestedStatus, expectedStatus] of [[1, 0, 1], [1, 7, 7], [0, 0, 0]]) {
      const evidence = join(directory, "cleanup.json");
      rmSync(evidence, { force:true });
      const script = `set -e
output="$TEST_OUTPUT"
cleanup() { return "$TEST_CLEANUP"; }
${handler}
trap on_exit EXIT
exit "$TEST_STATUS"
`;
      const result = spawnSync(bash, ["-c", script], {
        encoding:"utf8", env:{ ...process.env, TEST_OUTPUT:directory, TEST_CLEANUP:String(cleanupStatus), TEST_STATUS:String(requestedStatus) },
      });
      assert.equal(result.status, expectedStatus, result.stderr);
      if (cleanupStatus) assert.deepEqual(JSON.parse(readFileSync(evidence, "utf8")), { removed:false, reason:"cleanup unconfirmed" });
      else assert.throws(() => readFileSync(evidence), { code:"ENOENT" });
    }
  } finally { rmSync(directory, { recursive:true, force:true }); }
});


test("failed or invalid create stdout never becomes a trusted cleanup ID", () => {
  const source = readFileSync(resolve("scripts/benchmark-seasonal-resource-proof.sh"), "utf8").replace(/\r\n/g, "\n");
  const cleanStart = source.indexOf("cleanup() {"), cleanEnd = source.indexOf("\ntrap on_exit EXIT", cleanStart);
  const hashStart = source.indexOf("if created=$(docker create"), hashEnd = source.indexOf("\nfi\nhash_id=", hashStart);
  const runStart = source.indexOf("    if created=$(docker create", hashEnd), runEnd = source.indexOf("\n    fi\n    echo", runStart);
  assert.ok(cleanStart >= 0 && cleanEnd > cleanStart && hashStart >= 0 && hashEnd > hashStart && runStart > hashEnd && runEnd > runStart);
  const cleanupAndTrap = source.slice(cleanStart, cleanEnd), creates = [source.slice(hashStart, hashEnd + "\nfi".length), source.slice(runStart, runEnd + "\n    fi".length)];
  const directory = mkdtempSync(join(tmpdir(), "seasonal-create-")), owner = "a".repeat(32), owned = "b".repeat(64), foreign = "c".repeat(64);
  try {
    for (const [index, create] of creates.entries()) for (const scenario of [
      { name: "failed-partial-id", result: foreign, fail: true, status: 1 },
      { name: "invalid-id", result: "partial", status: 1 },
      { name: "success", result: owned, status: 0 },
      { name: "inspection-failed", result: foreign, fail: true, inspectFail: true, status: 1 },
    ]) {
      const calls = join(directory, `create-${index}-${scenario.name}`), evidence = join(directory, "cleanup.json");
      rmSync(evidence, { force: true });
      const script = `set -eu\nactive_id=''\nactive_name=owned\ntoken="$TEST_OWNER"\noutput="$TEST_OUTPUT"\nimage_id=image\npayload=/tmp\nbackend=rust\ndocker() { case "$1" in create) printf '%s\n' "$TEST_CREATE"; [[ "$TEST_CREATE_FAIL" == 0 ]];; inspect) [[ "$TEST_INSPECT_FAIL" == 0 ]] || return 1; printf '%s %s\n' "$TEST_OWNER" "$TEST_ID";; rm) printf '%s\n' "$3" >> "$TEST_CALLS";; container) printf '';; *) return 1;; esac; }\n${cleanupAndTrap}\ntrap on_exit EXIT\n${create}\n`;
      const result = spawnSync(bash, ["-c", script], { encoding: "utf8", env: { ...process.env, TEST_OWNER: owner, TEST_OUTPUT: directory, TEST_CALLS: calls, TEST_ID: owned, TEST_CREATE: scenario.result, TEST_CREATE_FAIL: scenario.fail ? "1" : "0", TEST_INSPECT_FAIL: scenario.inspectFail ? "1" : "0" } });
      assert.equal(result.status, scenario.status, `${index}/${scenario.name}: ${result.stderr}`);
      if (scenario.inspectFail) { assert.deepEqual(JSON.parse(readFileSync(evidence, "utf8")), { removed: false, reason: "cleanup unconfirmed" }); assert.throws(() => readFileSync(calls), { code: "ENOENT" }); }
      else { assert.equal(readFileSync(calls, "utf8").trim(), owned); assert.throws(() => readFileSync(evidence), { code: "ENOENT" }); }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('unexpected Docker image ID is retained as JSON before the release guard refuses it',()=>{
  const source=readFileSync(resolve('scripts/benchmark-seasonal-resource-proof.sh'),'utf8').replace(/\r\n/g,'\n');
  const start=source.indexOf('image_id=$(docker image inspect'),end=source.indexOf('[[ $(docker image inspect "$image_id"',start);
  assert.ok(start>=0 && end>start);
  const fragment=source.slice(start,end),directory=mkdtempSync(join(tmpdir(),'seasonal-image-id-'));
  try {
    for(const [observed,status] of [[image,0],['sha256:'+('a'.repeat(64)),1],['bad"id',1]]) {
      const script=`set -eu\noutput="$TEST_OUTPUT"\nrelease_tag=release\nrelease_image_id="$TEST_EXPECTED"\ndocker() { printf '%s' "$TEST_OBSERVED"; }\n${fragment}`;
      const result=spawnSync(bash,['-c',script],{encoding:'utf8',env:{...process.env,TEST_OUTPUT:directory,TEST_EXPECTED:image,TEST_OBSERVED:observed}});
      assert.equal(result.status,status,result.stderr);
      assert.deepEqual(JSON.parse(readFileSync(join(directory,'image-observation.json'),'utf8')),{observedImageId:observed,expectedConfigDigest:image});
    }
  } finally {rmSync(directory,{recursive:true,force:true});}
});


test('empty timed-out run reports the missing JSON instead of a parsing error',()=>{
  const directory=mkdtempSync(join(tmpdir(),'seasonal-empty-report-'));
  try {
    writeFileSync(join(directory,'seasonal-round1-typescript.json'),'');
    const result=spawnSync(process.execPath,[resolve('scripts/summarize-seasonal-resource-proof.mjs'),directory],{encoding:'utf8'});
    assert.notEqual(result.status,0);
    assert.match(result.stderr,/seasonal-round1-typescript\.json: no JSON report \(run failed or timed out\)/);
    assert.doesNotMatch(result.stderr,/SyntaxError/);
  } finally {rmSync(directory,{recursive:true,force:true});}
});
