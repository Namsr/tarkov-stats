// Seasonal functional acceptance runs only after all paired timing observations.
// The browser talks to the actual image frontends; no API or DOM is stubbed.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export function assertSeasonalRequests(requests, cycle, backend) {
  const main = requests.filter(r => { const u = new URL(r.url); return u.pathname === "/api/seasonal/average" && u.searchParams.get("cycle") === cycle && u.searchParams.get("period") === "90d"; });
  assert.ok(main.some(r => r.status === 200), `${backend}: real Seasonal 90d average request`);
  const overlays = requests.filter(r => { const u = new URL(r.url); return u.pathname === "/api/average/metrics" && u.searchParams.get("mode") === "seasonal"; });
  assert.ok(overlays.some(r => { const u = new URL(r.url); return u.searchParams.get("cycle") === cycle && u.searchParams.get("period") === "all" && r.status === 200; }), `${backend}: Seasonal overlay must request all`);
  assert.ok(overlays.every(r => new URL(r.url).searchParams.get("cycle") === cycle && new URL(r.url).searchParams.get("period") === "all"), `${backend}: 90d or another cycle must not leak into Seasonal overlay`);
}

export async function checkSeasonalFunctional({ tab, backend, context, evidence, messages, visible, evaluate, wait, click, key, ready, navigate, radio, blockedImage }) {
  const { until, delay, output, results } = context;
  const page = "/population/pvp-season", cycle = "native-s1";
  await navigate(page);
  await click(radio("median")); await ready();
  await click(radio("90d"));
  await wait(`new URL(location.href).searchParams.get('period')==='90d'&&document.querySelector(${JSON.stringify(radio("90d"))})?.checked`, "Seasonal 90d selection");
  await ready();
  await until(() => {
    try { assertSeasonalRequests([...tab.state.requests.values()], cycle, backend); return true; } catch { return false; }
  }, 15000, `${backend}: Seasonal main 90d and overlay all requests`);
  assertSeasonalRequests([...tab.state.requests.values()], cycle, backend);
  const response = await evaluate(`Promise.all(${JSON.stringify([
    `/api/progression/average?mode=seasonal&cycle=${cycle}`,
    `/api/average/metrics?mode=seasonal&cycle=${cycle}&period=all&statistic=median`,
    `/api/average/achievements?mode=seasonal&cycle=${cycle}`,
  ])}.map(async url=>{const r=await fetch(url);return {status:r.status,body:await r.json()}}))`);
  assert.deepEqual(response.map(x => x.status), [200, 200, 200]);
  assert.equal(response[0].body.mode, "seasonal"); assert.equal(response[0].body.cycleId, cycle);
  assert.equal(response[1].body.mode, "seasonal"); assert.equal(response[1].body.cycleId, cycle); assert.equal(response[1].body.period, "all"); assert.equal(Object.keys(response[1].body.series).length, 6);
  assert.equal(response[2].body.total, 300); assert.equal(response[2].body.achievements[0].unlockHours, 0);
  assert.equal(response[2].body.achievements[0].nameRu, "Тестовое достижение 1");
  assert.equal(response[2].body.achievements[0].descriptionRu, "Русское тестовое описание 1");
  evidence.api = { progression: response[0].body.cycleId, overlayPeriod: response[1].body.period, achievementZero: response[2].body.achievements[0].unlockHours };
  await click(radio("pmc_raids")); await ready();
  await evaluate("document.querySelector('main select').focus()"); await key("Home"); await key("ArrowDown"); await key("Enter");
  await wait("document.querySelector('main select')?.value==='kd_ratio'", "Seasonal metric selection"); await ready();
  await click(radio("hours")); await ready();
  // The server-rendered native GET form has numeric inputs; the Next page
  // exposes the same selection through the slider and does not render them.
  if (backend === "rust") {
    await evaluate("(()=>{const e=document.querySelector('main input[name=min]');e.focus();e.select()})()");
    await tab.send("Input.insertText", { text: "900" }); await key("Enter");
    await wait("new URL(location.href).searchParams.get('min')==='900'", "Seasonal numeric range"); await ready();
  }
  await evaluate("document.querySelector('main input[type=range]').focus()");
  const before = await evaluate("Number(document.querySelector('main input[type=range]').getAttribute('aria-valuenow'))"); await key("ArrowRight");
  await wait(`(()=>{const e=document.querySelector('main input[type=range]');return document.activeElement===e&&Number(e.getAttribute('aria-valuenow'))>${before}})()`, "Seasonal keyboard range and focus");
  assert.equal(await evaluate("(()=>{const e=document.activeElement,s=getComputedStyle(e);return e.matches(':focus-visible')&&(s.boxShadow!=='none'||s.outlineStyle!=='none')})()"), true, "keyboard focus must be visible");
  evidence.checks.push("hydrated Seasonal statistic/90d/axis/metric/numeric and keyboard ranges; overlay all and cycle");

  const a = new URL(`${page}?cycle=${cycle}&statistic=median&period=90d&unknown=one&unknown=two#seasonal-a`, tab.url);
  const b = new URL(`${page}?cycle=${cycle}&statistic=trimmed_mean&period=all&unknown=one&unknown=two#seasonal-b`, tab.url);
  const push = url => evaluate(`history.pushState(history.state,'',${JSON.stringify(url.href)});dispatchEvent(new PopStateEvent('popstate',{state:history.state}))`);
  await push(a); await wait(`document.querySelector(${JSON.stringify(radio("90d"))})?.checked`, "Seasonal history A"); await ready();
  await push(b); await wait(`document.querySelector(${JSON.stringify(radio("all"))})?.checked`, "Seasonal history B"); await ready();
  await evaluate("history.back()"); await wait("location.hash==='#seasonal-a'", "Seasonal Back"); await ready();
  await evaluate("history.forward()"); await wait("location.hash==='#seasonal-b'", "Seasonal Forward"); await ready();
  assert.deepEqual(await evaluate("new URL(location.href).searchParams.getAll('unknown')"), ["one", "two"]);
  await click('main a[href^="/population/regular"]'); await wait("location.pathname==='/population/regular'", "Regular navigation"); await ready();
  await click('main a[href^="/population/pvp-season"]'); await wait("location.pathname==='/population/pvp-season'", "Seasonal navigation"); await ready();
  await click('main a[href^="/population/pve"]'); await wait("location.pathname==='/population/pve'", "PvE navigation"); await ready();
  await click('main a[href^="/population/arena"]'); await wait("location.pathname==='/population/arena'&&!!document.querySelector('main')", "Arena navigation");
  await navigate(page);
  evidence.checks.push("Seasonal Back/Forward and Regular/PvE/Arena/Seasonal navigation retain canonical routes");

  await click("header button", "en"); await wait(`document.querySelector('main h1')?.textContent===${JSON.stringify(messages.en["nav.population"])}&&document.querySelector('#ach-breakdown')?.textContent.includes('Synthetic achievement 1')`, "English achievement metadata");
  await click("header button", "ru"); await wait(`document.querySelector('main h1')?.textContent===${JSON.stringify(messages.ru["nav.population"])}&&document.querySelector('#ach-breakdown')?.textContent.includes('Тестовое достижение 1')`, "Russian achievement metadata");
  await tab.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  assert.equal(await evaluate("matchMedia('(prefers-reduced-motion: reduce)').matches"), true);
  await click("button.faq-trigger"); await wait(`[...document.querySelectorAll('[role=dialog]')].some(e=>e.getClientRects().length>0)`, "FAQ open");
  await key("Tab"); assert.equal(await evaluate("!!document.activeElement?.closest('[role=dialog]')"), true); await key("Escape");
  await wait(`![...document.querySelectorAll('[role=dialog]')].some(e=>e.getClientRects().length>0)`, "FAQ Escape");
  const metricChart = `.seasonal-chart[aria-label=${JSON.stringify(messages.ru["average.metricChart"])}]`;
  assert.equal(await evaluate(`document.querySelectorAll(${JSON.stringify(metricChart + " button")}).length`), 6);
  for (let i = 0; i < 6; i++) {
    const button = metricChart + ` button:nth-of-type(${i + 1})`;
    await click(button);
    const active = await evaluate(`[...document.querySelectorAll(${JSON.stringify(metricChart + " button")})].map(e=>e.getAttribute('aria-pressed'))`);
    assert.deepEqual(active, Array.from({ length: 6 }, (_, j) => i === j ? "false" : "true"));
    await click(button);
  }
  for (const width of [1280, 768, 360]) {
    await tab.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: width === 360 }); await delay(100);
    assert.equal(await evaluate("document.documentElement.scrollWidth<=innerWidth+1"), true, `${backend}/${width}: overflow`);
    await click("#ach-breakdown button.achievement-table__sort", messages.ru["achievement.col.name"]);
    const sorted = await evaluate(`(()=>{const show=${visible};const e=[...document.querySelectorAll('#ach-breakdown button.achievement-table__sort')].find(e=>show(e)&&e.textContent.replace(/[↑↓]/g,'').trim()===${JSON.stringify(messages.ru["achievement.col.name"])});return e?.getAttribute('aria-pressed')})()`);
    assert.equal(sorted, "true");
    assert.match(await evaluate("document.querySelector('#ach-breakdown tbody tr:first-child')?.textContent || ''"), /Тестовое достижение 8/);
    await evaluate("[...document.querySelectorAll('main .seasonal-chart__hit')].at(-1).focus()"); await key("Enter");
    await wait("(()=>{const e=document.querySelector('main .seasonal-chart__hit')?.ownerSVGElement?.querySelector('.chart-crosshair');return !!e&&getComputedStyle(e).opacity!=='0'})()", "XP tooltip");
    await key("Escape");
    const shot = await tab.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    const filename = `${backend}-seasonal-${width}.png`; await writeFile(join(output, filename), Buffer.from(shot.data, "base64")); evidence.screenshots.push(filename);
    await navigate(page);
  }
  evidence.checks.push("EN/RU, responsive layouts, achievement sort, XP tooltip, keyboard focus and reduced motion");
  await tab.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  for (const query of ["?cycle=wrong", `?cycle=${cycle}&cycle=${cycle}`, `?cycle=%20${cycle}%20`]) {
    await tab.send("Page.navigate", { url: new URL(page + query, tab.url).href });
    await wait(`document.querySelector('main')?.textContent.includes(${JSON.stringify(messages.ru["seasonal.unavailable"])})`, "invalid cycle unavailable");
    assert.equal(await evaluate("document.querySelectorAll('main input[type=range]').length"), 0);
  }
  await navigate(page);
  if (backend === "rust") {
    const nojs = await context.page(context.browser, new URL(`${page}?unknown=first&unknown=second`, tab.url).href);
    try {
      await nojs.send("Emulation.setScriptExecutionDisabled", { value: true });
      await nojs.send("Page.navigate", { url: nojs.url });
      await until(() => nojs.evaluate("document.querySelectorAll('main input[type=number]').length===2&&document.querySelector('.average-sampleline')?.textContent.includes('300')"), 30000, "Seasonal native SSR without WASM");
      for (const [name, value] of [["min", "900"], ["max", "1500"]]) {
        await nojs.evaluate(`(()=>{const e=document.querySelector('main input[name=${name}]');e.focus();e.select()})()`);
        await nojs.send("Input.insertText", { text: value });
      }
      const point = await nojs.evaluate("(()=>{const e=document.querySelector('main button[type=submit]');e.scrollIntoView({block:'center',behavior:'instant'});const b=e.getBoundingClientRect(),x=b.left+b.width/2,y=b.top+b.height/2,hit=document.elementFromPoint(x,y);if(!hit||!e.contains(hit))throw Error('Submit is not hittable');return{x,y}})()");
      await nojs.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
      await nojs.send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
      const applied = await until(() => nojs.evaluate(`(()=>{const p=new URL(location.href).searchParams;const n=Number(document.querySelector('.average-sampleline')?.textContent.replace(/\\D/g,''));return p.get('cycle')===${JSON.stringify(cycle)}&&p.get('min')==='900'&&p.get('max')==='1500'&&n>0&&n<300?{n,unknown:p.getAll('unknown')}:false})()`), 30000, "Seasonal native GET filters without WASM");
      assert.deepEqual(applied.unknown, ["first", "second"]); evidence.noWasmNativeGet = { ...applied, scriptExecutionDisabled: true, requests: [...nojs.state.requests.values()] };
    } finally { await nojs.close(); }
  }
  const peer = results.functional.find(value => value.backend !== backend && value.seasonalValues);
  evidence.seasonalValues = await evaluate("[...document.querySelectorAll('.arena-combat-ring__value strong,.detail-grid--compact .metric-card__value')].map(e=>e.textContent.trim())");
  if (peer) assert.deepEqual(evidence.seasonalValues, peer.seasonalValues, "Seasonal hydrated DOM data parity");
  await until(() => Date.now() - tab.state.lastNetwork > 500 && [...tab.state.requests.values()].every(r => r.finished), 15000, "Seasonal functional network completion");
  assert.deepEqual(tab.state.exceptions, [], `${backend}: functional exceptions`); assert.deepEqual(tab.state.console, [], `${backend}: console errors`);
  for (const request of tab.state.requests.values()) {
    assert.ok(!(request.status >= 400), `${backend}: HTTP ${request.status} ${request.url}`);
    assert.ok(!request.error || request.canceled || request.url === blockedImage, `${backend}: resource ${request.url}: ${request.error}`);
  }
  evidence.checks.push("invalid/duplicate/raw-whitespace cycle renders unavailable; real network status");
}
