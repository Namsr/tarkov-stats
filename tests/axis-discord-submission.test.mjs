import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createAxisLeagueStore } from "../lib/admin/axis-league-db.ts";

const mock = source => ({ shortCircuit: true, url: "data:text/javascript," + encodeURIComponent(source) });
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === "@/lib/admin/mutation") return mock("export const ADMIN_NO_STORE_HEADERS = { 'Cache-Control': 'no-store' };");
  if (specifier === "@/lib/admin/axis-league-db") return mock("export async function getAxisLeagueStore() { return globalThis.axisStore; }");
  if (specifier === "@/lib/server-axis-ocr") return mock("export async function recognizeAxisPhotoUpload() { if (globalThis.axisOcrGate) await globalThis.axisOcrGate; return { photo: { revision: globalThis.axisPhotoRevision.repeat(64), width: 1, height: 1, data: new Uint8Array([1]) }, result: globalThis.axisOcrResult }; } export class AxisOcrBusyError extends Error {}");
  if (specifier === "@/lib/arena/service") return mock("export async function getArenaProfile() { return null; }");
  if (specifier.startsWith("@/")) return { shortCircuit: true, url: pathToFileURL(resolve(specifier.slice(2) + ".ts")).href };
  return nextResolve(specifier, context);
} });

const { POST } = await import("../app/api/integrations/discord/axis-submission/route.ts");

const SECRET = "S".repeat(40);
const GUILD = "100000000000000001";
const CHANNEL = "200000000000000001";
const PARENT = "200000000000000002";
const MESSAGE = "300000000000000001";
const ATTACHMENT = "400000000000000001";
const imageData = "trusted-test-image";

function rowsFor(names, stats = true) {
  return names.map((nickname, index) => ({
    id: `${index < 5 ? "left" : "right"}:${index % 5}`,
    side: index < 5 ? "left" : "right",
    index: index % 5,
    nickname,
    kills: stats ? index + 1 : null,
    deaths: stats ? index + 2 : null,
    assists: stats ? index + 3 : null,
    numberConfidence: { kills: 0.98, deaths: 0.97, assists: 0.96 },
    confidence: 0.95,
  }));
}

function match() {
  return {
    number: 77, time: Date.now(), queueId: "1343726040421367842", queue: "Arena League", maps: [], winner: 0,
    teams: [0, 1].map(teamIndex => ({ name: null, players: Array.from({ length: 5 }, (_, index) => ({
      id: String(teamIndex * 5 + index + 1), name: `Player ${teamIndex * 5 + index + 1}`, mmr: 1000, change: 1, profile: null,
    })) })),
  };
}

function payload(overrides = {}) {
  return {
    matchNumber: 77, guildId: GUILD, channelId: CHANNEL, parentChannelId: null,
    messageId: MESSAGE, attachmentId: ATTACHMENT, authorId: "500000000000000001",
    photo: { data: imageData }, ...overrides,
  };
}

function request(body, { secret = SECRET, contentType = "application/json", contentLength } = {}) {
  const headers = { authorization: `Bearer ${secret}`, "content-type": contentType };
  if (contentLength !== undefined) headers["content-length"] = String(contentLength);
  return new Request("https://tarkovstats.ru/api/integrations/discord/axis-submission", {
    method: "POST", headers, body: contentType === "application/json" ? JSON.stringify(body) : "not-json",
  });
}

