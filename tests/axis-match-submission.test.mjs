import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createAxisLeagueStore } from "../lib/admin/axis-league-db.ts";
import { parseAxisOcrNameRows, recheckAxisMatchReviewNames } from "../lib/axis-match-submission.ts";

const mock = source => ({ shortCircuit: true, url: "data:text/javascript," + encodeURIComponent(source) });
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === "next/server") return mock("export function after(work) { globalThis.axisReviewAfter.push(work); }");
  if (specifier === "@/lib/admin/axis-league-db") return mock("export async function getAxisLeagueStore() { return globalThis.axisStore; }");
  if (specifier === "@/lib/admin-auth") return mock("export async function requireAdmin() { return globalThis.axisAdminAccess; }");
  if (specifier === "@/lib/axis-access") return mock("export async function requireAxisScreenshotSubmitter() { return globalThis.axisSubmitAccess; } export async function requireAxisModerator() { return globalThis.axisReviewAccess; }");
  if (specifier === "@/lib/server-axis-ocr") return mock("export async function recognizeAxisPhoto() { globalThis.axisLegacyOcrCalls++; if (globalThis.axisLegacyOcrError) throw new Error('OCR busy'); return globalThis.axisOcrResult; } export async function recognizeAxisPhotoUpload() { globalThis.axisOcrStartedResolve?.(); if (globalThis.axisOcrGate) await globalThis.axisOcrGate; return { photo: { revision: 'a'.repeat(64), width: 1, height: 1, data: new Uint8Array([1]) }, result: globalThis.axisOcrResult }; } export class AxisOcrBusyError extends Error {}");
  if (specifier === "@/lib/auth/google-identity") return mock("export function googleDisplayName(user) { return user.name || null; }");
  if (specifier === "@/lib/arena/service") return mock(`export async function getArenaProfile(aid) {
    globalThis.axisProfileCalls.push(aid);
    if (globalThis.axisProfileErrors.has(aid)) throw new Error("stored profile unavailable");
    return globalThis.axisProfiles.get(aid) ?? null;
  }`);
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
  globalThis.axisReviewAfter = [];
  globalThis.axisLegacyOcrCalls = 0;
  globalThis.axisLegacyOcrError = false;
  t.after(async () => { for (const work of globalThis.axisReviewAfter.splice(0)) await work(); db.close(); });
  globalThis.axisStore = createAxisLeagueStore(db);
  globalThis.axisStore.publishArchive({ page: 1, pages: 1, total: 1, matches: [match()] });
  globalThis.axisSubmitAccess = { ok: true, user: { sub: "player", name: "Player" } };
  globalThis.axisReviewAccess = { ok: true, user: { sub: "moderator", name: "Moderator" } };
  globalThis.axisAdminAccess = { ok: true, user: { sub: "admin", name: "Admin" } };
  globalThis.axisOcrGate = null;
  globalThis.axisOcrStartedResolve = null;
  globalThis.axisProfiles = new Map();
  globalThis.axisProfileErrors = new Set();
  globalThis.axisProfileCalls = [];
  globalThis.axisOcrResult = { score: { left: 5, right: 3 }, scoreConfidence: { left: 1, right: 1 }, crop: { x: 0, y: 0, width: 1, height: 1 }, rows: rowsFor(Array.from({ length: 10 }, (_, index) => `Player ${index + 1}`)) };
  return db;
}

test("name metadata preserves original assignments and rejects invalid or duplicate identities", () => {
  const rows = rowsFor(Array.from({ length: 10 }, (_, i) => "Player " + (i + 1)))
    .map((row, i) => ({ ...row, matchedDiscordId: i === 9 ? null : String(i + 1) }));
  const parsed = parseAxisOcrNameRows(rows);
  assert.equal(parsed[0].matchedDiscordId, "1");
  assert.equal(parsed[9].matchedDiscordId, null);
  assert.equal("kills" in parsed[0], false);
  for (const invalid of ["", "x".repeat(201), 1, {}, true]) {
    assert.throws(() => parseAxisOcrNameRows(rows.map((row, i) => i === 0 ? { ...row, matchedDiscordId: invalid } : row)), /Invalid OCR name assignment/);
  }
  assert.throws(() => parseAxisOcrNameRows(rows.map((row, i) => i === 1 ? { ...row, matchedDiscordId: "1" } : row)), /Invalid OCR name assignment/);
});

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

  setup(t);
  const unreadable = rowsFor(names).map((row, index) => index < 8 ? row : { ...row, nickname: "" });
  globalThis.axisOcrResult = { ...globalThis.axisOcrResult, rows: unreadable };
  assert.equal((await submitPost(request({ matchNumber: 77, photo: { expected: null, data: imageData } }))).status, 200);
  const unreadableReview = globalThis.axisStore.readAxisMatchReview(77);
  assert.deepEqual(unreadableReview.submissions[0].unmatchedNames, ["", ""]);
  assert.equal(unreadableReview.unreadableNames, 2);
  assert.deepEqual(unreadableReview.nicknameMismatches, []);
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

