import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createPersistentUiFixture, persistentAssets, PERSISTENT_MODES } from "./fixtures/rust-persistent-ui.mjs";
import { assertPopulationParity } from "./fixtures/rust-population-data.mjs";
import { raw, startRejectedUi } from "./fixtures/rust-arena-ui.mjs";
const { computeAverage } = await import("../lib/average-compute.ts");
const messages = JSON.parse(readFileSync("lib/i18n/messages.json", "utf8"));
const decode = value => value.replace(/&quot;/g, '"').replace(/&#x27;|&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
function document(response, mode, language = "en") {
  assert.equal(response.status, 200);
  assert.equal(response.headers["content-type"], "text/html; charset=utf-8");
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers.vary, "Cookie, Accept-Language");
  assert.equal(response.headers["set-cookie"], undefined);
  assert.equal(response.headers["access-control-allow-origin"], undefined);
  assert.match(response.headers["server-timing"], /^population_data;dur=\d+\.\d{3}$/);
  const html = response.body.toString("utf8");
  assert.match(html, new RegExp(`<html[^>]*lang="${language}"`));
  assert.equal(html.includes("/_next/"), false);
  assert.equal(html.includes("self.__next_f"), false);
  const match = html.match(/<leptos-island\b[^>]*\bdata-props="([^"]*)"/);
  assert.ok(match, "real PersistentApp island props exist in SSR");
  const props = JSON.parse(decode(match[1]));
  assert.equal(props.lang, language);
  assert.equal(props.initial.state.mode, mode);
  for (const field of ["statistic", "period", "dimension", "metric", "min", "max"]) assert.ok(html.includes(`name="${field}"`), field);
  assert.match(html, /<form[^>]*method="get"/);
  for (const key of ["nav.population", "metric.kd_ratio", "progression.chart.xp", "average.metricChart", "profile.section.achievements", "arena.average.applyFilters"]) assert.ok(html.includes(messages[language][key]), `${language}:${key}`);
  return { html, initial: props.initial };
}
async function json(base, path) {
  const response = await raw(base, path);
  return { ...response, body: JSON.parse(response.body.toString("utf8")) };
}