function setup(t) {
  const oldEnv = {
    AXIS_DISCORD_SECRET: process.env.AXIS_DISCORD_SECRET,
    AXIS_DISCORD_GUILD_ID: process.env.AXIS_DISCORD_GUILD_ID,
    AXIS_DISCORD_CHANNEL_IDS: process.env.AXIS_DISCORD_CHANNEL_IDS,
  };
  t.after(() => {
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.AXIS_DISCORD_SECRET = SECRET;
  process.env.AXIS_DISCORD_GUILD_ID = GUILD;
  process.env.AXIS_DISCORD_CHANNEL_IDS = `${CHANNEL},${PARENT}`;
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  globalThis.axisStore = createAxisLeagueStore(db);
  globalThis.axisStore.publishArchive({ page: 1, pages: 1, total: 1, matches: [match()] });
  globalThis.axisOcrGate = null;
  globalThis.axisPhotoRevision = "a";
  globalThis.axisOcrResult = {
    score: { left: 5, right: 3 }, scoreConfidence: { left: 0.99, right: 0.98 },
    crop: { x: 0, y: 0, width: 1, height: 1 },
    rows: rowsFor(Array.from({ length: 10 }, (_, index) => `Player ${index + 1}`)),
  };
  return db;
}

test("Discord endpoint stays disabled without a complete server configuration", async t => {
  setup(t);
  delete process.env.AXIS_DISCORD_SECRET;
  assert.equal((await POST(request(payload()))).status, 503);
  process.env.AXIS_DISCORD_SECRET = "short";
  assert.equal((await POST(request(payload()))).status, 503);
});

test("Discord endpoint authenticates the bearer and source IDs before OCR", async t => {
  setup(t);
  assert.equal((await POST(request(payload(), { secret: "W".repeat(40) }))).status, 401);
  assert.equal((await POST(request(payload({ guildId: "10000000000000000" })))).status, 403);
  assert.equal((await POST(request(payload({ channelId: "200000000000000003", parentChannelId: null })))).status, 403);
  assert.equal((await POST(request(payload({ attachmentId: "4" })))).status, 400);
  assert.equal((await POST(request(payload(), { contentType: "text/plain" }))).status, 415);
  const oversized = payload({ photo: { data: "x".repeat(15 * 1024 * 1024) } });
  assert.equal((await POST(request(oversized))).status, 413);
});

test("Discord submission persists trusted OCR values and hides review identities", async t => {
  const db = setup(t);
  const response = await POST(request(payload({ authorId: "500000000000000002" })));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true, matchNumber: 77, recognizedPlayers: 10, totalPlayers: 10,
    coveragePercent: 100, confidencePercent: 96, needsReview: false,
    missingPlayers: [], unmatchedNames: [], conflictPlayers: [],
  });
  assert.equal(globalThis.axisStore.readMatchKda(77).size, 10);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM axis_google_accounts").get().count, 0, "Discord authors are not Google accounts");
  assert.equal(globalThis.axisStore.readAxisMatchReview(77).submissions[0].uploadedBy, "discord_500000000000000002");
});

test("duplicate and concurrent Discord deliveries are idempotent", async t => {
  setup(t);
  const first = await POST(request(payload({ authorId: "500000000000000003" })));
  const duplicate = await POST(request(payload({ authorId: "500000000000000004" })));
  assert.equal(first.status, 200);
  assert.equal(duplicate.status, 200);
  assert.equal(globalThis.axisStore.readAxisMatchReview(77).submissions.length, 1);

  setup(t);
  const responses = await Promise.all([
    POST(request(payload({ authorId: "500000000000000005" }))),
    POST(request(payload({ authorId: "500000000000000006" }))),
  ]);
  assert.deepEqual(responses.map(response => response.status), [200, 200]);
  assert.equal(globalThis.axisStore.readAxisMatchReview(77).submissions.length, 1);
});

