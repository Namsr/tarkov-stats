import type { AxisOcrCrop, AxisOcrSide } from "./axis-ocr.ts";

export interface AxisOcrRowRegions {
  side: AxisOcrSide;
  index: number;
  name: AxisOcrCrop;
  kills: AxisOcrCrop;
  deaths: AxisOcrCrop;
  assists: AxisOcrCrop;
}

export interface AxisOcrRegions {
  score: { left: AxisOcrCrop; right: AxisOcrCrop };
  rows: AxisOcrRowRegions[];
}

export type AxisOcrInputKind = "number" | "name";

export interface AxisOcrPreparedTensor {
  data: Float32Array;
  dims: [1, 3, 48, number];
  resizedWidth: number;
  sourceCrop: AxisOcrCrop;
}

export interface AxisOcrRgbaImage {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
}

const MAX_PIXELS = 24_000_000;
const MAX_REGION_OCR_PIXELS = 1_000_000;

function validDimensions(width: number, height: number): boolean {
  return Number.isSafeInteger(width) && Number.isSafeInteger(height)
    && width > 0 && height > 0 && width * height <= MAX_PIXELS;
}

function validCrop(crop: AxisOcrCrop): boolean {
  return Number.isFinite(crop.x) && Number.isFinite(crop.y)
    && Number.isFinite(crop.width) && Number.isFinite(crop.height)
    && crop.x >= 0 && crop.y >= 0 && crop.width > 0 && crop.height > 0;
}

function pixelLuma(data: Uint8Array | Uint8ClampedArray, offset: number): number {
  const alpha = data[offset + 3] / 255;
  return (0.2126 * data[offset] + 0.7152 * data[offset + 1] + 0.0722 * data[offset + 2]) * alpha;
}

function horizontalRule(
  data: Uint8Array | Uint8ClampedArray,
  imageWidth: number,
  imageHeight: number,
  y: number,
  minLuma = 32,
): { x: number; width: number } {
  let longestX = 0, longest = 0, runX = 0, run = 0;
  const row = y * imageWidth * 4;
  for (let x = 0; x < imageWidth; x++) {
    const offset = row + x * 4;
    const r = data[offset], g = data[offset + 1], b = data[offset + 2];
    const luma = pixelLuma(data, offset);
    if (Math.max(r, g, b) - Math.min(r, g, b) < 18 && luma >= minLuma && luma <= 180) {
      if (run === 0) runX = x;
      run++;
      if (run > longest) { longest = run; longestX = runX; }
    } else run = 0;
  }
  return { x: longestX, width: longest };
}

function dividerCoverage(
  data: Uint8Array | Uint8ClampedArray,
  imageWidth: number,
  imageHeight: number,
  x: number,
  y: number,
  scale: number,
): number {
  const end = Math.min(imageHeight - 1, Math.floor(y + 353 * scale));
  const step = Math.max(1, Math.floor(scale));
  let lit = 0, total = 0;
  for (let row = y; row <= end; row += step) {
    for (let dx = -1; dx <= 1; dx++) {
      const sampleX = Math.min(imageWidth - 1, Math.max(0, x + dx));
      const luma = pixelLuma(data, (row * imageWidth + sampleX) * 4);
      total++;
      if (luma >= 42) lit++;
    }
  }
  return total ? lit / total : 0;
}

function centerDividerCoverage(
  data: Uint8Array | Uint8ClampedArray,
  imageWidth: number,
  imageHeight: number,
  expectedX: number,
  y: number,
  scale: number,
): number {
  // The neutral header run can extend a few pixels past the panel's actual
  // right edge. Search only a narrow canonical band around its midpoint so
  // rounding does not move the probe off a thin center seam.
  const radius = Math.max(1, Math.ceil(4 * scale));
  let best = 0;
  for (let offset = -radius; offset <= radius; offset++) {
    best = Math.max(best, dividerCoverage(data, imageWidth, imageHeight, expectedX + offset, y, scale));
  }
  return best;
}

function cropHasImageContent(
  data: Uint8Array | Uint8ClampedArray,
  imageWidth: number,
  imageHeight: number,
  crop: AxisOcrCrop,
): boolean {
  const step = Math.max(1, Math.floor(Math.sqrt((crop.width * crop.height) / 80_000)));
  let bright = 0, dark = 0, total = 0;
  for (let y = crop.y; y < Math.min(imageHeight, crop.y + crop.height); y += step) {
    for (let x = crop.x; x < Math.min(imageWidth, crop.x + crop.width); x += step) {
      const luma = pixelLuma(data, (y * imageWidth + x) * 4);
      total++;
      if (luma > 112) bright++;
      if (luma < 38) dark++;
    }
  }
  return total > 0 && bright / total >= 0.002 && dark / total >= 0.12;
}

