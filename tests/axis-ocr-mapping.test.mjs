import assert from "node:assert/strict";
import test from "node:test";
import { inferAxisOcrLeftTeam } from "../lib/axis-ocr.ts";
import { fillAxisOcrKdaDrafts } from "../lib/axis-ocr-draft.ts";
import { analyzeAxisOcrMappingSafety } from "../lib/axis-ocr-mapping.ts";

const participants = Array.from({ length: 10 }, (_, index) => ({
  discordId: `player-${index}`,
  teamIndex: index < 5 ? 0 : 1,
}));
const rows = [{ id: "left-0", side: "left" }, { id: "right-0", side: "right" }];

test("same-team assignments on both sides block both sides and manual score orientation", () => {
  const assignments = { "left-0": "player-0", "right-0": "player-1" };
  const safety = analyzeAxisOcrMappingSafety(rows, assignments, participants);

  assert.equal(safety.sameTeamBothSides, true);
  assert.deepEqual([...safety.blockedKdaSides], ["left", "right"]);
  assert.equal(safety.manualOrientationAllowed, false);
  assert.equal(inferAxisOcrLeftTeam(rows, safety.safeAssignments, participants), null);
});

test("a single mapped side keeps its player row usable and permits explicit score orientation", () => {
  const assignments = { "left-0": "player-0", "right-0": null };
  const safety = analyzeAxisOcrMappingSafety(rows, assignments, participants);

  assert.equal(safety.sameTeamBothSides, false);
  assert.deepEqual([...safety.blockedKdaSides], []);
  assert.equal(safety.safeAssignments["left-0"], "player-0");
  assert.equal(inferAxisOcrLeftTeam(rows, safety.safeAssignments, participants), null);
  assert.equal(safety.manualOrientationAllowed, true);
  const kda = fillAxisOcrKdaDrafts([
    { discordId: "player-0", kills: "", deaths: "", assists: "" },
  ], [{ discordId: "player-0", kills: 4, deaths: 2, assists: 1 }], {}, {});
  assert.equal(kda.filled, 3);
});

test("duplicate player assignments disable manual orientation and are removed from inference", () => {
  const assignments = { "left-0": "player-0", "right-0": "player-0" };
  const safety = analyzeAxisOcrMappingSafety(rows, assignments, participants);

  assert.deepEqual([...safety.duplicateIds], ["player-0"]);
  assert.equal(safety.safeAssignments["left-0"], null);
  assert.equal(safety.safeAssignments["right-0"], null);
  assert.equal(safety.manualOrientationAllowed, false);
  assert.equal(inferAxisOcrLeftTeam(rows, safety.safeAssignments, participants), null);
});
