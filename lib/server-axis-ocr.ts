import { access, readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import sharp from "sharp";
import * as ort from "onnxruntime-web/wasm";
import { axisOcrDecodeCtc, axisOcrPrepareTensor, axisOcrReadCounter, axisOcrRegions, detectAxisScoreboard } from "./axis-ocr-layout.ts";
import { normalizeAxisPhoto } from "./axis-photo-upload.ts";
import type { AxisOcrResult, AxisOcrRow } from "./axis-ocr.ts";
import type { AxisStoredPhoto } from "./axis-match-photo.ts";

const MAX_QUEUE = 8;
const MAX_PIXELS = 24_000_000;

export class AxisOcrBusyError extends Error {
  constructor() { super("Axis OCR queue is full"); }
}

let dictionaryPromise: Promise<readonly string[]> | null = null;
let sessionPromise: Promise<ort.InferenceSession> | null = null;
const queue: (() => Promise<void>)[] = [];
let running = false;
let pendingJobs = 0;

function assetPath(name: string): string {
  const publicPath = resolve(process.cwd(), "public", "ocr", "paddle-v1", name);
  return publicPath;
}

async function readAsset(name: string): Promise<Uint8Array> {
  try { return await readFile(assetPath(name)); }
  catch (error) {
    // Tests and source checkouts may not have run the asset preparation step.
    if (name !== "model.onnx" && name !== "dictionary.json") throw error;
    return readFile(resolve(process.cwd(), "assets", "axis-ocr", name));
  }
}

async function loadDictionary(): Promise<readonly string[]> {
  if (!dictionaryPromise) {
    dictionaryPromise = readAsset("dictionary.json").then((bytes) => {
      const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
      if (!Array.isArray(value) || value.length < 10 || value.length > 100_000
        || value.some((character) => typeof character !== "string" || !character || character.length > 8)) {
        throw new TypeError("Invalid Axis OCR dictionary");
      }
      return value as readonly string[];
    }).catch((error) => { dictionaryPromise = null; throw error; });
  }
  return dictionaryPromise;
}

async function loadSession(): Promise<ort.InferenceSession> {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const runtimeDirectory = await findRuntimeDirectory();
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.proxy = false;
      ort.env.wasm.wasmPaths = pathToFileURL(runtimeDirectory + sep).href;
      const model = await readAsset("model.onnx");
      const session = await ort.InferenceSession.create(model, {
        executionProviders: ["wasm"], graphOptimizationLevel: "all",
      });
      if (session.inputNames.length !== 1 || session.outputNames.length < 1) {
        await session.release();
        throw new Error("Unsupported Axis OCR model signature");
      }
      return session;
    })().catch((error) => { sessionPromise = null; throw error; });
  }
  return sessionPromise;
}

async function findRuntimeDirectory(): Promise<string> {
  const candidates = [
    resolve(process.cwd(), "public", "ocr", "paddle-v1"),
    resolve(process.cwd(), "node_modules", "onnxruntime-web", "dist"),
  ];
  for (const candidate of candidates) {
    try {
      await Promise.all([
        access(resolve(candidate, "ort-wasm-simd-threaded.wasm")),
        access(resolve(candidate, "ort-wasm-simd-threaded.mjs")),
      ]);
      return candidate;
    } catch { /* Try the next runtime location. */ }
  }
  throw new Error("Axis OCR WASM runtime assets are unavailable");
}


function enqueue<T>(task: () => Promise<T>): Promise<T> {
  if (pendingJobs >= MAX_QUEUE) return Promise.reject(new AxisOcrBusyError());
  pendingJobs++;
  return new Promise<T>((resolve, reject) => {
    queue.push(async () => {
      try { resolve(await task()); }
      catch (error) { reject(error); }
      finally { pendingJobs--; }
    });
    void drain();
  });
}

async function drain(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (queue.length) await queue.shift()!();
  } finally {
    running = false;
    if (queue.length) void drain();
  }
}