for (const change of ["nickname", "profile link"]) test(`stored Arena ${change} refresh clears old screenshot warnings without another upload`, async t => {
  setup(t);
  const store = globalThis.axisStore;
  store.publish(match().teams.flatMap(team => team.players));
  store.setProfile("9", { aid: 1009, mode: "arena" });
  store.setProfile("10", { aid: 1010, mode: "regular" });
  globalThis.axisProfiles.set(1009, { nickname: "Old Nick 9" });
  globalThis.axisProfiles.set(1010, { nickname: "Old Nick 10" });
  const names = Array.from({ length: 8 }, (_, index) => `Player ${index + 1}`).concat("dn1she2_0", "M950");
  globalThis.axisOcrResult = { ...globalThis.axisOcrResult, rows: rowsFor(names) };
  assert.equal((await submitPost(request({ matchNumber: 77, photo: { expected: null, data: imageData } }))).status, 200);
  // The moderator has already filled the two missing players, as in the report.
  store.setMatchStats(77, ["9", "10"].map(discordId => ({ discordId, kda: { kills: 4, deaths: 5, assists: 6 }, expected: null })));
  const beforeStats = store.readMatchKda(77);
  const getReview = async () => (await (await reviewGet(new Request("https://tarkovstats.ru/api/admin/axis-league/match-review?matches=77"))).json()).reviews[0];
  assert.deepEqual((await getReview()).nicknameMismatches, ["dn1she2_0", "M950"]);

  const newAid = change === "profile link" ? 2009 : 1009;
  if (change === "profile link") store.setProfile("9", { aid: newAid, mode: "arena" });
  globalThis.axisProfiles.set(newAid, { nickname: " DN1she2_0 " });
  globalThis.axisProfiles.set(1010, { nickname: "M950" });
  globalThis.axisProfileCalls = [];
  const after = await getReview();
  assert.deepEqual(after.nicknameMismatches, []);
  assert.deepEqual(after.unmatchedNames, []);
  assert.deepEqual(after.missingStats, []);
  assert.equal(after.submissions.length, 1);
  assert.deepEqual(after.submissions[0].unmatchedNames, ["dn1she2_0", "M950"], "original OCR evidence stays intact");
  assert.deepEqual(store.readMatchKda(77), beforeStats, "review reads do not rewrite KDA");
  assert.deepEqual(globalThis.axisProfileCalls.sort((a, b) => a - b), [newAid, 1010].sort((a, b) => a - b), "current stored Arena names are read even for a regular-mode link");
  assert.deepEqual(store.readAxisMatchReview(77).nicknameMismatches, ["dn1she2_0", "M950"], "persisted upload evidence is not overwritten");
});

test("profile failures and missing links retain warnings and moderator access is checked first", async t => {
  setup(t);
  const store = globalThis.axisStore;
  store.publish(match().teams.flatMap(team => team.players));
  store.setProfile("9", { aid: 1009, mode: "arena" });
  store.submitAxisMatch(77, photo("c"), [], undefined,
    { recognizedNames: ["dn1she2_0", "M950"], unmatchedNames: ["dn1she2_0", "M950", ""] }, { sub: "player", name: "Player" });
  globalThis.axisProfileErrors.add(1009);
  const get = () => reviewGet(new Request("https://tarkovstats.ru/api/admin/axis-league/match-review?matches=77"));
  globalThis.axisReviewAccess = { ok: false, status: 403 };
  assert.equal((await get()).status, 403);
  assert.deepEqual(globalThis.axisProfileCalls, []);
  globalThis.axisReviewAccess = { ok: true, user: { sub: "moderator" } };
  const response = await get();
  assert.equal(response.status, 200);
  const review = (await response.json()).reviews[0];
  assert.deepEqual(review.nicknameMismatches, ["dn1she2_0", "M950"]);
  assert.equal(review.unreadableNames, 1);
});

