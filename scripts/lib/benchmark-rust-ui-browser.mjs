// Authoritative synthetic browser comparison: Linux GitHub Actions only.
// No application source, API responses or request routing are replaced here.
// Node 22's built-in WebSocket drives the Chrome DevTools Protocol directly.
// Primary references are saved in every result for the exact emulation recipe.
import assert from "node:assert/strict";
import { Cdp } from "./browser-cdp.mjs";
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, release } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export async function runRustUiBrowser(options) {
assert.equal(process.platform, "linux", "Run this benchmark on Linux CI, never the user's active PC");
assert.equal(process.env.GITHUB_ACTIONS, "true", "Only the isolated GitHub runner supplies authoritative timings");
assert.equal(Number(process.versions.node.split(".")[0]), 22, "Use the declared Node 22 runtime");
assert.equal(typeof WebSocket, "function");
const output = resolve(process.env[options.outputEnvironment] || options.defaultOutput);
await mkdir(output, { recursive: true });
const chrome = process.env.CHROME_BIN || ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/opt/google/chrome/chrome"].find(existsSync);
const conditions = options.conditions;
const references = options.references;
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
  assert.equal(dirname(profile), tmpdir()); assert.ok(basename(profile).startsWith(options.profilePrefix));
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
// Observation only: no fetch wrapper, DOM changes, app source or response overrides.
const instrumentation = options.instrumentation;
async function browser() {
  requireRunning();
  // Synchronous allocation + registration prevents a signal between creation and ownership.
  const profile = mkdtempSync(join(tmpdir(), options.profilePrefix)); profiles.add(profile);
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
  if(options.blockedUrls) await send("Network.setBlockedURLs",{urls:options.blockedUrls});
  return {send,state,url,async evaluate(expression){const value=await send("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});if(value.exceptionDetails)throw new Error([value.exceptionDetails.text,value.exceptionDetails.exception?.description].filter(Boolean).join(": "));return value.result.value;},async close(){await browser.cdp.send("Target.disposeBrowserContext",{browserContextId});}};
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
  const ancillaryPrefetch=await options.validate({snapshot,requests,tab,backend});
  const timings={ttfbMs:snapshot.navigation?.ttfbMs,fcpMs:snapshot.fcpMs,lcpMs:snapshot.lcpMs,cls:snapshot.cls,usefulDomMs:snapshot.usefulDomMs,controlsReadyMs:snapshot.controlsReadyMs,loadMs:snapshot.navigation?.loadMs};
  for(const[name,value]of Object.entries(timings))assert.ok(Number.isFinite(value)&&value>=0,`${backend}: missing ${name}`);
  for(const name of ["fcpMs","lcpMs","usefulDomMs","controlsReadyMs","loadMs"])assert.ok(timings[name]>0,`${backend}: missing positive ${name}`);
  const metricValues=snapshot.dom.metrics.map(value=>Number(value.replace(/[\s\u00a0\u202f%]/g,"").replace(",",".")));assert.ok(metricValues.every(Number.isFinite));
  return {backend,regime,pair,timings,metricValues,network:totals(requests),observationMs:snapshot.now,documentStatus:document.status,correctness:snapshot.dom,requests,ancillaryPrefetch,consoleErrors:tab.state.console};
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
const quantile=(values,q)=>[...values].sort((a,b)=>a-b)[Math.max(0,Math.ceil(values.length*q)-1)];
async function summary() {
  const rows=[options.title, "", "Synthetic Linux CI evidence only. No local gaming-PC timings are included. No speed threshold gates the build.","", "Both backends are warm and independent. Browser-cold uses a fresh process/profile; this does not claim cold OS/all compilation caches. Warm reloads retain browser cache after one uncounted warmup. CPU 4×; explicit DevTools Fast 4G parameters are in raw.json. DOM-ready is separate from paint and is not INP.","", "The Next baseline is this image's production Next compatibility artifact, including the enabled migration ingress boolean. It is not an earlier pre-port release. Host execution makes no global CPU/RAM/container-budget claim.","", "| Regime | Backend | n | useful DOM median / p95 ms | controls median / p95 ms | FCP median ms | LCP median ms | CLS median | transfer median bytes |", "|---|---|---:|---:|---:|---:|---:|---:|---:|"];
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
  fixture=start(process.execPath,["--experimental-strip-types","--experimental-sqlite",options.fixtureScript]);
  const ready=await until(()=>{if(fixture.child.exitCode!==null)throw new Error(`Fixture exited: ${fixture.text()}`);return fixture.text().split("\n").flatMap(line=>{try{return[JSON.parse(line)];}catch{return[];}}).find(value=>value.event===options.fixtureEvent);},120000,"production fixture readiness");
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
    for(const backend of ["next","rust"])await options.functional(tabs[backend],backend,{results,until,delay,output,browser:instance,page,fixture:ready});
  } finally {await instance.close();}
  assert.equal(results.samples.length,(conditions.coldPairs+conditions.warmPairs)*2);
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
console.log(JSON.stringify({event:options.completionEvent,output,samples:results.samples.length,failure:results.failure}));

}