function cleanNickname(value: string): string {
  return value.replace(/\s+/g, " ").trim().replace(/^[|,;:]+|[|,;:]+$/g, "");
}

async function recognizeImage(photo: AxisStoredPhoto): Promise<AxisOcrResult> {
  if (!photo || !(photo.data instanceof Uint8Array) || !Number.isSafeInteger(photo.width)
    || !Number.isSafeInteger(photo.height) || photo.width <= 0 || photo.height <= 0
    || photo.width * photo.height > MAX_PIXELS) throw new TypeError("Invalid Axis OCR photo");
  const { data, info } = await sharp(photo.data, { limitInputPixels: MAX_PIXELS, failOn: "error" })
    .rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (!Number.isSafeInteger(info.width) || !Number.isSafeInteger(info.height)
    || info.width <= 0 || info.height <= 0 || info.width * info.height > MAX_PIXELS
    || info.channels !== 4 || data.length !== info.width * info.height * 4) {
    throw new TypeError("Invalid Axis OCR decoded image");
  }
  const image = { width: info.width, height: info.height, data };
  const crop = detectAxisScoreboard(image);
  if (!crop) throw new Error("Could not detect the Axis scoreboard");
  const regions = axisOcrRegions(crop);
  const dictionary = await loadDictionary();
  const session = await loadSession();
  async function read(region: Parameters<typeof axisOcrPrepareTensor>[1], kind: "number" | "name") {
    const prepared = axisOcrPrepareTensor(image, region, kind);
    const outputs = await session.run({ [session.inputNames[0]]: new ort.Tensor("float32", prepared.data, prepared.dims) });
    const output = outputs[session.outputNames[0]];
    if (!output || output.dims.length !== 3 || output.dims[0] !== 1 || !Number.isSafeInteger(output.dims[1])
      || !Number.isSafeInteger(output.dims[2]) || !(output.data instanceof Float32Array)) {
      throw new Error("Invalid Axis OCR model output");
    }
    return axisOcrDecodeCtc(output.data, output.dims[1], output.dims[2], dictionary);
  }
  const left = axisOcrReadCounter(await read(regions.score.left, "number"));
  const right = axisOcrReadCounter(await read(regions.score.right, "number"));
  const rows: AxisOcrRow[] = [];
  for (const region of regions.rows) {
    const kills = axisOcrReadCounter(await read(region.kills, "number"));
    const deaths = axisOcrReadCounter(await read(region.deaths, "number"));
    const assists = axisOcrReadCounter(await read(region.assists, "number"));
    const name = await read(region.name, "name");
    rows.push({ id: `${region.side}:${region.index}`, side: region.side, index: region.index,
      nickname: cleanNickname(name.text), kills: kills.value, deaths: deaths.value, assists: assists.value,
      numberConfidence: { kills: kills.confidence, deaths: deaths.confidence, assists: assists.confidence },
      confidence: name.text ? name.confidence : 0 });
  }
  return { score: { left: left.value, right: right.value },
    scoreConfidence: { left: left.confidence, right: right.confidence }, rows, crop };
}

/** Run trusted OCR on normalized server-side image bytes, serializing model work. */
export function recognizeAxisPhoto(photo: AxisStoredPhoto): Promise<AxisOcrResult> {
  return enqueue(() => recognizeImage(photo));
}

/**
 * Normalize an upload and run trusted OCR in the same bounded queue.
 *
 * Keeping decode inside the queue is important: sharp can allocate a large raw
 * pixel buffer before the OCR queue sees the request.  Upload routes should use
 * this entry point instead of normalizing first and then calling
 * recognizeAxisPhoto, so concurrent uploads cannot fan out image decoding.
 */
export function recognizeAxisPhotoUpload(value: unknown): Promise<{ photo: AxisStoredPhoto; result: AxisOcrResult }> {
  return enqueue(async () => {
    const photo = await normalizeAxisPhoto(value);
    return { photo, result: await recognizeImage(photo) };
  });
}