test("saved name rechecks retain ambiguous aliases, unreadable rows and unrelated review issues", t => {
  setup(t);
  const store = globalThis.axisStore;
  store.submitAxisMatch(77, photo("c"), [], undefined,
    { recognizedNames: ["Alias", "alias"], unmatchedNames: ["Alias", "alias", ""] }, { sub: "player", name: "Player" });
  const review = store.readAxisMatchReview(77);
  const participants = match().teams.flatMap((team, teamIndex) => team.players.map(player => ({
    discordId: player.id, teamIndex, historyName: player.name, arenaNickname: player.id === "1" ? "Alias" : null,
  })));
  const names = Array.from({ length: 10 }, (_, index) => `Player ${index + 1}`);
  const evidence = (first, second) => {
    const rows = rowsFor([first, second, ...names.slice(2)]);
    review.submissions[0].recognizedNames = rows.map(row => row.nickname).filter(Boolean);
    review.submissions[0].unmatchedNames = [first, second];
    review.submissions[0].nameRows = rows.map((row, i) => ({ ...row, matchedDiscordId: i < 2 ? null : String(i + 1) }));
  };
  evidence("Alias", "alias");
  assert.deepEqual(recheckAxisMatchReviewNames(review, participants).nicknameMismatches, ["Alias", "alias"], "duplicate screenshot names remain ambiguous");
  evidence("Alias", "");
  participants[1].arenaNickname = "alias";
  assert.deepEqual(recheckAxisMatchReviewNames(review, participants).nicknameMismatches, ["Alias"], "shared player aliases remain ambiguous");
  participants[1].arenaNickname = null;
  evidence("Alias", "Player 1");
  review.submissions[0].unmatchedNames = ["Alias"];
  assert.deepEqual(recheckAxisMatchReviewNames(review, participants).nicknameMismatches, ["Alias"], "one player cannot match two screenshot rows");
  evidence("Alias", "");
  const result = recheckAxisMatchReviewNames(review, participants);
  assert.deepEqual(result.nicknameMismatches, []);
  assert.deepEqual(result.unmatchedNames, [""]);
  assert.equal(result.unreadableNames, 1);
  assert.deepEqual(result.missingStats, review.missingStats);
  assert.deepEqual(result.conflicts, review.conflicts);
  assert.deepEqual(result.roundConflict, review.roundConflict);
  review.submissions[0].nameRows = null;
  assert.deepEqual(recheckAxisMatchReviewNames(review, participants).nicknameMismatches, ["Alias"], "legacy names need side evidence before resolution");
  evidence("Alias", "");
  review.submissions[0].nameRows[0].nickname = "Different OCR";
  assert.deepEqual(recheckAxisMatchReviewNames(review, participants).nicknameMismatches, ["Alias"], "changed legacy OCR cannot clear original warnings");
});

for (const renamedPlayer of ["2", "6"]) test(`a nickname transferred to an already matched player ${renamedPlayer} cannot clear a saved warning`, async t => {
  setup(t);
  const store = globalThis.axisStore;
  store.publish(match().teams.flatMap(team => team.players));
  store.setProfile(renamedPlayer, { aid: 1006, mode: "arena" });
  globalThis.axisProfiles.set(1006, { nickname: "Old Arena Name" });
  const names = Array.from({ length: 10 }, (_, index) => `Player ${index + 1}`);
  names[0] = "dn1she2_0";
  names[Number(renamedPlayer) - 1] = "Old Arena Name";
  globalThis.axisOcrResult = { ...globalThis.axisOcrResult, rows: rowsFor(names) };
  assert.equal((await submitPost(request({ matchNumber: 77, photo: { expected: null, data: imageData } }))).status, 200);
  globalThis.axisProfiles.set(1006, { nickname: "dn1she2_0" });
  const response = await reviewGet(new Request("https://tarkovstats.ru/api/admin/axis-league/match-review?matches=77"));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).reviews[0].nicknameMismatches, ["dn1she2_0"]);
});

