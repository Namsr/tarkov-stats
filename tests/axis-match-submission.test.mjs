import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createAxisLeagueStore } from "../lib/admin/axis-league-db.ts";

const mock = source => ({ shortCircuit: true, url: "data:text/javascript," + encodeURIComponent(source) });
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === "@/lib/admin/axis-league-db") return mock("export async function getAxisLeagueStore() { return globalThis.axisStore; }");
  if (specifier === "@/lib/admin-auth") return mock("export async function requireAdmin() { return globalThis.axisAdminAccess; }");
  if (specifier === "@/lib/axis-access") return mock("export async function requireAxisScreenshotSubmitter() { return globalThis.axisSubmitAccess; } export async function requireAxisModerator() { return globalThis.axisReviewAccess; }");
  if (specifier === "@/lib/server-axis-ocr") return mock("export async function recognizeAxisPhoto() { return globalThis.axisOcrResult; } export async function recognizeAxisPhotoUpload() { globalThis.axisOcrStartedResolve?.(); if (globalThis.axisOcrGate) await globalThis.axisOcrGate; return { photo: { revision: 'a'.repeat(64), width: 1, height: 1, data: new Uint8Array([1]) }, result: globalThis.axisOcrResult }; } export class AxisOcrBusyError extends Error {}");
  if (specifier === "@/lib/auth/google-identity") return mock("export function googleDisplayName(user) { return user.name || null; }");
  if (specifier === "@/lib/arena/service") return mock("export async function getArenaProfile() { return null; }");
  if (specifier.startsWith("@/")) return { shortCircuit: true, url: pathToFileURL(resolve(specifier.slice(2) + ".ts")).href };
  return nextResolve(specifier, context);
} });

const { POST: submitPost } = await import("../app/api/axis-league/match-submission/route.ts");
const { GET: reviewGet } = await import("../app/api/admin/axis-league/match-review/route.ts");
const { GET: rolesGet, POST: rolesPost } = await import("../app/api/admin/axis-league/editors/route.ts");
const { validateAxisOcrNames } = await import("../lib/axis-server-match-validation.ts");

const imageData = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const photo = revision => ({ revision: revision.repeat(64), width: 1, height: 1, data: new Uint8Array([1]) });
const rowsFor = (names, stats = true) => names.map((nickname, index) => ({
  id: `${index < 5 ? "left" : "right"}:${index % 5}`, side: index < 5 ? "left" : "right", index: index % 5, nickname,
  kills: stats ? index + 1 : null, deaths: stats ? index + 2 : null, assists: stats ? index + 3 : null,
  numberConfidence: { kills: 1, deaths: 1, assists: 1 }, confidence: 1,
}));

function match() {
  return {
    number: 77, time: Date.now(), queueId: "1343726040421367842", queue: "Arena League", maps: [], winner: 0,
    teams: [0, 1].map(teamIndex => ({ name: null, players: Array.from({ length: 5 }, (_, index) => ({
      id: String(teamIndex * 5 + index + 1), name: `Player ${teamIndex * 5 + index + 1}`, mmr: 1000, change: 1, profile: null,
    })) })),
  };
}

