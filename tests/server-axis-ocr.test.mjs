import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { recognizeAxisPhoto, recognizeAxisPhotoUpload } from "../lib/server-axis-ocr.ts";

function syntheticScoreboard(width = 1200, height = 420) {
  const crop = { x: 0, y: 0, width, height: Math.ceil(513 * width / 1584) };
  const data = Buffer.alloc(width * height * 4);
  for (let offset = 0; offset < data.length; offset += 4) {
    data[offset] = 16; data[offset + 1] = 18; data[offset + 2] = 22; data[offset + 3] = 255;
  }
  const pixel = (x, y, color = [220, 225, 230]) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    const offset = (y * width + x) * 4;
    data[offset] = color[0]; data[offset + 1] = color[1]; data[offset + 2] = color[2]; data[offset + 3] = 255;
  };
  const scale = crop.width / 1584;
  const ruleY = Math.round(crop.y + 160 * scale);
  for (let x = crop.x; x < crop.x + crop.width; x++) {
    for (let dy = -1; dy <= 1; dy++) pixel(x, ruleY + dy, [136, 138, 140]);
    for (let dy = 0; dy < Math.max(1, Math.round(scale * 2)); dy++) pixel(x, ruleY + Math.round(32 * scale) + dy, [136, 138, 140]);
  }
  const dividerX = Math.round(crop.x + crop.width / 2);
  for (let y = ruleY; y < crop.y + crop.height; y++) for (let dx = -1; dx <= 1; dx++) pixel(dividerX + dx, y, [92, 96, 101]);
  for (let y = ruleY + Math.round(60 * scale); y < crop.y + crop.height - 8; y += Math.max(12, Math.floor(60 * scale))) {
    for (const x of [110, 650, 980, 1484]) for (let dy = 0; dy < 6; dy++) for (let dx = 0; dx < 14; dx++) pixel(Math.round(x * scale), y + dy);
  }
  return sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

async function storedSyntheticPhoto() {
  const data = await syntheticScoreboard();
  const metadata = await sharp(data).metadata();
  return { data, width: metadata.width, height: metadata.height, revision: "a".repeat(64) };
}

test("server OCR initializes the ONNX model and returns a complete typed result", async () => {
  const photo = await storedSyntheticPhoto();
  const result = await recognizeAxisPhoto(photo);
  assert.equal(result.rows.length, 10);
  assert.deepEqual(Object.keys(result.score).sort(), ["left", "right"]);
  assert.deepEqual(Object.keys(result.scoreConfidence).sort(), ["left", "right"]);
  for (const row of result.rows) {
    assert.match(row.id, /^(left|right):[0-4]$/);
    assert.ok(["left", "right"].includes(row.side));
    for (const field of ["kills", "deaths", "assists"]) assert.ok(row[field] === null || Number.isSafeInteger(row[field]));
  }
});

test("server upload pipeline normalizes inside the OCR queue", async () => {
  const encoded = (await syntheticScoreboard()).toString("base64");
  const { photo, result } = await recognizeAxisPhotoUpload(encoded);
  assert.equal(photo.width, 1200);
  assert.equal(photo.height, 420);
  assert.match(photo.revision, /^[a-f0-9]{64}$/);
  assert.equal(result.rows.length, 10);
});

test("parallel submissions are serialized by the server OCR queue", async () => {
  const photo = await storedSyntheticPhoto();
  const [first, second] = await Promise.all([recognizeAxisPhoto(photo), recognizeAxisPhoto(photo)]);
  assert.equal(first.rows.length, 10);
  assert.equal(second.rows.length, 10);
});