test("real persistent Rust SSR keeps both mode contracts, full panels, initial data and immutable production assets", { timeout: 180000 }, async t => {
  const assets = persistentAssets();
  const fixture = await createPersistentUiFixture({ prefix: "rust-persistent-ui-http-" });
  t.after(() => fixture.closeAll());
  const server = await fixture.start();
  await t.test("useful real TS-computed numbers, published XP and complete controls are in both native documents", async () => {
    for (const mode of PERSISTENT_MODES) {
      const { initial, html } = document(await raw(server.base, `/population/${mode}`), mode);
      const expected = await computeAverage(mode, "hours", "players", 36, "trimmed_mean", "all", null, null, true);
      assertPopulationParity({ body: initial.selected.body }, { body: expected.body }, mode);
      assertPopulationParity({ body: initial.context.body }, { body: expected.body }, mode);
      assert.equal(initial.selected.status, 200); assert.equal(initial.selected.stale, false); assert.ok(initial.selected.generated_at > 0);
      assert.equal(initial.selected.body.averages.n, 300);
      assert.deepEqual(initial.progression.body, fixture.publishProgression(mode));
      assert.equal(initial.progression.status, 200); assert.equal(initial.progression.publication_stale, false);
      assert.equal(initial.level_bands.length, 79);
      assert.equal(initial.metrics.body, null); assert.equal(initial.metrics.status, 200);
      assert.equal(initial.achievements.body, null); assert.equal(initial.achievements.status, 200);
      for (const marker of ["arena-combat-ring", "seasonal-chart__hit", "achievement-table", "achievement-cards", "detail-grid--compact", "type=\"range\"", "type=\"number\""]) assert.ok(html.includes(marker), marker);
      for (const file of ["tarkov_ui.js", "tarkov_ui_bg.wasm", "tarkov_ui.css"]) assert.ok(html.includes(`/_rust/persistent/${assets.manifest.hash}/${file}`));
      assert.equal(html.includes("seasonal-chart__corridor"), false, "averageOnly must not add a new corridor");
    }
  });
  await t.test("statistic, period and axis deep links use actual TS math without crossing mode data", async () => {
    for (const mode of PERSISTENT_MODES) for (const statistic of ["median", "trimmed_mean"]) for (const period of ["all", "90d"]) for (const dimension of ["hours", "pmc_raids"]) {
      const q = new URLSearchParams({ statistic, period, dimension, metric: "kd_ratio" });
      const { initial } = document(await raw(server.base, `/population/${mode}?${q}`), mode);
      const expected = await computeAverage(mode, dimension, "kd_ratio", 36, statistic, period, null, null, true);
      assertPopulationParity({ body: initial.selected.body }, { body: expected.body }, `${mode}:${q}`);
    }
  });
  await t.test("native GET range, duplicate first keys, unknown fields and escaped values survive SSR", async () => {
    const attack = '</script><img id="fixture-xss" src=x onerror=alert(1)>';
    const q = new URLSearchParams({ statistic: "median", dimension: "hours", metric: "players", min: "0x10", max: "1000.5", unknown: attack });
    q.append("unknown", "second"); q.append("statistic", "wrong");
    const { initial, html } = document(await raw(server.base, `/population/pve?${q}`), "pve");
    assert.equal(initial.state.min, 16); assert.equal(initial.state.max, 1000.5); assert.equal(initial.state.statistic, "median");
    assert.deepEqual(initial.state.params.filter(([key]) => key === "unknown"), [["unknown", attack], ["unknown", "second"]]);
    const expected = await computeAverage("pve", "hours", "players", 36, "median", "all", 16, 1000.5, true);
    assertPopulationParity({ body: initial.selected.body }, { body: expected.body });
    assert.equal(initial.context.body.averages.n, 300);
    assert.equal(html.includes('<img id="fixture-xss"'), false); assert.ok(html.includes("&lt;/script&gt;"));
    for (const first of ["?statistic", "%3Fstatistic"]) {
      const { initial } = document(await raw(server.base, `/population/pve?${first}=median&period=90d`), "pve");
      assert.equal(initial.state.statistic, "trimmed_mean"); assert.equal(initial.state.period, "90d");
      assert.deepEqual(initial.state.params[0], ["?statistic", "median"]);
    }
  });
  await t.test("locale cookies and Accept-Language remain document metadata with no new cookie writes", async () => {
    for (const [headers, lang] of [[{ "accept-language": "ru-RU,en;q=0.9" }, "ru"], [{ cookie: "lang=en", "accept-language": "ru" }, "en"], [{ cookie: "lang=%72u", "accept-language": "en" }, "ru"]]) document(await raw(server.base, "/population/regular", { headers }), "regular", lang);
  });
  await t.test("initial scheduled-publication age does not become dynamic retry staleness", async () => {
    fixture.publishProgression("pve", Date.now() - 7 * 3600000, 2);
    const { initial } = document(await raw(server.base, "/population/pve"), "pve");
    assert.equal(initial.progression.status, 200); assert.equal(initial.progression.publication_stale, true);
    assert.equal(initial.progression.stale, false);
    const response = await json(server.base, "/api/progression/average?mode=pve");
    assert.equal(response.headers["x-average-stale"], "1"); assert.equal(response.headers["x-statistics-stale"], "0"); assert.equal(response.headers["retry-after"], undefined);
  });
  await t.test("hydration endpoints expose all six real series and deterministic bilingual achievements", async () => {
    for (const mode of PERSISTENT_MODES) {
      const metrics = await json(server.base, `/api/average/metrics?mode=${mode}&statistic=trimmed_mean&period=all`);
      assert.equal(metrics.status, 200);
      assert.deepEqual(Object.keys(metrics.body.series).sort(), ["kd_ratio", "survival_rate", "kills_per_raid", "total_kills", "deaths", "total_raids"].sort());
      assert.ok(Object.values(metrics.body.series).every(series => Array.isArray(series) && series.length));
      const achievements = await json(server.base, `/api/average/achievements?mode=${mode}`);
      assert.equal(achievements.status, 200); assert.equal(achievements.body.total, 300); assert.equal(achievements.body.achievements.length, 8);
      assert.equal(achievements.body.achievements[0].nameRu, "Тестовое достижение 1"); assert.equal(achievements.body.achievements[0].unlockHours, 0);
    }
  });
  await t.test("invalid range and unavailable primary preserve unavailable metadata rather than false zero counts", async () => {
    const invalid = document(await raw(server.base, "/population/pve?min=bad"), "pve");
    assert.equal(invalid.initial.state.invalid, true); assert.equal(invalid.initial.selected.status, 400);
    assert.equal(invalid.initial.selected.body, null); assert.equal(invalid.initial.context.body.averages.n, 300);
    const absent = await fixture.start({ SQLITE_PATH: fixture.directory });
    try {
      const { initial } = document(await raw(absent.base, "/population/pve"), "pve");
      assert.equal(initial.selected.status, 503); assert.equal(initial.context.status, 503);
      assert.equal(initial.selected.body, null); assert.equal(initial.context.body, null);
    } finally { await absent.stop(); }
  });
  await t.test("PvE and Regular selectors are independent, both-off needs no assets", async () => {
    for (const enabled of PERSISTENT_MODES) {
      const instance = await fixture.start({ PVE_UI_UPSTREAM: enabled === "pve" ? "web:3001" : "web:3000", REGULAR_UI_UPSTREAM: enabled === "regular" ? "web:3001" : "web:3000" });
      try { for (const mode of PERSISTENT_MODES) assert.equal((await raw(instance.base, `/population/${mode}`)).status, mode === enabled ? 200 : 404); }
      finally { await instance.stop(); }
    }
    const disabled = await fixture.start({ PVE_UI_UPSTREAM: "web:3000", REGULAR_UI_UPSTREAM: "web:3000", RUST_PERSISTENT_UI_ASSETS: join(fixture.directory, "missing-assets") });
    try { for (const path of ["/population/pve", "/population/regular", `/_rust/persistent/${assets.manifest.hash}/tarkov_ui.js`]) assert.equal((await raw(disabled.base, path)).status, 404); assert.equal((await json(disabled.base, "/api/average?mode=pve")).status, 200); }
    finally { await disabled.stop(); }
  });
  await t.test("HEAD, OPTIONS, aliases and trailing slash retain real server boundary behavior", async () => {
    for (const mode of PERSISTENT_MODES) {
      const head = await raw(server.base, `/population/${mode}`, { method: "HEAD" }); assert.equal(head.status, 200); assert.equal(head.body.length, 0);
      const options = await raw(server.base, `/population/${mode}`, { method: "OPTIONS" }); assert.equal(options.status, 204); assert.equal(options.headers.allow, "GET, HEAD, OPTIONS");
      const post = await raw(server.base, `/population/${mode}`, { method: "POST" }); assert.equal(post.status, 405); assert.equal(post.headers.allow, undefined);
      for (const path of [`/average/${mode}`, `/population/${mode}/`]) for (const method of ["GET","HEAD","POST","OPTIONS"]) {
        const location=`/population/${mode}?unknown=one&unknown=two`;
        const redirect=await raw(server.base,path+"?unknown=one&unknown=two",{method});
        assert.equal(redirect.status,308);assert.equal(redirect.headers.location,location);
        assert.equal(redirect.headers.refresh,"0;url="+location);
        assert.equal(redirect.body.toString(),method==="HEAD"?"":location);
      }
    }
  });
  await t.test("exact hashed production JS/WASM/CSS are immutable, support HEAD/ETag and refuse traversal", async () => {
    for (const [name, mime] of [["tarkov_ui.js", "text/javascript; charset=utf-8"], ["tarkov_ui_bg.wasm", "application/wasm"], ["tarkov_ui.css", "text/css; charset=utf-8"]]) {
      const path = `/_rust/persistent/${assets.manifest.hash}/${name}`;
      const response = await raw(server.base, path); assert.equal(response.status, 200); assert.equal(response.headers["content-type"], mime);
      assert.equal(response.headers["cache-control"], "public, max-age=31536000, immutable"); assert.deepEqual(response.body, assets.bodies.get(name));
      assert.equal(createHash("sha256").update(response.body).digest("hex"), assets.manifest.files[name].sha256);
      const head = await raw(server.base, path, { method: "HEAD" }); assert.equal(head.status, 200); assert.equal(head.body.length, 0);
      const cached = await raw(server.base, path, { headers: { "if-none-match": response.headers.etag } }); assert.equal(cached.status, 304); assert.equal(cached.body.length, 0);
    }
    for (const path of ["/_rust/persistent/manifest.json", `/_rust/persistent/${assets.manifest.hash}/..%2f..%2fCargo.toml`, `/_rust/persistent/${assets.manifest.hash}/tarkov_ui.js%00`]) assert.ok([400, 404].includes((await raw(server.base, path)).status));
  });
  await t.test("missing and corrupted asset manifests fail startup before readiness", async () => {
    assert.match(await startRejectedUi({ ...fixture.configured, RUST_PERSISTENT_UI_ASSETS: join(fixture.directory, "missing") }), /manifest unavailable/i);
    const root = fixture.cloneAssets(assets); const file = join(root, assets.manifest.hash, "tarkov_ui.js");
    const bytes = Buffer.from(assets.bodies.get("tarkov_ui.js")); bytes[0] ^= 1; writeFileSync(file, bytes);
    assert.match(await startRejectedUi({ ...fixture.configured, RUST_PERSISTENT_UI_ASSETS: root }), /Rust API failed/i);
  });
});
