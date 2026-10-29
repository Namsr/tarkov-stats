import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { validateArenaProof } from './summarize-arena-resource-proof.mjs';
const productionImage = 'sha256:d64895bb623aaa921ff775ae02b1a8dc4dca80b3d57fa8bdbba19b67f9edabc7';
const image = 'sha256:66b12d087fbcf4a2e133c8ca05032d78747d94983b5a236b41a37138a5dfc9fb';
const revision = '0a705c50ae9764d72d714c00e7027ebebadadf22';
const native = 'f2e4ee25851e890a312fe29540778140bcac6de4059425fd3dcba54d5e62618c';
const provenance = { testedImageId: image, productionImageId: productionImage, imageIdentityMatchesProduction: false, releaseTag: `tarkovstats-web:${revision}`, sourceRevision: revision, nativeSha256: native, archiveSha256: 'fd6848ec3753e626c8c9e6e5c5c569562e8f72a802a513a67be6dc069e7ce60a', hashContainerId: 'f'.repeat(64), hashContainerImageId: image, hashContainerRemoved: true, ownershipToken: 'b'.repeat(32) };
const initialFields = ['testedImageId','productionImageId','imageIdentityMatchesProduction','releaseTag','sourceRevision','archiveSha256'];
const initial = Object.fromEntries(initialFields.map(field => [field, provenance[field]]));
const memory = 512 * 1024 ** 2;
function fakeRuns() {
  return ['typescript','rust','rust','typescript'].map((backend,index) => {
    const results=[{backend,scenario:'first_request_fresh_worker',coldHttpMs:1,phases:{}}];
    for(const scenario of ['matched','population']) for(const statistic of ['median','trimmed_mean']) for(const [cache,concurrency] of [['miss',1],['miss',4],['hit',4]]) {
      const miss=cache==='miss', dist=count=>({samples:count,p50Ms:count?1:null,p95Ms:count?2:null,maxMs:count?3:null});
      const raw=Array.from({length:20},(_,i)=>i<10?1:i<19?2:3);
      const arenaMode=scenario==='matched'?'lastHero':'overall';
      const rawSamples=raw.map((totalMs,i)=>{const aid=(scenario==='matched'?100001:100005)+(i%concurrency); return {
        query:new URLSearchParams({mode:'arena',aid:String(aid),statistic,period:'all',arenaMode}).toString(),status:200,totalMs,phases:{total:totalMs},
        body:{aid,gameMode:'arena',mode:arenaMode,strategy:scenario,statistic,sampleN:100,identity:{aid,mode:'arena',cycleId:'persistent',arenaMode},metrics:{kd_ratio:{value:2.5,count:100}},coverage:{fraction:.5},reason:null}
      };});
      results.push({backend,scenario,statistic,cache,concurrency,errors:[],http:dist(20),server:dist(20),queue:dist(miss?20:0),worker:dist(miss?20:0),rawSamples,rawQueueMs:miss?raw:[],rawWorkerMs:miss?raw:[],workerJobs:miss?20:0,workerBackends:miss?[backend]:[],cacheHits:miss?0:20,responseBytes:500});
    }
    return {report:{formatVersion:1,environment:{os:'linux',node:'v22.0.0'},fixture:{mode:'arena',players:100000,peerAccounts:100000,normalizedPeerRows:200000,owners:8,synthetic:true},
      methodology:{iterations:20,backendSelection:backend,backendOrder:[backend],warmupRequestsPerScenario:1},results,
      resourceResults:[{backend,available:true,workerCpuMs:1,workers:[{peakWorkingSetBytes:100}]}],
      containerResources:{available:true,version:2,memory:{maxBytes:memory,swapMaxBytes:0,peakBytes:1000},cpu:{quotaUs:50000,periodUs:100000,usageUs:10,userUs:8,systemUs:2},memoryEvents:{oomKill:0}}},
      inspect:{owner:provenance.ownershipToken,id:String(index+1).repeat(64),imageId:image,sourceRevision:revision,exitCode:0,oomKilled:false,user:'nextjs',network:'none',ipcMode:'private',readOnly:true,memory,memorySwap:memory,nanoCpus:500000000,pidsLimit:64,privileged:false,capAdd:null,capDrop:['ALL'],securityOpt:['no-new-privileges'],portBindings:null,tmpfs:{'/tmp':'rw,noexec,nosuid,nodev,size=128m,mode=1777'},mounts:['/app/app','/app/tests','/app/scripts/benchmark-rust-cohort.mjs','/app/scripts/benchmark-worker-resources.mjs'].map(Destination=>({Type:'bind',Destination,RW:false}))},
      cleanup:{removed:true,runnerExit:0},timing:{startedAt:'2026-10-28T00:00:00Z',finishedAt:'2026-10-28T00:00:01Z',elapsedSeconds:1}};
  });
}
test('Arena proof requires complete paired scenarios, fixed image, resource bounds and owned cleanup',()=>{
  const good=fakeRuns(); validateArenaProof(good,provenance,initial);
  const rounded=structuredClone(good); rounded[1].report.results[1].rawSamples[0].body.metrics.kd_ratio.value += 1e-13; validateArenaProof(rounded,provenance,initial);
  for(const mutate of [
    runs=>{runs[1].inspect.id=runs[0].inspect.id;},
    runs=>{runs[1].report.results.pop();},
    runs=>{runs[1].report.results[1].workerJobs=19;},
    runs=>{runs[1].report.results[1].errors.push('error');},
    runs=>{runs[1].report.containerResources.cpu.usageUs=null;},
    runs=>{runs[2].inspect.oomKilled=true;},
    runs=>{runs[1].inspect.mounts.push({Type:'bind',Destination:'/app/lib',RW:false});},
    runs=>{runs[3].cleanup.removed=false;},
    runs=>{runs[0].report.fixture.players=30000;},
    runs=>{runs[2].report.fixture.normalizedPeerRows=100000;},
    runs=>{runs[1].report.results[1].rawSamples.pop();},
    runs=>{runs[1].report.results[1].http.p95Ms=99;},
    runs=>{runs[1].report.results[1].rawSamples[0].body.metrics.kd_ratio.value=3;},
    runs=>{runs[1].report.results[1].rawSamples[0].body.metrics.kd_ratio.count=99;},
    runs=>{runs[1].report.results[1].rawSamples[0].body.reason='wrong';},
    runs=>{runs[1].report.results[1].rawSamples[0].query='wrong';},
    runs=>{runs[1].report.results[1].rawQueueMs[0]=Number.NaN;},
  ]) {const invalid=structuredClone(good);mutate(invalid);assert.throws(()=>validateArenaProof(invalid,provenance,initial));}
  assert.throws(()=>validateArenaProof(good,{...provenance,archiveSha256:'f'.repeat(64)},{...initial,archiveSha256:'f'.repeat(64)}));
  assert.throws(()=>validateArenaProof(good,{...provenance,sourceRevision:'c'.repeat(40)},{...initial,sourceRevision:'c'.repeat(40)}));
  assert.throws(()=>validateArenaProof(good,{...provenance,testedImageId:'not-an-image',hashContainerImageId:'not-an-image'},{...initial,testedImageId:'not-an-image'}));
  assert.throws(()=>validateArenaProof(good,{...provenance,imageIdentityMatchesProduction:true},{...initial,imageIdentityMatchesProduction:true}));
  assert.throws(()=>validateArenaProof(good,{...provenance,hashContainerImageId:productionImage},initial));
  const wrongContainer=structuredClone(good); wrongContainer[1].inspect.imageId=productionImage;
  assert.throws(()=>validateArenaProof(wrongContainer,provenance,initial));
  assert.throws(()=>validateArenaProof(good,provenance,{...initial,testedImageId:productionImage}));
  assert.throws(()=>validateArenaProof(good,{...provenance,nativeSha256:'f'.repeat(64)},initial));
  assert.throws(()=>validateArenaProof(good,{...provenance,hashContainerRemoved:false},initial));
});
test('manual workflow and runner keep the pinned source and bounded isolated recipe',()=>{
  const workflow=readFileSync(new URL('../.github/workflows/vps-image.yml',import.meta.url),'utf8');
  const runner=readFileSync(new URL('./benchmark-arena-resource-proof.sh',import.meta.url),'utf8');
  assert.match(workflow,/workflow_dispatch:/);assert.doesNotMatch(workflow,/\b(?:push|pull_request):/);
  assert.match(workflow,/fd6848ec3753e626c8c9e6e5c5c569562e8f72a802a513a67be6dc069e7ce60a/);
  assert.match(workflow,/\[\[ \$expected == fd6848/);
  assert.ok(workflow.indexOf('[[ $expected == fd6848') < workflow.indexOf('docker --context default load'));
  assert.match(workflow,/contents: read/);assert.doesNotMatch(workflow,/docker\s+build|release upload|npm ci|cargo build/);
  assert.match(workflow,/git diff --exit-code "\$SOURCE_REVISION" -- app lib rust tests\/fixtures/);
  assert.ok(runner.indexOf('image-provenance.json') < runner.indexOf('arena-proof-hash-'));
  assert.match(runner,/--rows 100000 --iterations 20/);assert.match(runner,/--pids-limit 64/);
  assert.match(runner,/--memory 512m --memory-swap 512m/);assert.match(runner,/--kill-after=15s 480s/);
  assert.match(runner,/--network none --ipc private/);assert.match(runner,/backends=\(rust typescript\)/);
  assert.match(runner,/benchmark-arena-resource-driver\.mjs/); assert.match(runner,/driver-source\.sha256/); assert.match(runner,/driver\.patch/);
});

const bash = process.platform === "win32"
  ? resolve(execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim(), "../../../bin/bash.exe") : "bash";

test("Arena image cleanup removes only owned containers and requires positive absence proof", () => {
  const source = readFileSync(resolve("scripts/benchmark-arena-resource-proof.sh"), "utf8").replace(/\r\n/g, "\n");
  const start = source.indexOf("cleanup() {"), end = source.indexOf("\non_exit() {", start);
  assert.ok(start >= 0 && end > start);
  const cleanup = source.slice(start, end);
  assert.match(source, /docker\(\) \{ timeout --signal=TERM --kill-after=5s 15s/);
  assert.ok(source.includes('--label "org.tarkovstats.arena-proof=$token"'));
  assert.ok(source.includes('if created=$(docker create'));
  const directory = mkdtempSync(join(tmpdir(), "arena-cleanup-"));
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


test("Arena exit trap fails closed on unconfirmed cleanup without masking a prior failure", () => {
  const source = readFileSync(resolve("scripts/benchmark-arena-resource-proof.sh"), "utf8").replace(/\r\n/g, "\n");
  const start = source.indexOf("on_exit() {"), end = source.indexOf("\ntrap on_exit EXIT", start);
  assert.ok(start >= 0 && end > start);
  const handler = source.slice(start, end), directory = mkdtempSync(join(tmpdir(), "arena-cleanup-exit-"));
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
  const source = readFileSync(resolve("scripts/benchmark-arena-resource-proof.sh"), "utf8").replace(/\r\n/g, "\n");
  const cleanStart = source.indexOf("cleanup() {"), cleanEnd = source.indexOf("\ntrap on_exit EXIT", cleanStart);
  const hashStart = source.indexOf("if created=$(docker create"), hashEnd = source.indexOf("\nfi\nhash_id=", hashStart);
  const runStart = source.indexOf("    if created=$(docker create", hashEnd), runEnd = source.indexOf("\n    fi\n    echo", runStart);
  assert.ok(cleanStart >= 0 && cleanEnd > cleanStart && hashStart >= 0 && hashEnd > hashStart && runStart > hashEnd && runEnd > runStart);
  const cleanupAndTrap = source.slice(cleanStart, cleanEnd), creates = [source.slice(hashStart, hashEnd + "\nfi".length), source.slice(runStart, runEnd + "\n    fi".length)];
  const directory = mkdtempSync(join(tmpdir(), "arena-create-")), owner = "a".repeat(32), owned = "b".repeat(64), foreign = "c".repeat(64);
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
