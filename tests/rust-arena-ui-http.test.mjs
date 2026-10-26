import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createUiFixture, readBuiltAssets, raw, startRejectedUi } from "./fixtures/rust-arena-ui.mjs";
import { rustBackendBinary } from "./fixtures/rust-seasonal-http.mjs";
const messages = JSON.parse(readFileSync("lib/i18n/messages.json", "utf8"));
const htmlDecode = (value) => value.replace(/&quot;/g, '"').replace(/&#x27;|&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const text = (value) => htmlDecode(value.replace(/<[^>]*>/g, ""));
function initialProps(html) {
  const match = html.match(/<leptos-island\b[^>]*\bdata-props="([^"]*)"/);
  assert.ok(match, "actual Leptos island props must exist in the server document");
  const props = JSON.parse(htmlDecode(match[1]));
  assert.ok(props.initial && props.initial.state && props.initial.meta);
  return props;
}
function assertDocument(response, lang) {
  assert.equal(response.status, 200);
  assert.equal(response.headers["content-type"], "text/html; charset=utf-8");
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers.vary, "Cookie, Accept-Language");
  assert.equal(response.headers["set-cookie"], undefined);
  assert.equal(response.headers["access-control-allow-origin"], undefined);
  assert.match(response.headers["server-timing"], /^arena_data;dur=\d+\.\d{3}$/);
  const html = response.body.toString("utf8");
  assert.match(html, new RegExp(`<html[^>]*lang="${lang}"`));
  assert.equal(html.includes("/_next/"), false, "Next bundles must not serve the native Arena document");
  assert.equal(html.includes("self.__next_f"), false);
  assert.ok(html.includes(messages[lang]["nav.population"]));
  assert.ok(html.includes(messages[lang]["arena.average.applyFilters"]));
  const title = html.match(/<title>([\s\S]*?)<\/title>/); assert.ok(title);
  assert.equal(text(title[1]), messages[lang]["meta.title"]);
  for (const field of ["arenaStatistic", "_dimension", "_metric", "_minMatches", "_maxMatches"]) assert.ok(html.includes(field), field);
  assert.ok(html.includes('type="number"')); assert.ok(html.includes('type="range"')); assert.ok(html.includes('method="get"'));
  const props = initialProps(html); assert.equal(props.lang, lang);
  return { html, initial: props.initial };
}

