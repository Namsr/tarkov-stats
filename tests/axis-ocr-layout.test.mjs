import assert from "node:assert/strict";
import test from "node:test";
import { decodeAxisOcrDataUrl, isAxisOcrDataRasterUrl } from "../lib/client-axis-ocr.ts";
import {
  axisOcrDecodeCtc,
  axisOcrPrepareTensor,
  axisOcrRegions,
  axisOcrTightGrayCrop,
  detectAxisScoreboard,
  parseAxisOcrNumbers,
} from "../lib/axis-ocr-layout.ts";

function rgbaImage(width, height) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < width * height; index++) {
    const offset = index * 4;
    data[offset] = 16;
    data[offset + 1] = 18;
    data[offset + 2] = 22;
    data[offset + 3] = 255;
  }
  return data;
}

function setPixel(data, width, x, y, color = [220, 225, 230]) {
  const offset = (y * width + x) * 4;
  data[offset] = color[0];
  data[offset + 1] = color[1];
  data[offset + 2] = color[2];
  data[offset + 3] = 255;
}

function drawSyntheticScoreboard(width, height, crop, dividerOffset = 0) {
  const data = rgbaImage(width, height);
  const scale = crop.width / 1584;
  const ruleY = Math.round(crop.y + 160 * scale);
  const x0 = Math.round(crop.x), x1 = Math.min(width, Math.ceil(crop.x + crop.width));
  for (let x = x0; x < x1; x++) {
    for (let dy = -1; dy <= 1; dy++) setPixel(data, width, x, ruleY + dy, [136, 138, 140]);
    for (let dy = 0; dy < Math.max(1, Math.round(scale * 2)); dy++) {
      setPixel(data, width, x, Math.round(ruleY + 32 * scale) + dy, [136, 138, 140]);
    }
  }
  const dividerX = Math.round(crop.x + crop.width / 2) + dividerOffset;
  for (let y = ruleY; y < crop.y + crop.height; y++) {
    for (let dx = -1; dx <= 1; dx++) setPixel(data, width, dividerX + dx, y, [92, 96, 101]);
  }
  for (let y = ruleY + Math.round(60 * scale); y < crop.y + crop.height - 8; y += Math.max(12, Math.floor(60 * scale))) {
    for (const x of [crop.x + Math.round(110 * scale), crop.x + Math.round(650 * scale), crop.x + Math.round(980 * scale), crop.x + crop.width - Math.round(100 * scale)]) {
      for (let dy = 0; dy < 6; dy++) {
        for (let dx = 0; dx < 14; dx++) setPixel(data, width, x + dx, y + dy);
      }
    }
  }
  return { width, height, data };
}

test("detects a cropped scoreboard and rejects blank or malformed pixels", () => {
  const crop = { x: 0, y: 0, width: 1200, height: Math.ceil(513 * 1200 / 1584) };
  const detected = detectAxisScoreboard(drawSyntheticScoreboard(1200, 420, crop));
  assert.ok(detected && Math.abs(detected.height - crop.height) <= 1);
  assert.deepEqual({ ...detected, height: crop.height }, crop);
  assert.equal(detectAxisScoreboard({ width: 1200, height: 420, data: rgbaImage(1200, 420) }), null);
  assert.equal(detectAxisScoreboard({ width: 1200, height: 420, data: new Uint8Array(20) }), null);
  assert.equal(detectAxisScoreboard({ width: 6000, height: 5000, data: new Uint8Array(0) }), null);
});

test("detects the centered panel in a 16:9 screenshot", () => {
  const width = 1600, height = 900;
  const expected = { x: 128, y: 153, width: 1344, height: Math.ceil(513 * 1344 / 1584) };
  const detected = detectAxisScoreboard(drawSyntheticScoreboard(width, height, expected));
  assert.ok(detected && Math.abs(detected.y - expected.y) <= 1);
  assert.deepEqual({ ...detected, y: expected.y }, expected);
});

