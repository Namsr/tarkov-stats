import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { validatePveProof } from './summarize-pve-resource-proof.mjs';
const productionImage = 'sha256:d64895bb623aaa921ff775ae02b1a8dc4dca80b3d57fa8bdbba19b67f9edabc7';
const image = `sha256:${'e'.repeat(64)}`;
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
      results.push({backend,scenario,statistic,cache,concurrency,errors:[],http:dist(20),server:dist(20),queue:dist(miss?20:0),worker:dist(miss?20:0),workerJobs:miss?20:0,workerBackends:miss?[backend]:[],cacheHits:miss?0:20,responseBytes:500});
    }
    return {report:{formatVersion:1,environment:{os:'linux',node:'v22.0.0'},fixture:{mode:'pve',players:100000,peerAccounts:100000,normalizedPeerRows:100000,owners:8,synthetic:true},
      methodology:{iterations:20,backendSelection:backend,backendOrder:[backend],warmupRequestsPerScenario:1},results,
      resourceResults:[{backend,available:true,workerCpuMs:1,workers:[{peakWorkingSetBytes:100}]}],
      containerResources:{available:true,version:2,memory:{maxBytes:memory,swapMaxBytes:0,peakBytes:1000},cpu:{quotaUs:50000,periodUs:100000,usageUs:10,userUs:8,systemUs:2},memoryEvents:{oomKill:0}}},
      inspect:{owner:provenance.ownershipToken,id:String(index+1).repeat(64),imageId:image,sourceRevision:revision,exitCode:0,oomKilled:false,user:'nextjs',network:'none',ipcMode:'private',readOnly:true,memory,memorySwap:memory,nanoCpus:500000000,pidsLimit:64,privileged:false,capAdd:null,capDrop:['ALL'],securityOpt:['no-new-privileges'],portBindings:null,tmpfs:{'/tmp':'rw,noexec,nosuid,nodev,size=128m,mode=1777'},mounts:['/app/app','/app/tests','/app/scripts/benchmark-rust-cohort.mjs','/app/scripts/benchmark-worker-resources.mjs'].map(Destination=>({Type:'bind',Destination,RW:false}))},
      cleanup:{removed:true,runnerExit:0},timing:{startedAt:'2026-10-28T00:00:00Z',finishedAt:'2026-10-28T00:00:01Z',elapsedSeconds:1}};
  });
}
test('PvE proof requires complete paired scenarios, fixed image, resource bounds and owned cleanup',()=>{
  const good=fakeRuns(); validatePveProof(good,provenance,initial);
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
  ]) {const invalid=structuredClone(good);mutate(invalid);assert.throws(()=>validatePveProof(invalid,provenance,initial));}
  assert.throws(()=>validatePveProof(good,{...provenance,archiveSha256:'f'.repeat(64)},{...initial,archiveSha256:'f'.repeat(64)}));
  assert.throws(()=>validatePveProof(good,{...provenance,sourceRevision:'c'.repeat(40)},{...initial,sourceRevision:'c'.repeat(40)}));
  assert.throws(()=>validatePveProof(good,{...provenance,testedImageId:'not-an-image',hashContainerImageId:'not-an-image'},{...initial,testedImageId:'not-an-image'}));
  assert.throws(()=>validatePveProof(good,{...provenance,imageIdentityMatchesProduction:true},{...initial,imageIdentityMatchesProduction:true}));
  assert.throws(()=>validatePveProof(good,{...provenance,hashContainerImageId:productionImage},initial));
  const wrongContainer=structuredClone(good); wrongContainer[1].inspect.imageId=productionImage;
  assert.throws(()=>validatePveProof(wrongContainer,provenance,initial));
  const matching=structuredClone(good); for(const run of matching) run.inspect.imageId=productionImage;
  validatePveProof(matching,{...provenance,testedImageId:productionImage,hashContainerImageId:productionImage,imageIdentityMatchesProduction:true},
    {...initial,testedImageId:productionImage,imageIdentityMatchesProduction:true});
  assert.throws(()=>validatePveProof(good,provenance,{...initial,testedImageId:productionImage}));
  assert.throws(()=>validatePveProof(good,{...provenance,nativeSha256:'f'.repeat(64)},initial));
  assert.throws(()=>validatePveProof(good,{...provenance,hashContainerRemoved:false},initial));
});
test('manual workflow and runner keep the pinned source and bounded isolated recipe',()=>{
  const workflow=readFileSync(new URL('../.github/workflows/vps-image.yml',import.meta.url),'utf8');
  const runner=readFileSync(new URL('./benchmark-pve-resource-proof.sh',import.meta.url),'utf8');
  assert.match(workflow,/workflow_dispatch:/);assert.doesNotMatch(workflow,/\b(?:push|pull_request):/);
  assert.match(workflow,/fd6848ec3753e626c8c9e6e5c5c569562e8f72a802a513a67be6dc069e7ce60a/);
  assert.match(workflow,/\[\[ \$expected == fd6848/);
  assert.ok(workflow.indexOf('[[ $expected == fd6848') < workflow.indexOf('docker --context default load'));
  assert.match(workflow,/contents: read/);assert.doesNotMatch(workflow,/docker\s+build|release upload|npm ci|cargo build/);
  assert.match(workflow,/git diff --exit-code "\$SOURCE_REVISION" -- app lib rust tests\/fixtures/);
  assert.ok(runner.indexOf('image-provenance.json') < runner.indexOf('pve-proof-hash-'));
  assert.match(runner,/--rows 100000 --iterations 20/);assert.match(runner,/--pids-limit 64/);
  assert.match(runner,/--memory 512m --memory-swap 512m/);assert.match(runner,/--kill-after=15s 240s/);
  assert.match(runner,/--network none --ipc private/);assert.match(runner,/backends=\(rust typescript\)/);
});