/**
 * Finds the table-header rule, then builds a tight crop from its measured
 * 1584px scoreboard layout. Divider continuity separates the table header
 * from other horizontal rules even when the screenshot has arbitrary margins.
 */
export function detectAxisScoreboard(image: AxisOcrRgbaImage): AxisOcrCrop | null {
  const { width, height, data } = image;
  if (!validDimensions(width, height) || data.length !== width * height * 4) return null;

  let best: { x: number; width: number; ruleY: number; score: number } | null = null;
  for (let y = 0; y < height; y++) {
    const rule = horizontalRule(data, width, height, y);
    if (rule.width < width * 0.55) continue;
    const scale = rule.width / 1584;
    if (y + 353 * scale > height + 2) continue;
    const dividerX = Math.round(rule.x + rule.width / 2);
    const divider = centerDividerCoverage(data, width, height, dividerX, y, scale);
    if (divider < 0.22) continue;

    let pairedRuleWidth = 0;
    const expectedBottomRule = y + 32 * scale;
    const tolerance = Math.max(1, Math.ceil(scale));
    for (let offset = -tolerance; offset <= tolerance; offset++) {
      const pairY = Math.round(expectedBottomRule + offset);
      if (pairY >= 0 && pairY < height) {
        pairedRuleWidth = Math.max(pairedRuleWidth, horizontalRule(data, width, height, pairY, 20).width);
      }
    }
    const score = divider + 0.16 * Math.min(1, pairedRuleWidth / rule.width) + 0.08 * rule.width / width;
    if (!best || score > best.score + 0.0001) best = { ...rule, ruleY: y, score };
  }
  if (!best) return null;

  const scale = best.width / 1584;
  const cropTop = Math.max(0, Math.floor(best.ruleY - 160 * scale));
  const cropBottom = Math.min(height, Math.ceil(best.ruleY + 353 * scale));
  const crop = { x: best.x, y: cropTop, width: best.width, height: cropBottom - cropTop };
  return crop.height > 0 && cropHasImageContent(data, width, height, crop) ? crop : null;
}