test("finds a thin center seam just off the neutral header midpoint and rejects a remote line", () => {
  const crop = { x: 0, y: 4, width: 1164, height: Math.ceil(513 * 1164 / 1584) };
  const nearSeam = detectAxisScoreboard(drawSyntheticScoreboard(1164, 386, crop, -3));
  assert.ok(nearSeam, "a three-pixel centerline offset should remain inside the narrow search band");
  assert.ok(Math.abs(nearSeam.y - crop.y) <= 1);
  assert.ok(Math.abs(nearSeam.width - crop.width) <= 1);

  const unrelatedLine = detectAxisScoreboard(drawSyntheticScoreboard(1164, 386, crop, -20));
  assert.equal(unrelatedLine, null, "a vertical line outside the center search band is not a scoreboard divider");
});

test("builds two score cells and exact KDA/name regions for each scoreboard row", () => {
  const crop = { x: 40, y: 30, width: 1584, height: 513 };
  const regions = axisOcrRegions(crop);
  assert.deepEqual(regions.score, {
    left: { x: 770, y: 35, width: 54, height: 44 },
    right: { x: 840, y: 35, width: 54, height: 44 },
  });
  assert.equal(regions.rows.length, 10);
  assert.deepEqual(regions.rows.map(({ side, index }) => `${side}-${index}`), [
    "left-0", "right-0", "left-1", "right-1", "left-2", "right-2", "left-3", "right-3", "left-4", "right-4",
  ]);
  assert.deepEqual(
    [regions.rows[0].kills, regions.rows[0].deaths, regions.rows[0].assists],
    [
      { x: 666, y: 255, width: 44, height: 36 },
      { x: 716, y: 255, width: 44, height: 36 },
      { x: 766, y: 255, width: 44, height: 36 },
    ],
  );
  assert.deepEqual(regions.rows[1].kills, { x: 1466, y: 255, width: 44, height: 36 });
  for (const { name, kills, deaths, assists } of regions.rows) {
    for (const box of [name, kills, deaths, assists]) {
      assert.ok(box.x >= crop.x && box.y >= crop.y);
      assert.ok(box.x + box.width <= crop.x + crop.width);
      assert.ok(box.y + box.height <= crop.y + crop.height);
    }
  }
  assert.ok(regions.rows[0].assists.x + regions.rows[0].assists.width < regions.rows[1].kills.x);
  assert.ok(regions.rows[0].name.x - crop.x >= 100, "nickname region should exclude avatar/status icons");
});

test("counter parser requires exact, unambiguous decimal tokens and preserves zero", () => {
  assert.deepEqual(parseAxisOcrNumbers(" 11 | 4 ", 2), [11, 4]);
  assert.deepEqual(parseAxisOcrNumbers("0 12 7", 3), [0, 12, 7]);
  for (const [text, count] of [["4", 2], ["4 7 1", 2], ["4 O 1", 3], ["4.7 1", 2], ["10000 1", 2], ["", 1], ["4 2", 0]]) {
    assert.equal(parseAxisOcrNumbers(text, count), null, `${JSON.stringify(text)} x ${count}`);
  }
});

test("prepares Paddle BGR NCHW tensors with aspect-preserving dynamic width and zero padding", () => {
  const data = new Uint8ClampedArray([
    255, 0, 0, 255,
    0, 0, 255, 255,
  ]);
  const prepared = axisOcrPrepareTensor({ width: 2, height: 1, data }, { x: 0, y: 0, width: 2, height: 1 }, "number");
  assert.deepEqual(prepared.dims, [1, 3, 48, 320]);
  assert.equal(prepared.resizedWidth, 96);
  assert.equal(prepared.data.length, 3 * 48 * 320);
  const plane = 48 * 320;
  assert.equal(prepared.data[0], -1, "first BGR plane contains blue=0 for the red source pixel");
  assert.equal(prepared.data[2 * plane], 1, "third BGR plane contains red=255 for the red source pixel");
  assert.equal(prepared.data[48 * 320 + 96], 0, "unfilled right padding remains normalized zero");
  assert.ok(Math.abs(prepared.data[0] + 1) < 1e-6);
  assert.throws(() => axisOcrPrepareTensor({ width: 2, height: 1, data }, { x: 0, y: 0, width: 3, height: 1 }, "number"), /outside the image/);

  const wide = new Uint8ClampedArray(100 * 20 * 4).fill(255);
  const wideTensor = axisOcrPrepareTensor({ width: 100, height: 20, data: wide }, { x: 0, y: 0, width: 100, height: 20 }, "name");
  assert.deepEqual(wideTensor.dims, [1, 3, 48, 320]);
  assert.equal(wideTensor.resizedWidth, 240);

  const wider = new Uint8ClampedArray(300 * 40 * 4).fill(255);
  const widerTensor = axisOcrPrepareTensor({ width: 300, height: 40, data: wider }, { x: 0, y: 0, width: 300, height: 40 }, "name");
  assert.deepEqual(widerTensor.dims, [1, 3, 48, 360]);
  assert.equal(widerTensor.resizedWidth, 360);
  assert.equal(widerTensor.data.length, 3 * 48 * 360);
});

