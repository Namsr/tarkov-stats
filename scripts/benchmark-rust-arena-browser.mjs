// Authoritative synthetic browser comparison: Linux GitHub Actions only.
// No application source, API responses or request routing are replaced here.
// Node 22's built-in WebSocket drives the Chrome DevTools Protocol directly.
// Primary references are saved in every result for the exact emulation recipe.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, release } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

assert.equal(process.platform, "linux", "Run this benchmark on Linux CI, never the user's active PC");
assert.equal(process.env.GITHUB_ACTIONS, "true", "Only the isolated GitHub runner supplies authoritative timings");
assert.equal(Number(process.versions.node.split(".")[0]), 22, "Use the declared Node 22 runtime");
assert.equal(typeof WebSocket, "function");
const output = resolve(process.env.ARENA_BROWSER_OUTPUT || "arena-browser-evidence");
await mkdir(output, { recursive: true });
const chrome = process.env.CHROME_BIN || ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/opt/google/chrome/chrome"].find(existsSync);
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
const results = { schemaVersion: 1, conditions, references, versions: { node: process.version, platform: process.platform,
  kernel: release(), runnerImage: process.env.ImageVersion || null, runnerOS: process.env.ImageOS || null,
  chromeCommand: null, caddy: null,
  image: process.env.ARENA_BENCH_IMAGE, imageId: process.env.ARENA_BENCH_IMAGE_ID, imageNode: process.env.ARENA_BENCH_IMAGE_NODE,
  head: process.env.GITHUB_SHA }, fixture: null, warmups: [], samples: [], functional: [], failure: null };
const owned = new Set(), profiles = new Set(), processLogs = [];
let fixture, stopping;
let cancelled = false;
function requireRunning() { if (cancelled) throw new Error("Browser benchmark cancelled"); }
const save = () => writeFile(join(output, "raw.json"), JSON.stringify(results, null, 2) + "\n");
function start(executable, args, options = {}) {
  requireRunning();
  const child = spawn(executable, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], ...options });
  let text = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (value) => { text = (text + value).slice(-256000); });
  const closed = new Promise((done) => { child.once("error", (error) => done({ error: String(error) })); child.once("close", (code, signal) => done({ code, signal })); });
  const record = { child, closed, name: basename(executable), text: () => text }; owned.add(record); processLogs.push(record); return record;
}
async function stop(record, graceful = false) {
  if (!record) return;
  if (record.stopping) return record.stopping;
  record.stopping = (async () => {
    if (record.child.exitCode === null && record.child.signalCode === null) {
      if (graceful && record.child.stdin.writable) record.child.stdin.end("stop\n");
      else record.child.kill("SIGTERM");
    }
    // The fixture may still be cancelling a 30s readiness wait before reaping its children.
    const timer = setTimeout(() => { if (record.child.exitCode === null && record.child.signalCode === null) record.child.kill("SIGKILL"); }, graceful ? 60000 : 10000);
    try { return await record.closed; } finally { clearTimeout(timer); owned.delete(record); }
  })();
  return record.stopping;
}
async function removeProfile(profile) {
  assert.equal(dirname(profile), tmpdir()); assert.ok(basename(profile).startsWith("tarkov-arena-cdp-"));
  await rm(profile, { recursive: true, force: true }); profiles.delete(profile);
}