function scaledRegion(crop: AxisOcrCrop, scale: number, x: number, y: number, width: number, height: number): AxisOcrCrop {
  const cropLeft = Math.floor(crop.x), cropTop = Math.floor(crop.y);
  const cropRight = Math.ceil(crop.x + crop.width), cropBottom = Math.ceil(crop.y + crop.height);
  const left = Math.max(cropLeft, Math.floor(crop.x + x * scale));
  const top = Math.max(cropTop, Math.floor(crop.y + y * scale));
  const right = Math.min(cropRight, Math.ceil(crop.x + (x + width) * scale));
  const bottom = Math.min(cropBottom, Math.ceil(crop.y + (y + height) * scale));
  return { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

/** Returns absolute regions inside a detected scoreboard crop. */
export function axisOcrRegions(crop: AxisOcrCrop): AxisOcrRegions {
  if (!validCrop(crop)) throw new TypeError("Invalid Axis OCR crop");
  const scale = Math.min(crop.width / 1584, crop.height / 513);
  if (!Number.isFinite(scale) || scale <= 0) throw new TypeError("Invalid Axis OCR crop");
  const rows: AxisOcrRowRegions[] = [];
  const rowCenters = [243, 303, 363, 423, 483];
  for (let index = 0; index < 5; index++) {
    const center = rowCenters[index];
    const nameY = center - 22;
    const statsY = center - 18;
    rows.push(
      {
        side: "left", index,
        name: scaledRegion(crop, scale, 104, nameY, 320, 44),
        kills: scaledRegion(crop, scale, 626, statsY, 44, 36),
        deaths: scaledRegion(crop, scale, 676, statsY, 44, 36),
        assists: scaledRegion(crop, scale, 726, statsY, 44, 36),
      },
      {
        side: "right", index,
        name: scaledRegion(crop, scale, 896, nameY, 310, 44),
        kills: scaledRegion(crop, scale, 1426, statsY, 44, 36),
        deaths: scaledRegion(crop, scale, 1476, statsY, 44, 36),
        assists: scaledRegion(crop, scale, 1526, statsY, 44, 36),
      },
    );
  }
  return {
    score: {
      left: scaledRegion(crop, scale, 730, 5, 54, 44),
      right: scaledRegion(crop, scale, 800, 5, 54, 44),
    },
    rows,
  };
}

function integerCrop(crop: AxisOcrCrop, image: AxisOcrRgbaImage): AxisOcrCrop {
  if (!validCrop(crop)) throw new TypeError("Invalid Axis OCR crop");
  const x = Math.floor(crop.x), y = Math.floor(crop.y);
  const right = Math.ceil(crop.x + crop.width), bottom = Math.ceil(crop.y + crop.height);
  if (x < 0 || y < 0 || right > image.width || bottom > image.height) {
    throw new RangeError("Axis OCR crop is outside the image");
  }
  return { x, y, width: right - x, height: bottom - y };
}

function grayAt(data: Uint8Array | Uint8ClampedArray, offset: number): number {
  return Math.round(0.299 * data[offset] + 0.587 * data[offset + 1] + 0.114 * data[offset + 2]);
}

/**
 * Find the generic gray-threshold nickname bounds used in the PaddleOCR
 * benchmark. The returned crop is absolute; when no ink survives, use input.
 */
export function axisOcrTightGrayCrop(image: AxisOcrRgbaImage, region: AxisOcrCrop): { crop: AxisOcrCrop; fallback: boolean } {
  if (!validDimensions(image.width, image.height) || image.data.length !== image.width * image.height * 4) {
    throw new TypeError("Invalid Axis OCR image pixels");
  }
  const crop = integerCrop(region, image);
  const area = crop.width * crop.height;
  if (area > MAX_REGION_OCR_PIXELS) {
    throw new RangeError("Axis OCR name region exceeds the pixel limit");
  }

  const mask = new Uint8Array(area);
  for (let y = 1; y < crop.height - 1; y++) {
    for (let x = 1; x < crop.width - 1; x++) {
      const offset = ((crop.y + y) * image.width + crop.x + x) * 4;
      if (grayAt(image.data, offset) >= 105) mask[y * crop.width + x] = 1;
    }
  }

  const visited = new Uint8Array(area);
  const queue = new Int32Array(area);
  let minX = crop.width, minY = crop.height, maxX = -1, maxY = -1;
  for (let start = 0; start < area; start++) {
    if (!mask[start] || visited[start]) continue;
    let head = 0, tail = 0;
    queue[tail++] = start;
    visited[start] = 1;
    let componentMinX = crop.width, componentMinY = crop.height;
    let componentMaxX = -1, componentMaxY = -1;
    while (head < tail) {
      const current = queue[head++];
      const x = current % crop.width, y = Math.floor(current / crop.width);
      componentMinX = Math.min(componentMinX, x);
      componentMinY = Math.min(componentMinY, y);
      componentMaxX = Math.max(componentMaxX, x);
      componentMaxY = Math.max(componentMaxY, y);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nextX = x + dx, nextY = y + dy;
          if (nextX < 0 || nextX >= crop.width || nextY < 0 || nextY >= crop.height) continue;
          const next = nextY * crop.width + nextX;
          if (!mask[next] || visited[next]) continue;
          visited[next] = 1;
          queue[tail++] = next;
        }
      }
    }
    const componentArea = tail;
    const touchesRightFrame = componentMaxX >= crop.width - 3;
    if (componentArea < 2 || touchesRightFrame) continue;
    minX = Math.min(minX, componentMinX);
    minY = Math.min(minY, componentMinY);
    maxX = Math.max(maxX, componentMaxX);
    maxY = Math.max(maxY, componentMaxY);
  }

  if (maxX < minX || maxY < minY) return { crop, fallback: true };
  const left = Math.max(0, minX - 3), top = Math.max(0, minY - 2);
  const right = Math.min(crop.width, maxX + 1 + 3), bottom = Math.min(crop.height, maxY + 1 + 2);
  return {
    crop: { x: crop.x + left, y: crop.y + top, width: right - left, height: bottom - top },
    fallback: false,
  };
}

function sampleChannel(
  image: AxisOcrRgbaImage,
  crop: AxisOcrCrop,
  sourceX: number,
  sourceY: number,
  channel: number,
): number {
  const x = Math.max(0, Math.min(crop.width - 1, sourceX));
  const y = Math.max(0, Math.min(crop.height - 1, sourceY));
  return image.data[((crop.y + y) * image.width + crop.x + x) * 4 + channel];
}

function bilinearChannel(image: AxisOcrRgbaImage, crop: AxisOcrCrop, resizedWidth: number, x: number, y: number, channel: number): number {
  const sourceX = (x + 0.5) * crop.width / resizedWidth - 0.5;
  const sourceY = (y + 0.5) * crop.height / 48 - 0.5;
  const x0 = Math.floor(sourceX), y0 = Math.floor(sourceY);
  const dx = sourceX - x0, dy = sourceY - y0;
  const top = sampleChannel(image, crop, x0, y0, channel) * (1 - dx)
    + sampleChannel(image, crop, x0 + 1, y0, channel) * dx;
  const bottom = sampleChannel(image, crop, x0, y0 + 1, channel) * (1 - dx)
    + sampleChannel(image, crop, x0 + 1, y0 + 1, channel) * dx;
  return Math.max(0, Math.min(255, Math.round(top * (1 - dy) + bottom * dy)));
}