test("real Rust Arena SSR and built assets preserve useful HTML, locale, queries and immutable bytes", { timeout: 120000 }, async (t) => {
  assert.ok(existsSync(rustBackendBinary()), "build the complete Rust backend before UI HTTP tests");
  const assets = readBuiltAssets();
  const fixture = await createUiFixture(); t.after(() => fixture.closeAll());
  const server = await fixture.start();
  await t.test("HEAD is lightweight and useful SSR stats exist before any client script", async () => {
    const head = await raw(server.base, "/population/arena", { method: "HEAD" });
    assert.equal(head.status, 200); assert.equal(head.body.length, 0); assert.equal(head.headers["cache-control"], "no-store");
    assert.equal(server.logs().includes('"kind":"arena_population"'), false, "HEAD must not start a SQLite compute job");
    const { html, initial } = assertDocument(await raw(server.base, "/population/arena", { headers: { "accept-language": "en" } }), "en");
    const count = html.match(/<div[^>]*summary-strip__number[^>]*>([\s\S]*?)<\/div>/); assert.ok(count);
    assert.equal(text(count[1]), "300");
    assert.equal(initial.selected.sampleN, 300); assert.equal(initial.context.sampleN, 300);
    assert.equal(initial.meta.selected_status, 200); assert.equal(initial.meta.context_status, 200);
    assert.equal(initial.meta.selected_stale, false); assert.equal(initial.meta.context_stale, false);
    assert.ok(initial.meta.selected_generated_at > 0); assert.ok(initial.meta.context_generated_at > 0);
    const values = [...html.matchAll(/<p[^>]*metric-card__value[^>]*>([\s\S]*?)<\/p>/g)].map((match) => text(match[1]));
    assert.equal(values.length, 5); assert.ok(values.every((value) => value && value !== messages.en["common.notAvailable"]));
    assert.ok(html.includes(`/_rust/arena/${assets.manifest.hash}/tarkov_ui.js`));
    assert.ok(html.includes(`/_rust/arena/${assets.manifest.hash}/tarkov_ui_bg.wasm`));
    assert.ok(html.includes(`/_rust/arena/${assets.manifest.hash}/tarkov_ui.css`));
  });
  await t.test("language cookie precedence and real Accept-Language behavior reach HTML and island props", async () => {
    for (const [headers, lang] of [[{ "accept-language": "ru-RU,en;q=0.9" }, "ru"], [{ cookie: "lang=en", "accept-language": "ru" }, "en"],
      [{ cookie: "lang=%72u", "accept-language": "en" }, "ru"], [{ cookie: "lang=en;lang=%invalid", "accept-language": "ru" }, "en"],
      [{ cookie: "lang=en;lang=bad", "accept-language": "en-US,ru;q=0" }, "ru"]]) {
      assertDocument(await raw(server.base, "/population/arena", { headers }), lang);
    }
  });
  await t.test("deep-link query and form state preserve per-mode ranges, unknown duplicates and safe escaping", async () => {
    const attack = '</script><img id="fixture-xss" src=x onerror=alert(1)>';
    const params = new URLSearchParams({ arenaMode: "lastHero", arenaStatistic: "median", arena_lastHero_dimension: "hours", arena_lastHero_metric: "win_rate",
      arena_lastHero_minHours: "90.5", arena_lastHero_maxHours: "100", arena_teamFight_minMatches: "25", unknown: attack });
    params.append("unknown", "second");
    const { html, initial } = assertDocument(await raw(server.base, `/population/arena?${params}`), "en");
    assert.equal(initial.state.selected, 1); assert.equal(initial.state.statistic, "median");
    assert.deepEqual(initial.state.filters[1].ranges, ["90.5", "100", "10", ""]);
    assert.equal(initial.state.filters[0].ranges[2], "25");
    assert.deepEqual(initial.state.params.filter(([key]) => key === "unknown"), [["unknown", attack], ["unknown", "second"]]);
    assert.equal(initial.selected.filterIdentity.mode, "lastHero"); assert.equal(initial.selected.filterIdentity.minHours, 90.5);
    assert.equal(initial.context.filterIdentity.minHours, null); assert.equal(initial.context.filterIdentity.maxHours, null);
    assert.ok(html.includes('name="arena_lastHero_minHours"')); assert.ok(html.includes('value="90.5"'));
    assert.equal(html.includes('<img id="fixture-xss"'), false); assert.equal(html.includes('</script><img'), false);
    assert.ok(html.includes("&lt;/script&gt;"), "unknown form value must be escaped rather than dropped");
  });
  await t.test("invalid range state is server-visible while the independent context remains useful", async () => {
    const { html, initial } = assertDocument(await raw(server.base, "/population/arena?arena_teamFight_minMatches=bad"), "en");
    assert.equal(initial.meta.selected_status, 400); assert.equal(initial.selected, null); assert.equal(initial.context.sampleN, 300);
    const alert = html.match(/<p([^>]*role="alert"[^>]*)>/); assert.ok(alert); assert.equal(/\bhidden(?:=|\s|$)/.test(alert[1]), false);
    assert.ok(html.includes(messages.en["arena.average.invalidRange"]));
  });
  await t.test("unavailable storage is SSR metadata, not a fabricated zero sample", async () => {
    const unavailable = await fixture.start({ SQLITE_PATH: fixture.directory });
    const { html, initial } = assertDocument(await raw(unavailable.base, "/population/arena"), "en");
    assert.equal(initial.selected, null); assert.equal(initial.context, null); assert.equal(initial.overview, null);
    assert.equal(initial.meta.selected_status, 503); assert.equal(initial.meta.context_status, 503);
    assert.equal(initial.meta.selected_retry_after, 5); assert.equal(initial.meta.context_retry_after, 5);
    assert.ok(html.includes(messages.en["common.loading"]));
  });
  await t.test("population version changes mark initial SSR payloads stale for browser short polling", async () => {
    fixture.playersDb.exec("CREATE TABLE IF NOT EXISTS arena_profile_sync_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
    const set = (value) => fixture.playersDb.prepare("INSERT INTO arena_profile_sync_meta(key,value) VALUES('dynamic_cache_version',?) ON CONFLICT(key)DO UPDATE SET value=excluded.value").run(String(value));
    set(101); const versioned = await fixture.start();
    const fresh = assertDocument(await raw(versioned.base, "/population/arena"), "en").initial;
    assert.equal(fresh.meta.selected_stale, false); assert.equal(fresh.meta.context_stale, false);
    set(102);
    const stale = assertDocument(await raw(versioned.base, "/population/arena"), "en").initial;
    assert.equal(stale.meta.selected_stale, true); assert.equal(stale.meta.context_stale, true);
    assert.equal(stale.meta.selected_status, 200); assert.equal(stale.meta.context_status, 200);
    assert.equal(stale.selected.sampleN, 300); assert.equal(stale.context.sampleN, 300);
  });
  await t.test("alias, trailing slash and methods retain the intended boundary behavior", async () => {
    const alias = await raw(server.base, "/average/arena?unknown=keep&unknown=again");
    assert.equal(alias.status, 308); assert.equal(alias.headers.location, "/population/arena?unknown=keep&unknown=again");
    const trailing = await raw(server.base, "/population/arena/?unknown=keep"); assert.equal(trailing.status, 308); assert.equal(trailing.headers.location, "/population/arena?unknown=keep");
    const options = await raw(server.base, "/population/arena", { method: "OPTIONS" }); assert.equal(options.status, 204); assert.equal(options.headers.allow, "GET, HEAD, OPTIONS");
    const post = await raw(server.base, "/population/arena", { method: "POST" }); assert.equal(post.status, 405); assert.equal(post.body.length, 0); assert.equal(post.headers.allow, undefined);
  });
  await t.test("JS, WASM and CSS equal the current real build, with immutable MIME/ETag/HEAD semantics", async () => {
    for (const [name, kind] of [["tarkov_ui.js", "text/javascript; charset=utf-8"], ["tarkov_ui_bg.wasm", "application/wasm"], ["tarkov_ui.css", "text/css; charset=utf-8"]]) {
      const path = `/_rust/arena/${assets.manifest.hash}/${name}`;
      const response = await raw(server.base, path); assert.equal(response.status, 200); assert.equal(response.headers["content-type"], kind);
      assert.equal(response.headers["cache-control"], "public, max-age=31536000, immutable"); assert.equal(response.headers.etag, `"${assets.manifest.files[name].sha256}"`);
      assert.deepEqual(response.body, assets.bodies.get(name)); assert.equal(createHash("sha256").update(response.body).digest("hex"), assets.manifest.files[name].sha256);
      const head = await raw(server.base, path, { method: "HEAD" }); assert.equal(head.status, 200); assert.equal(head.body.length, 0); assert.equal(head.headers.etag, response.headers.etag);
      const cached = await raw(server.base, path, { headers: { "if-none-match": response.headers.etag } }); assert.equal(cached.status, 304); assert.equal(cached.body.length, 0); assert.equal(cached.headers.etag, response.headers.etag);
    }
  });
  await t.test("only allowlisted hash/files are public; encoded traversal cannot read the manifest or sources", async () => {
    for (const path of [`/_rust/arena/${"0".repeat(64)}/tarkov_ui.js`, `/_rust/arena/${assets.manifest.hash}/manifest.json`, "/_rust/arena/manifest.json",
      `/_rust/arena/${assets.manifest.hash}/%2e%2e`, `/_rust/arena/${assets.manifest.hash}/..%2f..%2fCargo.toml`, `/_rust/arena/${assets.manifest.hash}/tarkov_ui.js%00`]) {
      const response = await raw(server.base, path); assert.ok([400, 404].includes(response.status), `${path}: ${response.status}`);
      assert.equal(response.body.includes(Buffer.from('"files"')), false); assert.equal(response.body.includes(Buffer.from("[dependencies]")), false);
    }
  });
  await t.test("disabled UI stays404 without disabling the independently available native Arena API", async () => {
    const disabled = await fixture.start({ ARENA_UI_UPSTREAM: "web:3000", RUST_UI_ASSETS: join(fixture.directory, "no-assets-needed") });
    for (const path of ["/population/arena", "/average/arena", `/_rust/arena/${assets.manifest.hash}/tarkov_ui.js`]) assert.equal((await raw(disabled.base, path)).status, 404);
    const api = await raw(disabled.base, "/api/average?mode=arena&arenaMode=teamFight&dimension=hours"); assert.equal(api.status, 200);
  });
  await t.test("missing, invalid or corrupt actual assets fail startup before readiness", async () => {
    const absent = join(fixture.directory, "missing-assets");
    assert.match(await startRejectedUi({ ...fixture.configured, RUST_UI_ASSETS: absent }), /manifest unavailable/i);
    for (const kind of ["json", "metadata", "body"]) {
      const root = fixture.cloneAssets(assets);
      if (kind === "json") writeFileSync(join(root, "manifest.json"), "not-json");
      if (kind === "metadata") { const manifest = structuredClone(assets.manifest); manifest.files["tarkov_ui.js"].bytes++; writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest)); }
      if (kind === "body") { const bytes = Buffer.from(assets.bodies.get("tarkov_ui.js")); bytes[0] ^= 1; writeFileSync(join(root, assets.manifest.hash, "tarkov_ui.js"), bytes); }
      assert.match(await startRejectedUi({ ...fixture.configured, RUST_UI_ASSETS: root }), /Rust API failed/i);
    }
  });
});
