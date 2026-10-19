import assert from "node:assert/strict";
import test from "node:test";
import { inferAxisOcrLeftTeam, matchAxisOcrRows, parseAxisOcrCounter } from "../lib/axis-ocr.ts";

function participants() {
  return Array.from({ length: 10 }, (_, index) => ({
    discordId: `discord-${index}`,
    teamIndex: index < 5 ? 0 : 1,
    historyName: `Player ${index}`,
    arenaNickname: null,
  }));
}

test("OCR aliases use NFC, trim, and case normalization while preserving punctuation and scripts", () => {
  const roster = participants();
  roster[0].historyName = " Café! ";
  roster[1].historyName = "a-b";
  roster[2].historyName = "Kappa";
  roster[3].historyName = "Кappa"; // The first character is Cyrillic.
  roster[4].historyName = "Two  Spaces";
  roster[5].arenaNickname = "Arena.Name";

  assert.deepEqual(matchAxisOcrRows([
    { id: "nfc", nickname: "cafe\u0301!" },
    { id: "punctuation", nickname: "ab" },
    { id: "script", nickname: "kappa" },
    { id: "cyrillic", nickname: "кappa" },
    { id: "spaces", nickname: "Two Spaces" },
    { id: "arena", nickname: "  ARENA.NAME " },
  ], roster), {
    nfc: "discord-0",
    punctuation: null,
    script: "discord-2",
    cyrillic: "discord-3",
    spaces: null,
    arena: "discord-5",
  });
});

test("duplicate aliases across rows or participants abstain globally", () => {
  const roster = participants();
  roster[0].historyName = "Shared";
  roster[1].arenaNickname = "shared";
  roster[2].historyName = "Unique";
  const assignments = matchAxisOcrRows([
    { id: "a", nickname: "SHARED" },
    { id: "b", nickname: " unique " },
    { id: "c", nickname: "Unique" },
  ], roster);
  assert.deepEqual(assignments, { a: null, b: null, c: null });

  const oneRowPerName = matchAxisOcrRows([
    { id: "shared", nickname: "shared" },
  ], roster);
  assert.deepEqual(oneRowPerName, { shared: null });
});

test("duplicate OCR row IDs cannot overwrite a prior assignment", () => {
  const roster = participants();
  const assignments = matchAxisOcrRows([
    { id: "same-id", nickname: "Player 0" },
    { id: "same-id", nickname: "Player 1" },
  ], roster);
  assert.deepEqual(assignments, { "same-id": null });
});

test("different aliases for the same participant cannot assign that player to multiple rows", () => {
  const roster = participants();
  roster[0].arenaNickname = "Arena Alias";
  assert.deepEqual(matchAxisOcrRows([
    { id: "history", nickname: "Player 0" },
    { id: "arena", nickname: "Arena Alias" },
  ], roster), { history: null, arena: null });
});

test("side inference uses both sides or two unique matches on one side", () => {
  const roster = participants();
  assert.equal(inferAxisOcrLeftTeam([
    { id: "l", side: "left" }, { id: "r", side: "right" },
  ], { l: "discord-1", r: "discord-7" }, roster), 0);
  assert.equal(inferAxisOcrLeftTeam([
    { id: "a", side: "left" }, { id: "b", side: "left" }, { id: "unmatched", side: "right" },
  ], { a: "discord-6", b: "discord-8" }, roster), 1);
  assert.equal(inferAxisOcrLeftTeam([
    { id: "a", side: "right" }, { id: "b", side: "right" },
  ], { a: "discord-0", b: "discord-3" }, roster), 1);
  assert.equal(inferAxisOcrLeftTeam([{ id: "only", side: "left" }], { only: "discord-0" }, roster), null);
});

test("side inference abstains for mixed or contradictory sides and non-2x5 rosters", () => {
  const roster = participants();
  assert.equal(inferAxisOcrLeftTeam([
    { id: "a", side: "left" }, { id: "b", side: "left" },
  ], { a: "discord-0", b: "discord-5" }, roster), null);
  assert.equal(inferAxisOcrLeftTeam([
    { id: "a", side: "left" }, { id: "b", side: "right" },
  ], { a: "discord-0", b: "discord-2" }, roster), null);
  assert.equal(inferAxisOcrLeftTeam([
    { id: "a", side: "left" }, { id: "b", side: "left" },
  ], { a: "discord-0", b: "discord-0" }, roster), null, "a participant cannot support two OCR rows");
  assert.equal(inferAxisOcrLeftTeam([
    { id: "left", side: "left" }, { id: "right", side: "right" },
  ], { left: "discord-0", right: "discord-0" }, roster), null, "a participant cannot occur on both sides");
  assert.equal(inferAxisOcrLeftTeam([], {}, roster.slice(0, 9)), null);
  assert.equal(inferAxisOcrLeftTeam([], {}, [...roster.slice(0, 9), { ...roster[9], teamIndex: 0 }]), null);
  assert.equal(inferAxisOcrLeftTeam([], {}, [...roster.slice(0, 9), { ...roster[9], discordId: "discord-0" }]), null);
});

test("OCR counters accept only integer values within the AXIS KDA limit", () => {
  assert.equal(parseAxisOcrCounter(0), 0);
  assert.equal(parseAxisOcrCounter(" 42 "), 42);
  assert.equal(parseAxisOcrCounter(9999), 9999);
  for (const input of [null, "", "-1", -1, 10000, "10000", 1.5, "1.5", "3 kills", Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(parseAxisOcrCounter(input), null, String(input));
  }
});