function request(body, path = "/api/axis-league/match-submission", headers = {}) {
  return new Request(`https://tarkovstats.ru${path}`, { method: "POST", headers: { origin: "https://tarkovstats.ru", "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}

function setup(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  globalThis.axisStore = createAxisLeagueStore(db);
  globalThis.axisStore.publishArchive({ page: 1, pages: 1, total: 1, matches: [match()] });
  globalThis.axisSubmitAccess = { ok: true, user: { sub: "player", name: "Player" } };
  globalThis.axisReviewAccess = { ok: true, user: { sub: "moderator", name: "Moderator" } };
  globalThis.axisAdminAccess = { ok: true, user: { sub: "admin", name: "Admin" } };
  globalThis.axisOcrGate = null;
  globalThis.axisOcrStartedResolve = null;
  globalThis.axisOcrResult = { score: { left: 5, right: 3 }, scoreConfidence: { left: 1, right: 1 }, crop: { x: 0, y: 0, width: 1, height: 1 }, rows: rowsFor(Array.from({ length: 10 }, (_, index) => `Player ${index + 1}`)) };
  return db;
}

test("roles keep player uploads separate from moderator editing and preserve old editors", t => {
  setup(t);
  const store = globalThis.axisStore;
  store.setAxisRole("player", "player");
  store.setAxisRole("moderator", "moderator");
  store.setKdaEditor("legacy", true);
  assert.equal(store.readAxisRole("player"), "player");
  assert.equal(store.readAxisRole("moderator"), "moderator");
  assert.equal(store.readAxisRole("legacy"), "moderator");
  assert.equal(store.readAxisRole("unknown"), null);
  assert.equal(store.isAxisUploader("player"), true);
  assert.equal(store.isKdaEditor("player"), false);
  assert.equal(store.isAxisModerator("player"), false);
  assert.equal(store.isAxisModerator("moderator"), true);
  assert.equal(store.isKdaEditor("moderator"), true);
  assert.deepEqual(store.listAxisRoles().map(row => ({ ...row })), [
    { subject: "legacy", name: null, role: "moderator" },
    { subject: "moderator", name: null, role: "moderator" },
    { subject: "player", name: null, role: "player" },
  ]);
});

test("submission endpoint rejects forged client stats and accepts only trusted OCR values", async t => {
  setup(t);
  globalThis.axisOcrResult = { ...globalThis.axisOcrResult, rows: rowsFor(Array.from({ length: 10 }, (_, index) => `Player ${index + 1}`), false) };
  globalThis.axisSubmitAccess = { ok: false, status: 403 };
  assert.equal((await submitPost(request({ matchNumber: 77, players: [{ discordId: "1", kda: { kills: 999, deaths: 0, assists: 0 } }], photo: { expected: null, data: imageData } }))).status, 403);
  globalThis.axisSubmitAccess = { ok: true, user: { sub: "player", name: "Player" } };
  const response = await submitPost(request({ matchNumber: 77, players: [{ discordId: "1", kda: { kills: 999, deaths: 0, assists: 0 } }], photo: { expected: null, data: imageData } }));
  assert.equal(response.status, 200);
  const responseBody = await response.json();
  assert.equal("review" in responseBody, false, "player uploads do not receive moderator review data");
  assert.equal(globalThis.axisStore.readMatchKda(77).size, 0, "client-supplied stats are never accepted");
  assert.equal((await submitPost(request({ matchNumber: 77, photo: { expected: null, data: imageData } }, "/api/axis-league/match-submission", { origin: "https://evil.test" }))).status, 403);
  assert.equal((await submitPost(request({ matchNumber: 77, photo: { expected: null, data: imageData } }, "/api/axis-league/match-submission", { "content-type": "text/plain" }))).status, 415);
});

test("name validation allows two mismatches but rejects a third", async t => {
  setup(t);
  globalThis.axisOcrResult = { ...globalThis.axisOcrResult, rows: rowsFor(["Player 1", "Player 2", "Player 3", "Player 4", "Player 5", "Player 6", "Player 7", "Player 8", "Wrong 9", "Wrong 10"], false) };
  assert.equal((await submitPost(request({ matchNumber: 77, photo: { expected: null, data: imageData } }))).status, 200);
  globalThis.axisOcrResult = { ...globalThis.axisOcrResult, rows: rowsFor(["Player 1", "Player 2", "Player 3", "Player 4", "Player 5", "Player 6", "Player 7", "Wrong 8", "Wrong 9", "Wrong 10"], false) };
  assert.equal((await submitPost(request({ matchNumber: 77, photo: { expected: null, data: imageData } }))).status, 422);
});

test("strict OCR validation accepts reversed sides, rejects mixed sides, and records missing counters", async t => {
  setup(t);
  const names = Array.from({ length: 10 }, (_, index) => `Player ${index + 1}`);
  const reversed = rowsFor(names).map((row, index) => ({ ...row, side: index < 5 ? "right" : "left" }));
  globalThis.axisOcrResult = { ...globalThis.axisOcrResult, rows: reversed };
  assert.equal((await submitPost(request({ matchNumber: 77, photo: { expected: null, data: imageData } }))).status, 200);

  setup(t);
  const mixed = rowsFor(names);
  mixed[0].side = "right"; mixed[5].side = "left";
  globalThis.axisOcrResult = { ...globalThis.axisOcrResult, rows: mixed };
  assert.equal((await submitPost(request({ matchNumber: 77, photo: { expected: null, data: imageData } }))).status, 422);

  setup(t);
  const partial = rowsFor(names).map((row, index) => index < 8 ? row : { ...row, kills: null, deaths: null, assists: null });
  globalThis.axisOcrResult = { ...globalThis.axisOcrResult, rows: partial };
  assert.equal((await submitPost(request({ matchNumber: 77, photo: { expected: null, data: imageData } }))).status, 200);
  assert.deepEqual(globalThis.axisStore.readAxisMatchReview(77).submissions[0].missingDiscordIds, ["9", "10"]);
});

test("OCR validation accepts the current Arena nickname alias for each roster player", () => {
  const context = {
    matchNumber: 77,
    participants: Array.from({ length: 10 }, (_, index) => ({
      discordId: String(index + 1), teamIndex: index < 5 ? 0 : 1,
      historyName: `History ${index + 1}`, arenaNickname: `Arena ${index + 1}`,
    })),
  };
  const result = { score: { left: null, right: null }, scoreConfidence: { left: null, right: null }, crop: { x: 0, y: 0, width: 1, height: 1 }, rows: rowsFor(Array.from({ length: 10 }, (_, index) => `Arena ${index + 1}`)) };
  assert.equal(validateAxisOcrNames(result, context).matchedIds.size, 10);
});

test("revocation during OCR prevents the upload transaction", async t => {
  setup(t);
  let release;
  globalThis.axisOcrGate = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { globalThis.axisOcrStartedResolve = resolve; });
  const pending = submitPost(request({ matchNumber: 77, photo: { expected: null, data: imageData } }));
  await entered;
  globalThis.axisSubmitAccess = { ok: false, status: 403 };
  release();
  assert.equal((await pending).status, 403);
  assert.equal(globalThis.axisStore.readMatchKda(77).size, 0);
});

test("multiple screenshots complement missing KDA and retain conflicts and evidence", t => {
  setup(t);
  const store = globalThis.axisStore;
  const all = Array.from({ length: 10 }, (_, index) => String(index + 1));
  store.submitAxisMatch(77, photo("a"), all.slice(0, 5).map((discordId, index) => ({ discordId, kda: { kills: index + 1, deaths: 1, assists: 0 }, expected: null })), undefined, { recognizedNames: all.slice(0, 5).map(id => `Player ${id}`), unmatchedNames: [] }, { sub: "one", name: "One" });
  const second = store.submitAxisMatch(77, photo("b"), [...all.slice(5).map((discordId, index) => ({ discordId, kda: { kills: index + 2, deaths: 1, assists: 0 }, expected: null })), { discordId: "1", kda: { kills: 99, deaths: 1, assists: 0 }, expected: null }], undefined, { recognizedNames: all.slice(5).map(id => `Player ${id}`), unmatchedNames: ["Wrong Nick"] }, { sub: "two", name: "Two" });
  assert.equal(second.conflicts.length, 1);
  assert.equal(store.readMatchKda(77).size, 10);
  const review = store.readAxisMatchReview(77);
  assert.equal(review.submissions.length, 2);
  assert.deepEqual(review.nicknameMismatches, ["Wrong Nick"]);
  assert.equal(review.conflicts.length, 1);
  const same = store.submitAxisMatch(77, photo("b"), [], undefined, { recognizedNames: [], unmatchedNames: [] }, { sub: "two", name: "Two" });
  assert.equal(same.conflicts.length, 0);
  assert.equal(store.readAxisMatchReview(77).submissions.length, 2, "same normalized image is idempotent");
});

test("review endpoint is moderator-only and returns only submitted matches", async t => {
  setup(t);
  globalThis.axisReviewAccess = { ok: false, status: 403 };
  assert.equal((await reviewGet(new Request("https://tarkovstats.ru/api/admin/axis-league/match-review?matches=77"))).status, 403);
  globalThis.axisReviewAccess = { ok: true, user: { sub: "moderator", name: "Moderator" } };
  const empty = await reviewGet(new Request("https://tarkovstats.ru/api/admin/axis-league/match-review?matches=77"));
  assert.deepEqual((await empty.json()).reviews, []);
  globalThis.axisStore.setMatchPhoto(77, null, photo("f"));
  const legacyReview = await reviewGet(new Request("https://tarkovstats.ru/api/admin/axis-league/match-review?matches=77"));
  assert.equal((await legacyReview.json()).reviews[0].missingStats.length, 10, "legacy photos still expose missing statistics");
  globalThis.axisStore.submitAxisMatch(77, photo("c"), [], undefined, { recognizedNames: ["Player 1"], unmatchedNames: ["Wrong"] }, { sub: "player", name: "Player" });
  const response = await reviewGet(new Request("https://tarkovstats.ru/api/admin/axis-league/match-review?matches=77"));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).reviews[0].submissions.length, 2);
});

test("role endpoint accepts player and moderator assignments", async t => {
  setup(t);
  assert.equal((await rolesPost(request({ subject: "player", enabled: true, role: null }, "/api/admin/axis-league/editors"))).status, 400);
  assert.equal((await rolesPost(request({ subject: "player", enabled: true, role: "player" }, "/api/admin/axis-league/editors"))).status, 200);
  assert.equal((await rolesPost(request({ subject: "moderator", enabled: true, role: "moderator" }, "/api/admin/axis-league/editors"))).status, 200);
  assert.deepEqual((await (await rolesGet()).json()).editors.map(row => ({ ...row })), [
    { subject: "moderator", name: null, role: "moderator" }, { subject: "player", name: null, role: "player" },
  ]);
});