async function cleanup() {
  if (stopping) return stopping;
  cancelled = true;
  stopping = (async () => {
    for (const record of [...owned].reverse()) {
      const status = await stop(record, record === fixture);
      if (record === fixture && status.code !== 0) { results.failure ||= `Fixture cleanup failed: ${JSON.stringify(status)}`; process.exitCode = 1; }
    }
    for (const profile of [...profiles]) await removeProfile(profile);
    results.cleanup = { ownedProcesses: owned.size, profiles: profiles.size };
  })();
  return stopping;
}
function cancel(signal) {
  // Set this before any await: cleanup must never race a newly owned process/profile.
  cancelled = true;
  results.failure ||= `${signal}: benchmark interrupted`;
  // The main finally owns evidence writes and cleanup after in-flight work settles.
  process.exitCode = 1;
}
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => { cancel(signal); });
async function until(check, limit, description) {
  const deadline = Date.now() + limit;
  while (Date.now() < deadline) { requireRunning(); const value = await check(); requireRunning(); if (value) return value; await delay(50); }
  throw new Error(`Timed out: ${description}`);
}
class Cdp {
  constructor(socket) {
    this.socket = socket; this.id = 0; this.pending = new Map(); this.listeners = new Map();
    socket.addEventListener("message", ({ data }) => {
      const value = JSON.parse(data);
      if (value.id) { const call = this.pending.get(value.id); if (!call) return; this.pending.delete(value.id); clearTimeout(call.timer);
        if (value.error) call.reject(new Error(`${call.method}: ${JSON.stringify(value.error)}`)); else call.resolve(value.result); }
      else for (const callback of this.listeners.get(`${value.sessionId || ""}:${value.method}`) || []) callback(value.params);
    });
    socket.addEventListener("close", () => { for (const call of this.pending.values()) { clearTimeout(call.timer); call.reject(new Error(`CDP closed: ${call.method}`)); } this.pending.clear(); });
  }
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((yes, no) => {
      const timer = setTimeout(() => { socket.close(); no(new Error("CDP WebSocket connection timeout")); }, 10000);
      socket.addEventListener("open", () => { clearTimeout(timer); yes(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); no(new Error("CDP WebSocket handshake failed")); }, { once: true });
    });
    return new Cdp(socket);
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((resolve, reject) => { const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP command timeout: ${method}`)); }, 15000);
      this.pending.set(id, { method, resolve, reject, timer });
      try { this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); } });
  }
  on(session, event, callback) { const key = `${session}:${event}`; const values = this.listeners.get(key) || []; values.push(callback); this.listeners.set(key, values); }
  close() { this.socket.close(); }
}
// Observation only: no fetch wrapper, DOM changes, app source or response overrides.
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
  window.__rustArenaBenchmark={snapshot(){for(const{observer,callback}of observers)callback(observer.takeRecords());const dom=inspect();const n=performance.getEntriesByType('navigation')[0];return{...state,dom,timeOrigin:performance.timeOrigin,now:performance.now(),navigation:n?{ttfbMs:n.responseStart-n.startTime,loadMs:n.loadEventEnd-n.startTime,responseStatus:n.responseStatus,type:n.type}:null,marker:document.documentElement.outerHTML.includes('/_rust/arena/')?'rust':document.documentElement.outerHTML.includes('/_next/')?'next':'missing'};}};
  inspect();
})();`;
async function browser() {
  requireRunning();
  // Synchronous allocation + registration prevents a signal between creation and ownership.
  const profile = mkdtempSync(join(tmpdir(), "tarkov-arena-cdp-")); profiles.add(profile);
  const flags = ["--headless=new", "--no-sandbox", "--disable-background-networking", "--disable-component-update", "--disable-default-apps", "--disable-sync", "--metrics-recording-only", "--no-first-run", "--no-default-browser-check", "--remote-debugging-address=127.0.0.1", "--remote-allow-origins=*", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"];
  const process = start(chrome, flags);
  try {
    const endpoint = await until(async () => { if (process.child.exitCode !== null) throw new Error(`Chrome exited: ${process.text()}`); try { return (await readFile(join(profile, "DevToolsActivePort"), "utf8")).trim().split("\n"); } catch { return null; } }, 20000, "Chrome debugging endpoint");
    const cdp = await Cdp.connect(`ws://127.0.0.1:${endpoint[0]}${endpoint[1]}`);
    const version = await cdp.send("Browser.getVersion");
    const protocol = await (await fetch(`http://127.0.0.1:${endpoint[0]}/json/protocol`)).json();
    const commands = new Set(protocol.domains.flatMap(domain => (domain.commands || []).map(command => `${domain.domain}.${command.name}`)));
    for (const name of ["Network.emulateNetworkConditionsByRule", "Network.overrideNetworkState", "Emulation.setCPUThrottlingRate", "Emulation.setLocaleOverride"]) assert.ok(commands.has(name), `${version.product} lacks required ${name}`);
    if (results.versions.chrome) assert.equal(version.product, results.versions.chrome.product, "Chrome version changed inside the series");
    results.versions.chrome = version; results.versions.chromeFlags = flags.map(flag => flag.startsWith("--user-data-dir=") ? "--user-data-dir=<owned fresh profile>" : flag);
    return { process, cdp, profile, async close() { try { await cdp.send("Browser.close").catch(() => {}); } finally { cdp.close(); await stop(process); await removeProfile(profile); } } };
  } catch (error) { await stop(process); await removeProfile(profile); throw error; }
}
async function page(browser, url) {
  const { browserContextId } = await browser.cdp.send("Target.createBrowserContext");
  const { targetId } = await browser.cdp.send("Target.createTarget", { url: "about:blank", browserContextId });
  const { sessionId } = await browser.cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const send = (method, params) => browser.cdp.send(method, params, sessionId);
  const state = { requests: new Map(), exceptions: [], console: [], loaded: false, lastNetwork: Date.now() };
  browser.cdp.on(sessionId, "Network.requestWillBeSent", value => { state.lastNetwork = Date.now(); state.requests.set(value.requestId, { id:value.requestId,url:value.request.url,type:value.type,method:value.request.method,status:null,bytes:0,finished:false }); });
  browser.cdp.on(sessionId, "Network.responseReceived", value => { const request=state.requests.get(value.requestId);if(request)Object.assign(request,{status:value.response.status,mime:value.response.mimeType,fromDiskCache:!!value.response.fromDiskCache,fromServiceWorker:!!value.response.fromServiceWorker,encoding:value.response.headers["content-encoding"]||null}); });
  browser.cdp.on(sessionId, "Network.loadingFinished", value => { state.lastNetwork=Date.now();const request=state.requests.get(value.requestId);if(request)Object.assign(request,{bytes:value.encodedDataLength,finished:true}); });
  browser.cdp.on(sessionId, "Network.loadingFailed", value => { state.lastNetwork=Date.now();const request=state.requests.get(value.requestId);if(request)Object.assign(request,{finished:true,error:value.errorText,canceled:value.canceled}); });
  browser.cdp.on(sessionId, "Runtime.exceptionThrown", value => state.exceptions.push(value.exceptionDetails.text + ": " + (value.exceptionDetails.exception?.description || "")));
  browser.cdp.on(sessionId, "Runtime.consoleAPICalled", value => { if(value.type==="error")state.console.push(value.args.map(arg=>arg.value||arg.description||"").join(" ")); });
  browser.cdp.on(sessionId, "Page.frameNavigated", value => { if (!value.frame.parentId) state.loaded=false; });
  browser.cdp.on(sessionId, "Page.loadEventFired", () => { state.loaded=true; });
  for (const method of ["Page.enable", "Runtime.enable", "Network.enable"]) await send(method);
  await send("Network.setBypassServiceWorker", { bypass:true });
  await send("Emulation.setDeviceMetricsOverride", conditions.viewport);
  await send("Emulation.setCPUThrottlingRate", { rate:conditions.cpuSlowdown });
  await send("Emulation.setLocaleOverride", { locale:conditions.locale });
  await send("Emulation.setTimezoneOverride", { timezoneId:"UTC" });
  await send("Network.setExtraHTTPHeaders", { headers:{"Accept-Language":"ru-RU,ru;q=0.9"} });
  const cookie=await send("Network.setCookie", {name:"lang",value:"ru",url,path:"/",sameSite:"Lax"});assert.ok(cookie.success);
  const network={...conditions.network}; delete network.name;
  await send("Network.emulateNetworkConditionsByRule", {offline:false,matchedNetworkConditions:[{urlPattern:"",latency:network.latency,downloadThroughput:network.downloadThroughput,uploadThroughput:network.uploadThroughput}]});
  await send("Network.overrideNetworkState", network);
  await send("Page.addScriptToEvaluateOnNewDocument", {source:instrumentation});
  return {send,state,url,async evaluate(expression){const value=await send("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});if(value.exceptionDetails)throw new Error(value.exceptionDetails.text);return value.result.value;},async close(){await browser.cdp.send("Target.disposeBrowserContext",{browserContextId});}};
}
function totals(requests) {
  const categories={js:{requests:0,bytes:0},wasm:{requests:0,bytes:0},css:{requests:0,bytes:0},other:{requests:0,bytes:0}};
  for(const request of requests){const path=new URL(request.url).pathname;const kind=path.endsWith(".wasm")?"wasm":request.type==="Script"||/javascript/.test(request.mime||"")?"js":request.type==="Stylesheet"||/text\/css/.test(request.mime||"")?"css":"other";categories[kind].requests++;categories[kind].bytes+=request.bytes;}
  return {requests:requests.length,transferBytes:requests.reduce((sum,value)=>sum+value.bytes,0),categories};
}
async function measurePage(tab, backend, regime, pair, reload) {
  await tab.send("Page.bringToFront");
  const previousOrigin=await tab.evaluate("performance.timeOrigin");
  tab.state.requests.clear();tab.state.exceptions=[];tab.state.console=[];tab.state.loaded=false;
  const response=await tab.send(reload?"Page.reload":"Page.navigate",reload?{ignoreCache:false}:{url:tab.url});
  assert.ok(!response.errorText,response.errorText);
  let snapshot;
  await until(async()=>{try{snapshot=await tab.evaluate("window.__rustArenaBenchmark?.snapshot()");return snapshot?.timeOrigin!==previousOrigin&&snapshot?.controlsReadyMs!==null&&snapshot?.controlsReadyMs!==undefined;}catch(error){if(/context.*destroyed|Cannot find.*context/i.test(String(error)))return false;throw error;}},60000,`${backend}/${regime}/${pair}: useful hydrated controls`);
  const ready=Date.now();
  await until(()=>tab.state.loaded&&Date.now()-ready>=1000&&Date.now()-tab.state.lastNetwork>=500&&[...tab.state.requests.values()].every(request=>request.finished),10000,"post-ready complete network capture");
  snapshot=await tab.evaluate("window.__rustArenaBenchmark.snapshot()");
  const requests=[...tab.state.requests.values()];
  const document=requests.find(request=>request.type==="Document");
  assert.equal(document?.status,200,`${backend}: document status`);assert.equal(snapshot.marker,backend);
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
  const timings={ttfbMs:snapshot.navigation?.ttfbMs,fcpMs:snapshot.fcpMs,lcpMs:snapshot.lcpMs,cls:snapshot.cls,usefulDomMs:snapshot.usefulDomMs,controlsReadyMs:snapshot.controlsReadyMs,loadMs:snapshot.navigation?.loadMs};
  for(const[name,value]of Object.entries(timings))assert.ok(Number.isFinite(value)&&value>=0,`${backend}: missing ${name}`);
  for(const name of ["fcpMs","lcpMs","usefulDomMs","controlsReadyMs","loadMs"])assert.ok(timings[name]>0,`${backend}: missing positive ${name}`);
  const metricValues=snapshot.dom.metrics.map(value=>Number(value.replace(/[\s\u00a0\u202f%]/g,"").replace(",",".")));assert.ok(metricValues.every(Number.isFinite));
  return {backend,regime,pair,timings,metricValues,network:totals(requests),observationMs:snapshot.now,documentStatus:document.status,correctness:snapshot.dom,requests,ancillaryPrefetch:requests.filter(ancillary).map(({url,status,bytes})=>({url,status,bytes})),consoleErrors:tab.state.console};
}
async function measure(...args) {
  try { return await measurePage(...args); }
  catch(error) {
    const [tab,backend,regime,pair]=args;
    results.diagnostics ||= [];
    results.diagnostics.push({backend,regime,pair,requests:[...tab.state.requests.values()],exceptions:tab.state.exceptions,console:tab.state.console,
      snapshot:await tab.evaluate("window.__rustArenaBenchmark?.snapshot()").catch(()=>null)});
    throw error;
  }
}
async function checkHistory(tab,backend) {
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
const quantile=(values,q)=>[...values].sort((a,b)=>a-b)[Math.max(0,Math.ceil(values.length*q)-1)];
async function summary() {
  const rows=["# Arena browser comparison", "", "Synthetic Linux CI evidence only. No local gaming-PC timings are included. No speed threshold gates the build.","", "Both backends are warm and independent. Browser-cold uses a fresh process/profile; this does not claim cold OS/all compilation caches. Warm reloads retain browser cache after one uncounted warmup. CPU 4×; explicit DevTools Fast 4G parameters are in raw.json. DOM-ready is separate from paint and is not INP.","", "The Next baseline is this image's production Next compatibility artifact, including the enabled migration ingress boolean. It is not an earlier pre-port release. Host execution makes no global CPU/RAM/container-budget claim.","", "| Regime | Backend | n | useful DOM median / p95 ms | controls median / p95 ms | FCP median ms | LCP median ms | CLS median | transfer median bytes |", "|---|---|---:|---:|---:|---:|---:|---:|---:|"];
  for(const regime of ["browser-cold","browser-warm-reload"])for(const backend of ["next","rust"]){const samples=results.samples.filter(value=>value.backend===backend&&value.regime===regime);if(!samples.length)continue;const get=(key,q=.5)=>quantile(samples.map(value=>value.timings[key]),q).toFixed(2);rows.push(`|${regime}|${backend}|${samples.length}|${get("usefulDomMs")} / ${get("usefulDomMs",.95)}|${get("controlsReadyMs")} / ${get("controlsReadyMs",.95)}|${get("fcpMs")}|${get("lcpMs")}|${get("cls")}|${quantile(samples.map(value=>value.network.transferBytes),.5)}|`);}
  rows.push("", "| Regime | Backend | requests median | JS bytes median | WASM bytes median | CSS bytes median |", "|---|---|---:|---:|---:|---:|");
  for(const regime of ["browser-cold","browser-warm-reload"])for(const backend of ["next","rust"]){const samples=results.samples.filter(value=>value.backend===backend&&value.regime===regime);if(!samples.length)continue;const bytes=kind=>quantile(samples.map(value=>value.network.categories[kind].bytes),.5);rows.push(`|${regime}|${backend}|${quantile(samples.map(value=>value.network.requests),.5)}|${bytes("js")}|${bytes("wasm")}|${bytes("css")}|`);}
  rows.push("", conditions.ancillary, "", "Small-series p95 is descriptive, not production p95. Raw per-request status/cache/MIME/transferred-byte data and JS/WASM/CSS categories are retained. CDP loadingFinished encodedDataLength counts browser-reported wire transfer; cached resources may be zero.", "", `Failure: ${results.failure || "none"}`, "", "Primary references:", ...references.map(value=>`- ${value}`));
  await writeFile(join(output,"summary.md"),rows.join("\n")+"\n");
}
try {
  assert.ok(chrome, "The official Ubuntu runner must provide Chrome; do not silently switch browser engines");
  results.versions.chromeCommand=execFileSync(chrome,["--version"],{encoding:"utf8"}).trim();
  results.versions.caddy=execFileSync(process.env.CADDY_BIN||"caddy",["version"],{encoding:"utf8"}).trim();
  for(const key of ["image","imageId","imageNode","head"])assert.ok(results.versions[key],`Missing provenance ${key}`);
  await save();
  fixture=start(process.execPath,["--experimental-strip-types","--experimental-sqlite","scripts/serve-rust-arena-benchmark.mjs"]);
  const ready=await until(()=>{if(fixture.child.exitCode!==null)throw new Error(`Fixture exited: ${fixture.text()}`);return fixture.text().split("\n").flatMap(line=>{try{return[JSON.parse(line)];}catch{return[];}}).find(value=>value.event==="rust_arena_browser_ready");},120000,"production fixture readiness");
  results.fixture=ready;
  assert.equal(ready.routing.rust.application,"Caddy -> Rust");assert.equal(ready.routing.next.application,"Caddy -> Next");
  assert.equal(ready.routing.syntheticGateway.applicationRequests,false);assert.equal(ready.routing.syntheticGateway.fallbackStatus,404);
  assert.ok(ready.routing.rust.assets.length>=3&&ready.routing.next.assets.length>=2);
  assert.ok(ready.benchmarkEnvironment.warmCacheQueries?.length>=2,"Both selected and context cache warmup must be disclosed");
  assert.equal(ready.benchmarkEnvironment.players.accounts,300);assert.equal(ready.benchmarkEnvironment.players.shared,true);
  for(const name of ["rust","next"]){assert.equal(ready.benchmarkEnvironment[name].nodeEnv,"production");assert.equal(ready.benchmarkEnvironment[name].durableCacheEnabled,true);}
  assert.notEqual(ready.benchmarkEnvironment.rust.cachePath,ready.benchmarkEnvironment.next.cachePath);
  const urls={next:ready.baselineUrl,rust:ready.url};
  for(let pair=0;pair<conditions.coldPairs;pair++){
    const order=pair%2?["rust","next"]:["next","rust"], batch=[];
    for(const backend of order){const instance=await browser();try{const tab=await page(instance,urls[backend]);await tab.send("Network.setCacheDisabled",{cacheDisabled:true});const sample=await measure(tab,backend,"browser-cold",pair,false);sample.order=order;results.samples.push(sample);batch.push(sample);await save();}finally{await instance.close();}}
    assert.deepEqual(batch[0].metricValues,batch[1].metricValues,`cold pair${pair}: DOM data parity`);
  }
  const instance=await browser();
  try {
    const tabs={next:await page(instance,urls.next),rust:await page(instance,urls.rust)};
    for(const backend of ["next","rust"]){await tabs[backend].send("Network.setCacheDisabled",{cacheDisabled:false});results.warmups.push(await measure(tabs[backend],backend,"uncounted-warmup",0,false));}
    for(let pair=0;pair<conditions.warmPairs;pair++){const order=pair%2?["rust","next"]:["next","rust"], batch=[];for(const backend of order){const sample=await measure(tabs[backend],backend,"browser-warm-reload",pair,true);sample.order=order;results.samples.push(sample);batch.push(sample);await save();}assert.deepEqual(batch[0].metricValues,batch[1].metricValues,`warm pair${pair}: DOM data parity`);}
    for(const backend of ["next","rust"]){await tabs[backend].send("Page.bringToFront");const shot=await tabs[backend].send("Page.captureScreenshot",{format:"png",captureBeyondViewport:false});await writeFile(join(output,`${backend}.png`),Buffer.from(shot.data,"base64"));}
    // Functional only: performed after every timing sample and screenshot.
    for(const backend of ["next","rust"])await checkHistory(tabs[backend],backend);
  } finally {await instance.close();}
  assert.equal(results.samples.length,20);
} catch(error) {results.failure=error.stack||String(error);process.exitCode=1;}
finally {
  try { await save(); await summary(); }
  finally {
    try { await cleanup(); }
    finally {
      await save(); await summary();
      for(let index=0;index<processLogs.length;index++)await writeFile(join(output,`${processLogs[index]===fixture?"fixture":"chrome"}-${index}.log`),processLogs[index].text());
    }
  }
}
console.log(JSON.stringify({event:"rust_arena_browser_benchmark_complete",output,samples:results.samples.length,failure:results.failure}));