test("swapping Arena aliases within one team cannot reassign an originally matched row", async t => {
  setup(t);
  const store = globalThis.axisStore;
  store.publish(match().teams.flatMap(team => team.players));
  store.setProfile("1", { aid: 1001, mode: "arena" });
  store.setProfile("2", { aid: 1002, mode: "arena" });
  globalThis.axisProfiles.set(1002, { nickname: "Old Arena Name" });
  const names = ["Unmatched", "Old Arena Name", ...Array.from({ length: 8 }, (_, i) => "Player " + (i + 3))];
  globalThis.axisOcrResult = { ...globalThis.axisOcrResult, rows: rowsFor(names) };
  assert.equal((await submitPost(request({ matchNumber: 77, photo: { expected: null, data: imageData } }))).status, 200);
  const initialRows = store.readAxisMatchReview(77).submissions[0].nameRows;
  assert.equal(initialRows[0].matchedDiscordId, null);
  assert.equal(initialRows[1].matchedDiscordId, "2", "the original Arena alias owner is persisted");
  globalThis.axisProfiles.set(1001, { nickname: "Unmatched" });
  const valid = await reviewGet(new Request("https://tarkovstats.ru/api/admin/axis-league/match-review?matches=77"));
  assert.deepEqual((await valid.json()).reviews[0].nicknameMismatches, [], "a new match preserves every previously matched identity");
  globalThis.axisProfiles.set(1001, { nickname: "Old Arena Name" });
  globalThis.axisProfiles.set(1002, { nickname: "Unmatched" });
  const response = await reviewGet(new Request("https://tarkovstats.ru/api/admin/axis-league/match-review?matches=77"));
  assert.deepEqual((await response.json()).reviews[0].nicknameMismatches, ["Unmatched"]);
  const review = store.readAxisMatchReview(77);
  const participants = match().teams.flatMap((team, teamIndex) => team.players.map(player => ({
    discordId: player.id, teamIndex, historyName: player.name,
    arenaNickname: player.id === "1" ? "Old Arena Name" : player.id === "2" ? "Unmatched" : null,
  })));
  for (const row of review.submissions[0].nameRows) delete row.matchedDiscordId;
  assert.deepEqual(recheckAxisMatchReviewNames(review, participants).nicknameMismatches, ["Unmatched"], "legacy metadata cannot reconstruct the original Arena alias owner");
});

test("newly matched nicknames on the wrong team sides retain both warnings", async t => {
  setup(t);
  const store = globalThis.axisStore;
  store.publish(match().teams.flatMap(team => team.players));
  store.setProfile("1", { aid: 1001, mode: "arena" });
  store.setProfile("6", { aid: 1006, mode: "arena" });
  const names = Array.from({ length: 10 }, (_, index) => `Player ${index + 1}`);
  names[0] = "dn1she2_0";
  names[5] = "M950";
  globalThis.axisOcrResult = { ...globalThis.axisOcrResult, rows: rowsFor(names) };
  assert.equal((await submitPost(request({ matchNumber: 77, photo: { expected: null, data: imageData } }))).status, 200);
  globalThis.axisProfiles.set(1001, { nickname: "M950" });
  globalThis.axisProfiles.set(1006, { nickname: "dn1she2_0" });
  const response = await reviewGet(new Request("https://tarkovstats.ru/api/admin/axis-league/match-review?matches=77"));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).reviews[0].nicknameMismatches, ["dn1she2_0", "M950"]);
});