/** Convert RGBA pixels to Paddle RecResizeImg's fixed NCHW float tensor. */
export function axisOcrPrepareTensor(
  image: AxisOcrRgbaImage,
  region: AxisOcrCrop,
  kind: AxisOcrInputKind,
): AxisOcrPreparedTensor {
  if (!validDimensions(image.width, image.height) || image.data.length !== image.width * image.height * 4) {
    throw new TypeError("Invalid Axis OCR image pixels");
  }
  let sourceCrop = integerCrop(region, image);
  if (kind === "name") sourceCrop = axisOcrTightGrayCrop(image, sourceCrop).crop;
  else if (kind !== "number") throw new TypeError("Invalid Axis OCR input kind");
  const ratio = sourceCrop.width / Math.max(1, sourceCrop.height);
  const tensorWidth = Math.max(1, Math.min(3200, Math.trunc(48 * Math.max(320 / 48, ratio))));
  const resizedWidth = Math.min(tensorWidth, Math.ceil(48 * ratio));
  const data = new Float32Array(3 * 48 * tensorWidth);
  const plane = 48 * tensorWidth;
  for (let y = 0; y < 48; y++) {
    for (let x = 0; x < resizedWidth; x++) {
      const outputOffset = y * tensorWidth + x;
      // Paddle's image decoder uses BGR channel order, then RecResizeImg maps
      // bytes from [0,255] to [-1,1] and pads the right edge with normalized 0.
      data[outputOffset] = (bilinearChannel(image, sourceCrop, resizedWidth, x, y, 2) / 255 - 0.5) / 0.5;
      data[plane + outputOffset] = (bilinearChannel(image, sourceCrop, resizedWidth, x, y, 1) / 255 - 0.5) / 0.5;
      data[2 * plane + outputOffset] = (bilinearChannel(image, sourceCrop, resizedWidth, x, y, 0) / 255 - 0.5) / 0.5;
    }
  }
  return { data, dims: [1, 3, 48, tensorWidth], resizedWidth, sourceCrop };
}

/** Decode one softmax CTC row using Paddle's blank-at-zero character mapping. */
export function axisOcrDecodeCtc(
  probabilities: ArrayLike<number>,
  timesteps: number,
  classes: number,
  dictionary: readonly string[],
): { text: string; confidence: number } {
  if (!Number.isSafeInteger(timesteps) || timesteps < 1
    || !Number.isSafeInteger(classes) || classes !== dictionary.length + 1
    || probabilities.length !== timesteps * classes) {
    throw new TypeError("Invalid Axis OCR CTC output shape");
  }
  const characters: string[] = [];
  const confidences: number[] = [];
  let previous = -1;
  for (let time = 0; time < timesteps; time++) {
    const offset = time * classes;
    let bestIndex = 0, bestProbability = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < classes; index++) {
      const probability = probabilities[offset + index];
      if (!Number.isFinite(probability)) throw new TypeError("Invalid Axis OCR CTC probability");
      if (probability > bestProbability) { bestProbability = probability; bestIndex = index; }
    }
    if (bestIndex !== 0 && bestIndex !== previous) {
      const character = dictionary[bestIndex - 1];
      if (typeof character !== "string") throw new TypeError("Invalid Axis OCR character dictionary");
      characters.push(character);
      confidences.push(Math.max(0, Math.min(1, bestProbability)));
    }
    previous = bestIndex;
  }
  const confidence = confidences.length ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length : 0;
  return { text: characters.join(""), confidence };
}

/** Keep the model score only for a valid counter; it is not a calibrated accuracy probability. */
export function axisOcrReadCounter(reading: { text: string; confidence: number }): { value: number | null; confidence: number | null } {
  const value = parseAxisOcrNumbers(reading.text, 1)?.[0] ?? null;
  const confidence = value !== null && Number.isFinite(reading.confidence)
    && reading.confidence >= 0 && reading.confidence <= 1 ? reading.confidence : null;
  return { value, confidence };
}

/** Parse exactly the requested count of counters; ambiguous or missing digits abstain. */
export function parseAxisOcrNumbers(text: unknown, count: number): number[] | null {
  if (typeof text !== "string" || text.length > 256
    || !Number.isSafeInteger(count) || count < 1 || count > 10) return null;
  const trimmed = text.trim().replace(/^[|,;:\s]+|[|,;:\s]+$/g, "");
  if (!trimmed) return null;
  const tokens = trimmed.split(/[\s|,;:]+/).filter(Boolean);
  if (tokens.length !== count) return null;

  const numbers: number[] = [];
  for (const token of tokens) {
    if (!/^\d{1,4}$/.test(token)) return null;
    const value = Number(token);
    if (!Number.isSafeInteger(value) || value < 0 || value > 9999) return null;
    numbers.push(value);
  }
  return numbers;
}
