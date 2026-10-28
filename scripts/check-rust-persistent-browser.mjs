// Actual-image Linux CI only: paired PvE browser observations, then full mode correctness.
import assert from "node:assert/strict";
import {readFile,writeFile} from "node:fs/promises";
import {join} from "node:path";
import {runRustUiBrowser} from "./lib/benchmark-rust-ui-browser.mjs";
import {checkSeasonalFunctional} from "./lib/check-rust-seasonal-functional.mjs";
const seasonal = process.env.RUST_SEASONAL_BROWSER === "true";
const messages=JSON.parse(await readFile(new URL("../lib/i18n/messages.json",import.meta.url),"utf8"));
const conditions = {
  viewport: { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, locale: "ru-RU", cookie: "lang=ru", cpuSlowdown: 4,
  network: { name: "DevTools Fast 4G", offline: false, latency: 60 * 2.75,
    downloadThroughput: 9 * 1000 * 1000 / 8 * 0.9, uploadThroughput: 1.5 * 1000 * 1000 / 8 * 0.9, connectionType: "cellular4g" },
  warmPairs: 6, coldPairs: 4, backendCache: "warm selected + unfiltered context, independent production caches",
  coldMeaning: "fresh Chrome process/profile and empty browser HTTP cache; OS and all compilation caches are not guaranteed reset",
  warmMeaning: "retained Chrome process/profile, enabled HTTP cache, normal reload; one uncounted warmup per frontend",
  observation: "useful DOM is 300 sampled profiles +3gauges +10detailcards; controls require two enabled ranges; DOM time is not paint or INP",
  settling: "at least 1s after controls, loaded document and 500ms network quiet; fail if unfinished after 10s more",
  serverExecution: "actual image artifacts on the Linux host through two production Caddy fronts; no CPU/RAM-wide or container-budget claim",
  baseline: "current production Next artifact with the migration ingress boolean enabled; not a historical pre-port release",
  ancillary: "All PvE/Regular/Arena population prefetch has real synthetic data. One synthetic official-host achievement image is deliberately browser-blocked to verify onerror hiding without outbound access; its failedrequest remains in raw totals. Repeated timingseries is PvE only; Regular receives correctness/navigation checks.",
};
if (seasonal) {
  conditions.observation = "Seasonal useful DOM: 300 live-profile hours with latest snapshots, 3 gauges and 10 detail cards; controls require two enabled ranges; DOM time is not paint or INP";
  conditions.ancillary = "Seasonal-only native selector; cohort and other mode routes remain on Next. Both implementations share synthetic progression, fresh bilingual reference cache and separate durable caches. Paired timings cover Seasonal only; functional checks follow timing. A synthetic image is blocked, not a cold HTTPS test.";
}
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
    const count=document.querySelector('.average-sampleline')?.textContent.replace(/\D/g,'');
    const metrics=[...document.querySelectorAll('.arena-combat-ring__value strong,.detail-grid--compact .metric-card__value')].map(el=>el.textContent.trim());
    const sample=count;
    const useful=count==='300' && sample==='300' && metrics.length===13 && metrics.every(v=>/\d/.test(v)&&!/[—…]/.test(v));
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
  window.__rustArenaBenchmark={snapshot(){for(const{observer,callback}of observers)callback(observer.takeRecords());const dom=inspect();const html=document.documentElement?.outerHTML || '';const n=performance.getEntriesByType('navigation')[0];return{...state,dom,timeOrigin:performance.timeOrigin,now:performance.now(),navigation:n?{ttfbMs:n.responseStart-n.startTime,loadMs:n.loadEventEnd-n.startTime,responseStatus:n.responseStatus,type:n.type}:null,marker:html.includes('/_rust/persistent/')?'rust':html.includes('/_next/')?'next':'missing'};}};
  inspect();
})();`;

const blockedImage = "https://assets.tarkov.dev/fixture-missing.webp";
function pendingFilteredRequest(requests,before) {
  return [...requests.values()].find(request=>{
    const url=new URL(request.url);
    return !before.has(request.id)&&!request.finished&&!request.canceled&&url.pathname==="/api/average"&&url.searchParams.get("mode")==="pve"&&Number(url.searchParams.get("min"))>0;
  });
}

async function validate({ snapshot, requests, tab, backend }) {
  assert.equal(snapshot.dom.lang, "ru"); assert.equal(snapshot.dom.visibility, "visible");
  assert.equal(snapshot.dom.sample, "300"); assert.equal(snapshot.dom.metrics.length, 13);
  assert.equal(snapshot.dom.ranges.length, 2); assert.ok(snapshot.dom.ranges.every(value => !value.disabled));
  assert.deepEqual(tab.state.exceptions, [], `${backend}: uncaught exceptions`);
  assert.deepEqual(tab.state.console, [], `${backend}: console errors`); assert.deepEqual(snapshot.errors, []);
  const main = requests.filter(request => {
    const url = new URL(request.url); return seasonal ? url.pathname === "/api/seasonal/average" : url.pathname === "/api/average" && ["pve", "regular"].includes(url.searchParams.get("mode"));
  });
  for (const request of main) {
    assert.equal(request.status, 200, `${backend}:${request.url}`);
    const response = await tab.send("Network.getResponseBody", { requestId: request.id });
    const body = JSON.parse(response.base64Encoded ? Buffer.from(response.body, "base64").toString("utf8") : response.body);
    const query = new URL(request.url).searchParams;
    assert.equal(body.mode, seasonal ? "seasonal" : query.get("mode")); assert.equal(body.cycleId, seasonal ? "native-s1" : "persistent");
    if (seasonal) assert.equal(query.get("cycle"), "native-s1");
    assert.equal(body.statistic, query.get("statistic")); assert.equal(body.period, query.get("period"));
    assert.equal(body.averages.n, 300);
    request.validation = { mode: body.mode, cycleId: body.cycleId, statistic: body.statistic, period: body.period, sampleN: body.averages.n };
  }
  for (const request of requests) {
    assert.ok(!(request.status >= 400), `${backend}: unexpected HTTP failure ${request.status} ${request.url}`);
    assert.ok(!request.error || request.canceled || request.url === blockedImage, `${backend}: failed resource ${request.url}: ${request.error}`);
  }
  if (backend === "rust") assert.ok(!requests.some(request => new URL(request.url).pathname.startsWith("/_next/")), "native documents must not load Next application bundles");
  return requests.filter(request => request.url === blockedImage).map(({ url, error, bytes }) => ({ url, error, bytes }));
}
async function functional(tab, backend, context) {
  const { until, delay, output, fixture, results } = context;
  await tab.send("Page.bringToFront");
  await tab.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  await tab.send("Network.emulateNetworkConditionsByRule", { offline: false, matchedNetworkConditions: [] });
  await tab.send("Network.overrideNetworkState", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1, connectionType: "ethernet" });
  tab.state.requests.clear(); tab.state.exceptions = []; tab.state.console = [];
  const evidence = { backend, scope: "functional only; CPU1/no network throttling after all timing samples", checks: [], screenshots: [] };
  results.functional.push(evidence);
  try {
  const evaluate = expression => tab.evaluate(expression);
  const visible = String.raw`e=>!!(e&&e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden'&&getComputedStyle(e).display!=='none')`;
  async function wait(expression, description, limit = 30000) { return until(() => evaluate(expression), limit, `${backend}:${description}`); }
  async function point(selector, text) {
    return evaluate(`(()=>{const show=${visible};const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>show(e)&&(${text === undefined ? "true" : `e.textContent.replace(/[↑↓]/g,'').trim().toLowerCase()===${JSON.stringify(text.toLowerCase())}`}));if(!e)throw Error('Missing visible control '+${JSON.stringify(selector)});const target=e.matches('input[type=radio]')?e.closest('label'):e;target.scrollIntoView({block:'center'});const b=target.getBoundingClientRect();return{x:b.left+b.width/2,y:b.top+b.height/2};})()`);
  }
  async function click(selector, text) {
    const p = await point(selector, text);
    await tab.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...p });
    await tab.send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...p });
  }
  async function key(name) {
    const codes={Enter:["Enter",13],Escape:["Escape",27],Home:["Home",36],ArrowDown:["ArrowDown",40],ArrowRight:["ArrowRight",39],Tab:["Tab",9]," ":["Space",32]};
    const [code,windowsVirtualKeyCode]=codes[name]||[name,0];
    await tab.send("Input.dispatchKeyEvent", { type: "keyDown", key: name,code,windowsVirtualKeyCode });
    await tab.send("Input.dispatchKeyEvent", { type: "keyUp", key: name,code,windowsVirtualKeyCode });
  }
  async function ready() {
    return wait(String.raw`(()=>{const s=document.querySelector('.average-sampleline')?.textContent;const ranges=[...document.querySelectorAll('main input[type=range]')];return /\d/.test(s||'')&&ranges.length===2&&ranges.every(e=>!e.disabled)&&document.querySelectorAll('#ach-breakdown tbody tr').length===8&&document.querySelectorAll('main .seasonal-chart__hit').length===8;})()`, "all real panels and ranges");
  }
  async function navigate(path) {
    await tab.send("Page.navigate", { url: new URL(path, tab.url).href }); await ready();
  }
  const radio = value => `main input[type=radio][value=${value}]`;
  if (seasonal) {
    await checkSeasonalFunctional({ tab, backend, context, evidence, messages, visible, evaluate, wait, click, key, ready, navigate, radio, blockedImage });
    return;
  }
  await ready();
  await click(radio("median"));
  await wait(`document.querySelector(${JSON.stringify(radio("median"))})?.checked&&new URL(location.href).searchParams.get('statistic')==='median'`, "statistic URL"); await ready();
  await click(radio("90d"));
  await wait(`document.querySelector(${JSON.stringify(radio("90d"))})?.checked&&new URL(location.href).searchParams.get('period')==='90d'`, "period URL"); await ready();
  await click(radio("pmc_raids")); await ready();
  await evaluate("document.querySelector('main select').focus()"); await key("Home"); await key("ArrowDown"); await key("Enter");
  await wait("document.querySelector('main select')?.value==='kd_ratio'", "metric selection"); await ready();
  evidence.checks.push("statistic/period/axis/metric controls");

  // Genuine browser Back/Forward follows separately pushed same-document states.
  const a = new URL("/population/pve?statistic=median&period=90d&unknown=one&unknown=two#fixture-history", tab.url);
  const b = new URL("/population/pve?statistic=trimmed_mean&period=all&unknown=one&unknown=two#fixture-forward", tab.url);
  const push = url => evaluate(`history.pushState(history.state,'',${JSON.stringify(url.href)});dispatchEvent(new PopStateEvent('popstate',{state:history.state}));`);
  await push(a); await wait(`document.querySelector(${JSON.stringify(radio("median"))})?.checked&&document.querySelector(${JSON.stringify(radio("90d"))})?.checked`, "history state A"); await ready();
  await push(b); await wait(`document.querySelector(${JSON.stringify(radio("trimmed_mean"))})?.checked&&document.querySelector(${JSON.stringify(radio("all"))})?.checked`, "history state B"); await ready();
  await evaluate("history.back()"); await wait(`location.hash==='#fixture-history'&&document.querySelector(${JSON.stringify(radio("median"))})?.checked`, "Back first-key statistic"); await ready();
  await evaluate("history.forward()"); await wait(`location.hash==='#fixture-forward'&&document.querySelector(${JSON.stringify(radio("trimmed_mean"))})?.checked`, "Forward first-key statistic"); await ready();
  assert.deepEqual(await evaluate("new URL(location.href).searchParams.getAll('unknown')"), ["one", "two"]);
  evidence.checks.push("Back/Forward/raw first query key/unknown duplicates/hash");

  await click('main a[href^="/population/regular"]');
  await wait("location.pathname==='/population/regular'", "Regular document navigation"); await ready();
  evidence.regularMetrics = await evaluate("[...document.querySelectorAll('.arena-combat-ring__value strong,.detail-grid--compact .metric-card__value')].map(e=>e.textContent.trim())");
  const other = results.functional.find(value => value.backend !== backend && value.regularMetrics);
  if (other) assert.deepEqual(evidence.regularMetrics, other.regularMetrics, "real Regular DOM parity");
  evidence.checks.push("Regular full document/navigation/data parity");

  await click("header button", "en"); await wait(`document.querySelector('main h1')?.textContent===${JSON.stringify(messages.en["nav.population"])}`, "English switch");
  await click("header button", "ru"); await wait(`document.querySelector('main h1')?.textContent===${JSON.stringify(messages.ru["nav.population"])}`, "Russian switch");
  await click("button.theme-toggle"); await wait("document.documentElement.dataset.theme==='light'", "light theme");
  await click("button.theme-toggle"); await wait("document.documentElement.dataset.theme==='dark'", "dark theme");
  evidence.checks.push("EN/RU labels and persisted theme");
  const metrics = `.seasonal-chart[aria-label=${JSON.stringify(messages.ru["average.metricChart"])}]`;
  assert.equal(await evaluate(`document.querySelectorAll(${JSON.stringify(metrics + " button")}).length`), 6);
  for(let i=0;i<6;i++) {
    const button=metrics+" button:nth-of-type("+(i+1)+")";
    await click(button);
    const values=await evaluate(`[...document.querySelectorAll(${JSON.stringify(metrics+" button")})].map(e=>e.getAttribute('aria-pressed'))`);
    assert.deepEqual(values,Array.from({length:6},(_,j)=>i===j?"false":"true"));await click(button);
  }
  evidence.checks.push("all six metric toggles independently preserve others");
  const overall='main .seasonal-chart:not([aria-label]) .seasonal-chart__toggles button';
  await click(overall);assert.equal(await evaluate(`document.querySelector(${JSON.stringify(overall)}).getAttribute('aria-pressed')`),"false");
  await click(overall);await ready();evidence.checks.push("overall XP toggle");
  await evaluate(`[...document.querySelectorAll('#ach-breakdown img')].find(e=>e.getBoundingClientRect().width>0)?.scrollIntoView({block:'center'})`);
  await wait(`[...document.querySelectorAll('#ach-breakdown img')].some(e=>e.getBoundingClientRect().width>0&&e.style.visibility==='hidden')`,"official image failure hides icon without outbound access");
  evidence.checks.push("image onerror/missing icon handling");


  await tab.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await click('button.faq-trigger');await wait(`[...document.querySelectorAll('[role=dialog]')].some(e=>e.getClientRects().length>0)`,"FAQ open");
  await key("Tab");assert.equal(await evaluate("!!document.activeElement?.closest('[role=dialog]')"),true);
  await key("Escape");await wait(`![...document.querySelectorAll('[role=dialog]')].some(e=>e.getClientRects().length>0)`,"FAQ Escape close");
  evidence.checks.push("FAQ keyboard dialog/focus/Escape with reduced motion");

  for (const width of [1280, 768, 360]) {
    await tab.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: width === 360 });
    await delay(100);
    assert.equal(await evaluate("document.documentElement.scrollWidth<=innerWidth+1"), true, `${backend}/${width}: no page overflow`);
    const name = messages.ru["achievement.col.name"];
    await click("#ach-breakdown button.achievement-table__sort", name);
    const sorted = await evaluate(`(()=>{const visible=${visible};const e=[...document.querySelectorAll('#ach-breakdown button.achievement-table__sort')].find(e=>visible(e)&&e.textContent.replace(/[↑↓]/g,'').trim()===${JSON.stringify(name)});return{pressed:e.getAttribute('aria-pressed'),label:e.getAttribute('aria-label')};})()`);
    assert.equal(sorted.pressed, "true"); assert.ok(sorted.label.includes(messages.ru["achievement.sort.directionDesc"]));
    const expand = "#ach-breakdown .profile-collapsible__toggle";
    await click(expand); await wait(`document.querySelector(${JSON.stringify(expand)}).getAttribute('aria-expanded')==='true'`, "expand achievements");
    await click(expand); await wait(`document.querySelector(${JSON.stringify(expand)}).getAttribute('aria-expanded')==='false'`, "collapse achievements");
    await wait("document.querySelectorAll('#ach-breakdown [inert]').length>0", "collapsed rows leave keyboard tree");
    await evaluate("[...document.querySelectorAll('main .seasonal-chart__hit')].at(-1).focus()"); await key("Enter");
    const corrected = await wait(String.raw`(()=>{const svg=document.querySelector('main .seasonal-chart__hit')?.ownerSVGElement;const group=svg?.querySelector('.chart-crosshair');if(!group||getComputedStyle(group).opacity==='0')return false;const b=svg.getBoundingClientRect();const labels=[...group.querySelectorAll('text')].map(e=>{const r=e.getBoundingClientRect();return{text:e.textContent,left:r.left,right:r.right}});return labels.length===2&&labels.every(r=>r.left>=b.left-1&&r.right<=b.right+1)?{labels,hiddenTicks:[...svg.querySelectorAll('[data-chart-tick]')].filter(e=>getComputedStyle(e).opacity==='0').length}:false;})()`, "large XP/raid crosshair labels fit SVG");
    assert.ok(corrected.hiddenTicks > 0, "overlapping axis ticks must hide");
    await key("Escape"); await wait("[...document.querySelectorAll('main [data-chart-tick]')].every(e=>getComputedStyle(e).opacity!=='0')", "crosshair restores ticks");
    const filename = `${backend}-${width}.png`; const shot = await tab.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    await writeFile(join(output, filename), Buffer.from(shot.data, "base64")); evidence.screenshots.push(filename);
    evidence.checks.push(`viewport${width}/sort a11y/collapse/reduced motion/large crosshair`);
    // Restore the initial sort before checking the same first action at another width.
    await navigate("/population/regular");
  }

  await tab.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await navigate("/population/pve");
  await tab.send("Network.emulateNetworkConditionsByRule", { offline: false, matchedNetworkConditions: [{ urlPattern: "*/api/average*", latency: 1200, downloadThroughput: -1, uploadThroughput: -1 }] });
  const lowSelector = 'main input[type=range]';
  const remote = await tab.send("Runtime.evaluate", { expression: "document.querySelector('main input[type=range]')", objectGroup: "persistent-focus" });
  const objectId = remote.result.objectId; assert.ok(objectId);
  const slider = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(lowSelector)});e.scrollIntoView({block:'center'});e.focus();const b=e.getBoundingClientRect();return{x:b.left+8+(b.width-16)*Number(e.value)/10000,y:b.top+b.height/2,width:b.width};})()`);
  const beforeDrag=new Set(tab.state.requests.keys());
  await tab.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, x: slider.x, y: slider.y });
  await tab.send("Input.dispatchMouseEvent", { type: "mouseMoved", button: "left", buttons: 1, x: slider.x + slider.width / 8, y: slider.y });
  await delay(700);
  const held = await tab.send("Runtime.callFunctionOn", { objectId, functionDeclaration: "function(){return{connected:this.isConnected,disabled:this.disabled,focused:document.activeElement===this}}", returnByValue: true });
  assert.deepEqual(held.result.value, { connected: true, disabled: false, focused: true });
  const dragPending=pendingFilteredRequest(tab.state.requests,beforeDrag);
  assert.ok(dragPending,"real fresh filtered average request must still be pending during held drag");
  evidence.dragPending={...dragPending,interactionDelayMs:700};

  await tab.send("Input.dispatchMouseEvent", { type: "mouseMoved", button: "left", buttons: 1, x: slider.x + slider.width / 7, y: slider.y });
  await tab.send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, x: slider.x + slider.width / 7, y: slider.y });
  await ready();
  await tab.send("Network.emulateNetworkConditionsByRule", { offline: false, matchedNetworkConditions: [] });
  await tab.send("Runtime.releaseObjectGroup", { objectGroup: "persistent-focus" });
  evidence.checks.push("pointer held700ms across250ms debounce and delayed realAPI keeps same focused enabled slider");
  await until(()=>Date.now()-tab.state.lastNetwork>500&&[...tab.state.requests.values()].every(r=>r.finished),15000,"delayed slider API completes");
  // A bucket activation must retain the same focused DOM node across the debounce.
  await tab.send("Network.emulateNetworkConditionsByRule",{offline:false,matchedNetworkConditions:[{urlPattern:"*/api/average*",latency:1200,downloadThroughput:-1,uploadThroughput:-1}]});
  const bucketSelector='.chart-panel a[role=button][title],.chart-panel button[type=button][title]';
  const bucket=await tab.send("Runtime.evaluate",{expression:`document.querySelector(${JSON.stringify(bucketSelector)})`,objectGroup:"persistent-bucket"});assert.ok(bucket.result.objectId);
  const beforeBucket=new Set(tab.state.requests.keys());
  await evaluate(`document.querySelector(${JSON.stringify(bucketSelector)}).focus()`);await key(" ");await delay(700);
  const focusedBucket=await tab.send("Runtime.callFunctionOn",{objectId:bucket.result.objectId,functionDeclaration:"function(){return{connected:this.isConnected,focused:document.activeElement===this}}",returnByValue:true});
  assert.deepEqual(focusedBucket.result.value,{connected:true,focused:true});
  const bucketPending=pendingFilteredRequest(tab.state.requests,beforeBucket);
  assert.ok(bucketPending,"real fresh filtered average request must still be pending during bucket focus check");
  evidence.bucketPending={...bucketPending,interactionDelayMs:700};

  await tab.send("Network.emulateNetworkConditionsByRule",{offline:false,matchedNetworkConditions:[]});
  await until(()=>Date.now()-tab.state.lastNetwork>500&&[...tab.state.requests.values()].every(r=>r.finished),15000,"bucket API completes");
  await tab.send("Runtime.releaseObjectGroup",{objectGroup:"persistent-bucket"});
  await evaluate("document.querySelector('main input[type=range]').focus()");
  const before=await evaluate("Number(document.querySelector('main input[type=range]').getAttribute('aria-valuenow'))");await key("ArrowRight");
  const after=await wait(`(()=>{const e=document.querySelector('main input[type=range]');const value=Number(e.getAttribute('aria-valuenow'));return value>${before}&&document.activeElement===e?value:false})()`,"keyboard range update");
  evidence.rangeKeyboard={before,after};evidence.checks.push("focused bucket survives700ms/debounce/delayedAPI; keyboard range remains usable");
  await until(()=>Date.now()-tab.state.lastNetwork>500&&[...tab.state.requests.values()].every(r=>r.finished),15000,"keyboard API completes");

  // Real SQLite query failure, not a response override. Clear the range by switching period.
  const control=async(action)=>{const response=await fetch(fixture.control,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action}),signal:AbortSignal.timeout(10000)});assert.equal(response.status,200);await response.body?.cancel();};
  await control("break-primary");
  try {
    await click(radio("90d"));
    await wait(`(()=>{const show=${visible};return [...document.querySelectorAll('main p')].some(e=>show(e)&&e.textContent.trim()===${JSON.stringify(messages.ru["common.loadFailed"])});})()`,"actual database error is visible");
  } finally {await control("repair-primary");}
  await click(radio("all"));await ready();evidence.checks.push("real storage error and user-controlled recovery");
  await until(()=>Date.now()-tab.state.lastNetwork>500&&[...tab.state.requests.values()].every(r=>r.finished),15000,"functional network completion");
  if(backend==="rust") {
    const url=new URL("/population/pve?unknown=first&unknown=second",tab.url);
    const nojs=await context.page(context.browser,url.href);
    try {
      await nojs.send("Emulation.setScriptExecutionDisabled",{value:true});
      await nojs.send("Page.navigate",{url:url.href});
      await until(()=>nojs.evaluate("document.querySelectorAll('main input[type=number]').length===2&&document.querySelector('.average-sampleline')?.textContent.includes('300')"),30000,"native useful SSR without JS");
      for(const [name,value]of[["min","100"],["max","2000"]]){
        await nojs.evaluate(`(()=>{const e=document.querySelector('main input[name=${name}]');e.focus();e.select()})()`);
        await nojs.send("Input.insertText",{text:value});
      }
      const p=await nojs.evaluate("(()=>{const e=document.querySelector('main button[type=submit]');e.scrollIntoView({block:'center'});const b=e.getBoundingClientRect();return{x:b.left+b.width/2,y:b.top+b.height/2}})()");
      await nojs.send("Input.dispatchMouseEvent",{type:"mousePressed",button:"left",clickCount:1,...p});await nojs.send("Input.dispatchMouseEvent",{type:"mouseReleased",button:"left",clickCount:1,...p});
      const applied=await until(()=>nojs.evaluate("(()=>{const p=new URL(location.href).searchParams;const n=Number(document.querySelector('.average-sampleline')?.textContent.replace(/\\D/g,''));return p.get('min')==='100'&&p.get('max')==='2000'&&n>0&&n<300?{n,unknown:p.getAll('unknown')}:false})()"),30000,"native GET applies real filters without WASM");
      assert.deepEqual(applied.unknown,["first","second"]);evidence.noWasmNativeGet={...applied,scriptExecutionDisabled:true,requests:[...nojs.state.requests.values()]};
      const shot=await nojs.send("Page.captureScreenshot",{format:"png",captureBeyondViewport:false});await writeFile(join(output,"rust-no-wasm-native-get.png"),Buffer.from(shot.data,"base64"));evidence.screenshots.push("rust-no-wasm-native-get.png");
    }finally{await nojs.close();}
  }
  assert.deepEqual(tab.state.exceptions, [], `${backend}: functional uncaught exceptions`);
  assert.deepEqual(tab.state.console, [], `${backend}: functional console errors`);
  evidence.requests = [...tab.state.requests.values()];
  for (const request of evidence.requests) {
    const url=new URL(request.url);const expectedSqlFailure=request.status===500&&["/api/average","/api/average/metrics"].includes(url.pathname)&&url.searchParams.get("mode")==="pve"&&url.searchParams.get("period")==="90d"&&url.searchParams.get("statistic")==="trimmed_mean";
    if(expectedSqlFailure)request.expectedFailure="private database schema failure/repaired";
    assert.ok(!(request.status >= 400)||expectedSqlFailure, `${backend}: functional HTTP ${request.status} ${request.url}`);
    assert.ok(!request.error || request.canceled || request.url === blockedImage, `${backend}: functional resource ${request.url}: ${request.error}`);
  }
  } finally {
    evidence.requests=[...tab.state.requests.values()];evidence.exceptions=[...tab.state.exceptions];evidence.consoleErrors=[...tab.state.console];
    evidence.lastSnapshot=await tab.evaluate("window.__rustArenaBenchmark?.snapshot()").catch(()=>null);
  }

}
await runRustUiBrowser({ conditions, references, instrumentation, validate, functional, requireSharedProgression: seasonal,
  outputEnvironment: "PERSISTENT_BROWSER_OUTPUT", defaultOutput: seasonal ? "seasonal-browser-evidence" : "persistent-browser-evidence", profilePrefix: seasonal ? "tarkov-seasonal-cdp-" : "tarkov-persistent-cdp-",
  fixtureScript: "scripts/serve-rust-persistent-benchmark.mjs", fixtureEvent: seasonal ? "rust_seasonal_browser_ready" : "rust_persistent_browser_ready",
  blockedUrls: ["https://*"], title: seasonal ? "# Seasonal browser comparison and correctness" : "# PvE browser comparison +PvE/Regular correctness", completionEvent: seasonal ? "rust_seasonal_browser_complete" : "rust_persistent_browser_complete" });