for (const withNameRows of [false, true]) test("legacy warnings retain their original uncertainty after archive name changes, metadata=" + withNameRows, async t => {
  setup(t);
  const store = globalThis.axisStore;
  const names = ["Unmatched", ...Array.from({ length: 9 }, (_, i) => "Player " + (i + 2))];
  store.submitAxisMatch(77, photo("c"), [], undefined,
    { recognizedNames: names, unmatchedNames: ["Unmatched"], ...(withNameRows ? { nameRows: rowsFor(names) } : {}) }, { sub: "player", name: "Player" });
  const get = () => reviewGet(new Request("https://tarkovstats.ru/api/admin/axis-league/match-review?matches=77"));
  assert.deepEqual((await (await get()).json()).reviews[0].nicknameMismatches, ["Unmatched"]);
  const refreshed = match();
  refreshed.teams[0].players[0].name = "Player 2";
  refreshed.teams[0].players[1].name = "Unmatched";
  store.publishArchive({ page: 1, pages: 1, total: 1, matches: [refreshed] });
  assert.deepEqual((await (await get()).json()).reviews[0].nicknameMismatches, ["Unmatched"], "today's archived names cannot supply original identities");
  assert.equal(globalThis.axisLegacyOcrCalls, 0, "review reads do not repeat OCR that cannot recover original identities");
  assert.equal(globalThis.axisReviewAfter.length, 0);
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


test("legacy Moiyannry warning resolves only for the sole originally missing player without rewriting evidence or KDA", async t => {
  setup(t);
  const store = globalThis.axisStore;
  store.publish(match().teams.flatMap(team => team.players));
  const names = Array.from({ length: 10 }, (_, i) => "Player " + (i + 1));
  names[1] = "Moiyannry";
  const nameRows = rowsFor(names);
  store.submitAxisMatch(77, photo("c"), [], undefined, {
    recognizedNames: names, unmatchedNames: ["Moiyannry"], missingDiscordIds: ["2"], nameRows,
  }, { sub: "player", name: "Player" });
  store.setMatchStats(77, match().teams.flatMap(team => team.players).map(player => ({
    discordId: player.id, kda: { kills: 16, deaths: 16, assists: 6 }, expected: null,
  })));
  store.setProfile("2", { aid: 15069462, mode: "arena" });
  globalThis.axisProfiles.set(15069462, { nickname: "Moiyannry" });
  const before = store.readAxisMatchReview(77), stats = store.readMatchKda(77);
  assert.deepEqual(before.missingStats, [], "manual statistics were already entered");
  const response = await reviewGet(new Request("https://tarkovstats.ru/api/admin/axis-league/match-review?matches=77"));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).reviews[0].nicknameMismatches, []);
  assert.deepEqual(store.readAxisMatchReview(77), before, "stored upload evidence stays unchanged");
  assert.deepEqual(store.readMatchKda(77), stats);

  const participants = match().teams.flatMap((team, teamIndex) => team.players.map(player => ({
    discordId: player.id, teamIndex, historyName: player.name, arenaNickname: player.id === "2" ? "Moiyannry" : null,
  })));
  const rejected = (change, label) => {
    const review = structuredClone(before), roster = structuredClone(participants);
    change(review.submissions[0], roster);
    assert.deepEqual(recheckAxisMatchReviewNames(review, roster).nicknameMismatches, ["Moiyannry"], label);
  };
  rejected((submission) => { submission.missingDiscordIds = ["1"]; }, "current match must be the originally missing ID");
  rejected((submission) => { submission.missingDiscordIds = ["1", "2"]; }, "two original missing players cannot be reconstructed");
  rejected((submission) => { submission.missingDiscordIds = []; }, "current missing KDA cannot replace original missing IDs");
  rejected((submission) => { submission.nameRows[0].matchedDiscordId = "1"; }, "partial legacy identity metadata abstains");
  rejected((submission) => { submission.nameRows[0].matchedDiscordId = null; }, "explicit null is not legacy metadata");
  rejected((submission) => {
    submission.nameRows[0].nickname = ""; submission.recognizedNames = names.slice(1);
  }, "an unreadable supporting row cannot prove complete coverage");
  rejected((_submission, roster) => {
    roster[0].historyName = "Player 6"; roster[5].historyName = "Player 1";
  }, "mixed team sides retain the warning");
  rejected((_submission, roster) => { roster[0].arenaNickname = "Moiyannry"; }, "duplicate aliases retain the warning");
});

test("Porvan underscore OCR warning clears while preserving other unmatched names and original assignments", t => {
  setup(t);
  const store = globalThis.axisStore;
  const names = ["Porvan____2z", ...Array.from({ length: 8 }, (_, i) => "Player " + (i + 2)), "Warm9nin"];
  store.submitAxisMatch(77, photo("c"), [], undefined, {
    recognizedNames: names, unmatchedNames: ["Porvan____2z", "Warm9nin"], missingDiscordIds: ["1", "10"],
    nameRows: rowsFor(names).map((row, i) => ({ ...row, matchedDiscordId: i === 0 || i === 9 ? null : String(i + 1) })),
  }, { sub: "player", name: "Player" });
  const before = store.readAxisMatchReview(77);
  const roster = match().teams.flatMap((team, teamIndex) => team.players.map(player => ({
    discordId: player.id, teamIndex, historyName: player.name, arenaNickname: player.id === "1" ? "Porvan_____2z" : null,
  })));
  assert.deepEqual(recheckAxisMatchReviewNames(before, roster).nicknameMismatches, ["Warm9nin"]);
  assert.deepEqual(store.readAxisMatchReview(77), before);
  roster[1].historyName = "Player 3"; roster[2].historyName = "Player 2";
  assert.deepEqual(recheckAxisMatchReviewNames(before, roster).nicknameMismatches, ["Porvan____2z", "Warm9nin"],
    "original assigned identities must still match even on the same team");
});