test("gray-tight nickname bounds ignore frame pixels, isolated fragments, and right-edge artifacts", () => {
  const width = 24, height = 18;
  const data = rgbaImage(width, height);
  const paint = (x, y) => setPixel(data, width, x, y, [210, 210, 210]);
  paint(8, 7); paint(9, 7); paint(10, 8); paint(11, 8);
  paint(5, 4); // isolated bright speck is below the component-area threshold.
  paint(width - 2, 6); paint(width - 3, 6); // border component is excluded as a whole.
  paint(12, 0); paint(12, height - 1); // crop frame is ignored.
  const result = axisOcrTightGrayCrop({ width, height, data }, { x: 0, y: 0, width, height });
  assert.equal(result.fallback, false);
  assert.deepEqual(result.crop, { x: 5, y: 5, width: 10, height: 6 });
  const empty = axisOcrTightGrayCrop({ width, height, data: rgbaImage(width, height) }, { x: 0, y: 0, width, height });
  assert.equal(empty.fallback, true);
  assert.deepEqual(empty.crop, { x: 0, y: 0, width, height });
});

test("decodes Paddle CTC blank and repeats without guessing text", () => {
  const classes = 4;
  const ids = [1, 1, 0, 1, 2, 0];
  const values = new Float32Array(ids.length * classes);
  ids.forEach((id, time) => {
    values.fill(0.01, time * classes, (time + 1) * classes);
    values[time * classes + id] = [0.9, 0.8, 0.9, 0.7, 0.8, 0.9][time];
  });
  const decoded = axisOcrDecodeCtc(values, ids.length, classes, ["A", "B", " "]);
  assert.equal(decoded.text, "AAB");
  assert.ok(Math.abs(decoded.confidence - 0.8) < 1e-6);
  const blank = new Float32Array([0.99, 0.01, 0.01, 0.01]);
  assert.deepEqual(axisOcrDecodeCtc(blank, 1, classes, ["A", "B", " "]), { text: "", confidence: 0 });
  assert.throws(() => axisOcrDecodeCtc(values, ids.length, classes, ["A", "B"]), /output shape/);
});

test("layout helpers reject invalid crop geometry", () => {
  for (const crop of [
    { x: -1, y: 0, width: 100, height: 100 },
    { x: 0, y: 0, width: 0, height: 100 },
    { x: 0, y: Number.NaN, width: 100, height: 100 },
  ]) assert.throws(() => axisOcrRegions(crop), /Invalid Axis OCR crop/);
});

test("accepts bounded base64 raster data URLs used by local paste input", () => {
  assert.equal(isAxisOcrDataRasterUrl("data:image/png;base64,iVBORw0KGgo="), true);
  assert.equal(isAxisOcrDataRasterUrl("data:image/jpeg;base64,/9j/"), true);
  assert.equal(isAxisOcrDataRasterUrl("data:image/webp;base64,UklGRgAAAABXRUJQ"), true);
  assert.equal(isAxisOcrDataRasterUrl("data:image/svg+xml;base64,PHN2Zz4="), false);
  assert.equal(isAxisOcrDataRasterUrl("data:image/gif;base64,R0lGODlh"), false);
  assert.equal(isAxisOcrDataRasterUrl("data:image/png,%89PNG"), false);
  assert.equal(isAxisOcrDataRasterUrl("data:image/png;base64,"), false);
  assert.equal(decodeAxisOcrDataUrl("data:image/png;base64,iVBORw0KGgo=").type, "image/png");
  assert.equal(decodeAxisOcrDataUrl("data:image/jpeg;base64,/9j/").size, 3);
  assert.throws(() => decodeAxisOcrDataUrl("data:image/png;base64,AA=="), /does not match/);
});
