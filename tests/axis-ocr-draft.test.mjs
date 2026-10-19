import assert from "node:assert/strict";
import test from "node:test";
import { fillAxisOcrKdaDrafts, fillAxisOcrRoundDraft } from "../lib/axis-ocr-draft.ts";

const draft = (overrides = {}) => [{ discordId: "100", expected: null, kills: "", deaths: "", assists: "", ...overrides }];
const candidate = (overrides = {}) => [{ discordId: "100", kills: 5, deaths: 2, assists: 1, ...overrides }];

test("fills a complete KDA group without replacing existing values", () => {
  const result = fillAxisOcrKdaDrafts(draft({ kills: "8" }), candidate(), {}, {});
  assert.deepEqual(result.drafts[0], { discordId: "100", expected: null, kills: "8", deaths: "2", assists: "1" });
  assert.equal(result.filled, 2);
});

test("does not transfer partial or invalid OCR KDA values", () => {
  const partial = fillAxisOcrKdaDrafts(draft(), candidate({ assists: null }), {}, {});
  assert.equal(partial.filled, 0);
  assert.equal(partial.drafts[0].kills, "");
  const invalid = fillAxisOcrKdaDrafts(draft(), candidate({ deaths: -1 }), {}, {});
  assert.equal(invalid.filled, 0);
  assert.equal(invalid.drafts[0].kills, "");
});

test("a field typed and cleared before OCR stays protected", () => {
  const result = fillAxisOcrKdaDrafts(draft(), candidate(), { "kda:100:kills": 1 }, { "kda:100:kills": 1 });
  assert.equal(result.filled, 0);
  assert.deepEqual(result.drafts, draft());
});

test("a field typed and cleared during OCR stays protected", () => {
  const result = fillAxisOcrKdaDrafts(draft(), candidate(), {}, { "kda:100:kills": 1 });
  assert.equal(result.filled, 0);
  assert.deepEqual(result.drafts, draft());
});

test("a valid OCR round pair fills only untouched empty fields", () => {
  const result = fillAxisOcrRoundDraft({ a: "3", b: "", expected: { a: 3, b: 4 } }, { a: 1, b: 2 }, {}, {});
  assert.deepEqual(result.draft, { a: "3", b: "2", expected: { a: 3, b: 4 } });
  assert.equal(result.filled, 1);
});

test("partial round OCR and a cleared manual field do not transfer", () => {
  const partial = fillAxisOcrRoundDraft({ a: "", b: "", expected: null }, { a: 1, b: null }, {}, {});
  assert.equal(partial.filled, 0);
  const cleared = fillAxisOcrRoundDraft({ a: "", b: "", expected: null }, { a: 1, b: 2 }, {}, { "rounds:a": 1 });
  assert.equal(cleared.filled, 0);
  assert.equal(cleared.draft.a, "");
});
