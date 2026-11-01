// Arena predicates, sampling recipe and history oracle are unchanged.
import assert from "node:assert/strict";
import {runRustUiBrowser} from "./lib/benchmark-rust-ui-browser.mjs";
const conditions = {
  viewport: { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, locale: "ru-RU", cookie: "lang=ru", cpuSlowdown: 4,
  network: { name: "DevTools Fast 4G", offline: false, latency: 60 * 2.75,
    downloadThroughput: 9 * 1000 * 1000 / 8 * 0.9, uploadThroughput: 1.5 * 1000 * 1000 / 8 * 0.9, connectionType: "cellular4g" },
  warmPairs: 6, coldPairs: 4, backendCache: "warm selected + unfiltered context, independent production caches",
  coldMeaning: "fresh Chrome process/profile and empty browser HTTP cache; OS and all compilation caches are not guaranteed reset",
  warmMeaning: "retained Chrome process/profile, enabled HTTP cache, normal reload; one uncounted warmup per frontend",
  observation: "useful DOM is 300 scanned + 300 sampled + five numeric metric cards; controls require two enabled ranges; DOM time is not paint or INP",
  settling: "at least 1s after controls, loaded document and 500ms network quiet; fail if unfinished after 10s more",
  serverExecution: "actual image artifacts on the Linux host through two production Caddy fronts; no CPU/RAM-wide or container-budget claim",
  baseline: "current production Next artifact with the migration ingress boolean enabled; not a historical pre-port release",
  ancillary: "Legacy regular/PvE automatic average prefetch can return503 because this fixture seeds Arena only. These requests/bytes/statuses stay in totals; only that precise ancillary503 is excluded from Arena correctness failure.",
};
const references = [
  "https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md",
  "https://github.com/nodejs/learn/blob/main/pages/getting-started/websocket.md",
  "https://developer.chrome.com/blog/remote-debugging-port",
  "https://chromedevtools.github.io/devtools-protocol/tot/Emulation/",
  "https://chromedevtools.github.io/devtools-protocol/tot/Network/",
  "https://chromium.googlesource.com/devtools/devtools-frontend/+/HEAD/front_end/core/sdk/NetworkManager.ts",
];
const instrumentation = String.raw`(() => {
  const state = { usefulDomMs:null, controlsReadyMs:null, fcpMs:null, lcpMs:null, cls:0, supported:[], errors:[] };
  let sessionStart=0,lastShift=0,sessionValue=0;
  function inspect() {
    const count=document.querySelector('.summary-strip__number')?.textContent.replace(/\D/g,'');
    const metrics=[...document.querySelectorAll('.metric-card__value')].map(el=>el.textContent.trim());
    const sample=document.querySelector('.sample-status')?.textContent.replace(/\D/g,'');
    const useful=count==='300' && sample==='300' && metrics.length===5 && metrics.every(v=>/\d/.test(v)&&!/[—…]/.test(v));
    if(useful && state.usefulDomMs===null)state.usefulDomMs=performance.now();
    const ranges=[...document.querySelectorAll('input[type=range]')];
    if(useful&&ranges.length===2&&ranges.every(el=>!el.disabled)&&state.controlsReadyMs===null)state.controlsReadyMs=performance.now();
    return {count,sample,metrics,ranges:ranges.map(el=>({disabled:el.disabled,value:el.value})),lang:document.documentElement?.lang,visibility:document.visibilityState};
  }
  const observers=[];
  function observe(type, callback) {
    if(!PerformanceObserver.supportedEntryTypes.includes(type)){state.errors.push('unsupported:'+type);return;}
    state.supported.push(type);const observer=new PerformanceObserver(list=>callback(list.getEntries()));observer.observe({type,buffered:true});observers.push({observer,callback});
  }
  observe('paint',entries=>{for(const e of entries)if(e.name==='first-contentful-paint')state.fcpMs=e.startTime;});
  observe('largest-contentful-paint',entries=>{for(const e of entries)state.lcpMs=e.startTime;});
  observe('layout-shift',entries=>{for(const e of entries)if(!e.hadRecentInput){if(e.startTime-lastShift>1000||e.startTime-sessionStart>5000){sessionStart=e.startTime;sessionValue=0;}sessionValue+=e.value;lastShift=e.startTime;state.cls=Math.max(state.cls,sessionValue);}});
  new MutationObserver(inspect).observe(document,{subtree:true,childList:true,attributes:true,characterData:true});
  window.__rustArenaBenchmark={snapshot(){for(const{observer,callback}of observers)callback(observer.takeRecords());const dom=inspect();const html=document.documentElement?.outerHTML || '';const n=performance.getEntriesByType('navigation')[0];return{...state,dom,timeOrigin:performance.timeOrigin,now:performance.now(),navigation:n?{ttfbMs:n.responseStart-n.startTime,loadMs:n.loadEventEnd-n.startTime,responseStatus:n.responseStatus,type:n.type}:null,marker:html.includes('/_rust/arena/')?'rust':html.includes('/_next/')?'next':'missing'};}};
  inspect();
})();`;

async function checkHistory(tab,backend,{results,until}) {
  await tab.send("Page.bringToFront");
  const last=new URL(tab.url);last.search="arenaMode=lastHero&arenaStatistic=median&arena_lastHero_minMatches=85";
  const checkpoint=new URL(tab.url);checkpoint.search="arenaMode=checkpoint&arenaStatistic=trimmed_mean&arena_checkpoint_minMatches=10";
  const api=new URL("/api/average?mode=arena&arenaMode=lastHero&statistic=median&dimension=matches&metric=players&minMatches=85",tab.url);
  const reply=await fetch(api,{signal:AbortSignal.timeout(20000)});assert.equal(reply.status,200);
  const expected=await reply.json();assert.equal(expected.filterIdentity.minMatches,85);assert.ok(expected.sampleN>0);
  const view=async(mode,statistic,min,count)=>until(async()=>{
    const actual=await tab.evaluate(String.raw`(()=>({mode:document.querySelector('#arena-mode-${mode}')?.getAttribute('aria-pressed'),statistic:document.querySelector('input[type=radio][value=${statistic}]')?.checked,min:document.querySelector('input[type=number]')?.value,sample:document.querySelector('.sample-status')?.textContent.replace(/\D/g,''),enabled:[...document.querySelectorAll('input[type=range]')].filter(el=>!el.disabled).length,href:location.href}))()`);
    return actual.mode==="true"&&actual.statistic===true&&actual.min===String(min)&&actual.sample===String(count)&&actual.enabled===2?actual:false;
  },30000,`${backend}: history restores ${mode}/${statistic}/${min}`);
  const push=async(url)=>tab.evaluate(`history.pushState(history.state,'',${JSON.stringify(url.href)});dispatchEvent(new PopStateEvent('popstate',{state:history.state}));`);
  await push(last);await view("lastHero","median",85,expected.sampleN);
  await push(checkpoint);await view("checkpoint","trimmed_mean",10,300);
  await tab.evaluate("history.back()");const back=await view("lastHero","median",85,expected.sampleN);
  assert.equal(new URL(back.href).searchParams.get("arena_lastHero_minMatches"),"85");
  await tab.evaluate("history.forward()");const forward=await view("checkpoint","trimmed_mean",10,300);
  results.functional.push({backend,historyBack:back,historyForward:forward,expectedLastHeroSampleN:expected.sampleN});
}

async function validate({snapshot,requests,tab,backend}) {
  assert.equal(snapshot.dom.lang,"ru");assert.equal(snapshot.dom.visibility,"visible");assert.equal(snapshot.dom.count,"300");assert.equal(snapshot.dom.sample,"300");
  assert.equal(snapshot.dom.metrics.length,5);assert.ok(snapshot.dom.ranges.every(value=>!value.disabled));
  assert.deepEqual(tab.state.exceptions,[],`${backend}: uncaught browser exceptions`);assert.deepEqual(snapshot.errors,[]);
  const ancillary=request=>{const url=new URL(request.url);return url.pathname==="/api/average"&&["regular","pve"].includes(url.searchParams.get("mode"));};
  assert.ok(!requests.some(request=>request.status>=500&&!(ancillary(request)&&request.status===503)),`${backend}: unexpected server5xx`);
  for(const request of requests.filter(request=>{const url=new URL(request.url);return url.pathname==="/api/average"&&url.searchParams.get("mode")==="arena";})){
    assert.equal(request.status,200,`${backend}: Arena API status`);
    const reply=await tab.send("Network.getResponseBody",{requestId:request.id});
    const body=JSON.parse(reply.base64Encoded?Buffer.from(reply.body,"base64").toString("utf8"):reply.body);
    assert.equal(body.mode,"arena");assert.equal(body.schemaVersion,5);assert.equal(body.sampleN,300);
    assert.equal(body.filterIdentity.mode,new URL(request.url).searchParams.get("arenaMode"));
    request.validation={mode:body.mode,schemaVersion:body.schemaVersion,sampleN:body.sampleN,filterIdentity:body.filterIdentity};
  }
  assert.ok(!requests.some(request=>request.error&&!request.canceled),`${backend}: failed resource`);
  assert.ok(!requests.some(request=>request.status>=400&&(request.type==="Script"||request.type==="Stylesheet"||request.url.includes(".wasm"))),`${backend}: missing application asset`);

  return requests.filter(ancillary).map(({url,status,bytes})=>({url,status,bytes}));
}
await runRustUiBrowser({conditions,references,instrumentation,validate,functional:checkHistory,outputEnvironment:"ARENA_BROWSER_OUTPUT",defaultOutput:"arena-browser-evidence",profilePrefix:"tarkov-arena-cdp-",fixtureScript:"scripts/serve-rust-arena-benchmark.mjs",fixtureEvent:"rust_arena_browser_ready",title:"# Arena browser comparison",completionEvent:"rust_arena_browser_benchmark_complete"});