test("multiple screenshots supplement missing KDA and preserve conflicts", async t => {
  setup(t);
  const names = Array.from({ length: 10 }, (_, index) => `Player ${index + 1}`);
  globalThis.axisOcrResult = {
    ...globalThis.axisOcrResult,
    rows: rowsFor(names).map((row, index) => index < 8 ? row : { ...row, kills: null, deaths: null, assists: null }),
  };
  const first = await POST(request(payload({ authorId: "500000000000000010" })));
  assert.equal(first.status, 200);
  assert.deepEqual((await first.json()), {
    ok: true, matchNumber: 77, recognizedPlayers: 8, totalPlayers: 10,
    coveragePercent: 80, confidencePercent: null, needsReview: true,
    missingPlayers: ["Player 9", "Player 10"], unmatchedNames: [], conflictPlayers: [],
  });
  assert.equal(globalThis.axisStore.readMatchKda(77).size, 8);
  assert.equal(globalThis.axisStore.readAxisMatchReview(77).submissions.length, 1);

  globalThis.axisPhotoRevision = "b";
  globalThis.axisOcrResult = { ...globalThis.axisOcrResult, rows: rowsFor(names) };
  const second = await POST(request(payload({ authorId: "500000000000000010" })));
  assert.equal(second.status, 200);
  assert.deepEqual(await second.json(), {
    ok: true, matchNumber: 77, recognizedPlayers: 10, totalPlayers: 10,
    coveragePercent: 100, confidencePercent: 96, needsReview: false,
    missingPlayers: [], unmatchedNames: [], conflictPlayers: [],
  });
  assert.equal((await POST(request(payload({ authorId: "500000000000000010" })))).status, 200, "same photo can be retried");
  assert.equal(globalThis.axisStore.readMatchKda(77).size, 10);
  assert.equal(globalThis.axisStore.readAxisMatchReview(77).submissions.length, 2, "duplicate photo does not add evidence");

  globalThis.axisPhotoRevision = "c";
  globalThis.axisOcrResult = {
    ...globalThis.axisOcrResult,
    rows: rowsFor(names).map((row, index) => index === 0 ? { ...row, kills: 99 } : row),
  };
  const conflict = await POST(request(payload({ authorId: "500000000000000010" })));
  assert.equal(conflict.status, 200);
  const conflictBody = await conflict.json();
  assert.equal(conflictBody.needsReview, true);
  assert.deepEqual(conflictBody.conflictPlayers, ["Player 1"]);
  const conflictRetry = await POST(request(payload({ authorId: "500000000000000010" })));
  assert.equal(conflictRetry.status, 200);
  assert.deepEqual((await conflictRetry.json()).conflictPlayers, ["Player 1"], "duplicate conflict retains its current-photo explanation");
  assert.deepEqual(globalThis.axisStore.readMatchKda(77).get("1"), { kills: 1, deaths: 2, assists: 3 }, "trusted KDA is not overwritten");
  const review = globalThis.axisStore.readAxisMatchReview(77);
  assert.equal(review.submissions.length, 3);
  assert.equal(review.conflicts.length, 1);
});

test("Discord response names current unmatched OCR nicknames", async t => {
  setup(t);
  const names = ["Player 1", "Player 2", "Player 3", "Player 4", "Player 5", "Player 6", "Player 7", "Player 8", "Wrong Nick", "Wrong Nick"];
  // The duplicate wrong nickname is deliberately kept in the OCR input; the
  // public response must deduplicate it and never expose roster IDs.
  globalThis.axisOcrResult = { ...globalThis.axisOcrResult, rows: rowsFor(names) };
  const response = await POST(request(payload({
    authorId: "500000000000000011",
    messageId: "300000000000000003",
    attachmentId: "400000000000000003",
  })));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true, matchNumber: 77, recognizedPlayers: 8, totalPlayers: 10,
    coveragePercent: 80, confidencePercent: 96, needsReview: true,
    missingPlayers: ["Player 9", "Player 10"], unmatchedNames: ["Wrong Nick"], conflictPlayers: [],
  });
});

test("Discord OCR is bound to the archived roster", async t => {
  setup(t);
  globalThis.axisOcrResult = {
    ...globalThis.axisOcrResult,
    rows: rowsFor(["Player 1", "Player 2", "Player 3", "Player 4", "Player 5", "Player 6", "Player 7", "Wrong 8", "Wrong 9", "Wrong 10"]),
  };
  const response = await POST(request(payload({ authorId: "500000000000000007" })));
  assert.equal(response.status, 422);
  assert.equal(globalThis.axisStore.readMatchKda(77).size, 0);
});

test("aggregate Discord admission stays bounded across different authors", async t => {
  setup(t);
  const guildId = "100000000000000099";
  process.env.AXIS_DISCORD_GUILD_ID = guildId;
  for (let index = 0; index < 30; index++) {
    const authorId = String(500000000000000100n + BigInt(index));
    assert.equal((await POST(request(payload({ guildId, authorId })))).status, 200);
  }
  const response = await POST(request(payload({ guildId, authorId: "500000000000000199" })));
  assert.equal(response.status, 429);
});
