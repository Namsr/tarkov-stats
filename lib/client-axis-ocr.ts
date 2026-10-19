import type { AxisOcrCrop, AxisOcrImage, AxisOcrResult, AxisOcrRow } from "./axis-ocr.ts";
import { axisOcrPrepareTensor, axisOcrRegions, detectAxisScoreboard, parseAxisOcrNumbers } from "./axis-ocr-layout.ts";
import { createAxisOcrWorker, type AxisOcrWorkerHandle } from "./axis-ocr-worker.ts";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_DATA_URL_CHARS = Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 128;
const MAX_IMAGE_PIXELS = 24_000_000;
const IMAGE_FETCH_TIMEOUT_MS = 15_000;
const ALLOWED_IMAGE_TYPES = new Set([
  "image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif", "image/bmp", "image/avif", "image/tiff",
]);

type ProgressRange = { start: number; end: number };

interface AxisOcrJob {
  image: AxisOcrImage;
  options: { signal: AbortSignal; onProgress?: (n: number) => void; crop?: AxisOcrCrop };
  resolve: (result: AxisOcrResult) => void;
  reject: (reason: unknown) => void;
  done: AbortController;
  abortListener: () => void;
  cleanup: Set<() => void>;
  progress: number;
  progressRange: ProgressRange;
  state: "queued" | "active" | "settled";
  settled: boolean;
  failure?: unknown;
  workerGeneration?: number;
}

interface WorkerRecord { worker: AxisOcrWorkerHandle; generation: number }
interface WorkerInitialization { generation: number; promise: Promise<WorkerRecord> }

const queue: AxisOcrJob[] = [];
let activeJob: AxisOcrJob | null = null;
let draining = false;
let workerEpoch = 0;
let workerRecord: WorkerRecord | null = null;
let workerInitialization: WorkerInitialization | null = null;

function asError(value: unknown, fallback = "Axis OCR was cancelled"): unknown {
  return value ?? new DOMException(fallback, "AbortError");
}

function reportProgress(job: AxisOcrJob, value: number): void {
  if (job.settled || !job.options.onProgress) return;
  const progress = Math.max(job.progress, Math.max(0, Math.min(1, value)));
  job.progress = progress;
  try { job.options.onProgress(progress); } catch { /* A UI callback must not break OCR. */ }
}

function disposeJob(job: AxisOcrJob): void {
  job.options.signal.removeEventListener("abort", job.abortListener);
  for (const cleanup of [...job.cleanup]) {
    try { cleanup(); } catch { /* Release other resources even if one cleanup fails. */ }
  }
  job.cleanup.clear();
}

function finishRejected(job: AxisOcrJob, reason: unknown): void {
  if (job.settled) return;
  job.settled = true;
  job.state = "settled";
  job.failure = asError(reason);
  if (!job.done.signal.aborted) job.done.abort(job.failure);
  disposeJob(job);
  job.reject(job.failure);
}

function finishResolved(job: AxisOcrJob, result: AxisOcrResult): void {
  if (job.settled) return;
  reportProgress(job, 1);
  job.settled = true;
  job.state = "settled";
  disposeJob(job);
  job.resolve(result);
}

function terminateWorker(worker: AxisOcrWorkerHandle | null): void {
  if (!worker) return;
  try { void worker.terminate().catch(() => {}); } catch { /* The worker may already be gone. */ }
}

function invalidateWorker(generation: number): void {
  if (generation !== workerEpoch) return;
  const previous = workerRecord?.generation === generation ? workerRecord.worker : null;
  workerRecord = null;
  if (workerInitialization?.generation === generation) workerInitialization = null;
  workerEpoch++;
  terminateWorker(previous);
}

function failWorker(generation: number, error: unknown): void {
  if (generation !== workerEpoch) return;
  invalidateWorker(generation);
  if (activeJob?.workerGeneration === generation) finishRejected(activeJob, error);
}

function cancelJob(job: AxisOcrJob, reason: unknown): void {
  if (job.settled) return;
  if (job.state === "queued") {
    const index = queue.indexOf(job);
    if (index >= 0) queue.splice(index, 1);
  } else if (activeJob === job && job.workerGeneration != null) {
    invalidateWorker(job.workerGeneration);
  }
  finishRejected(job, reason);
}

function assertJobActive(job: AxisOcrJob): void {
  if (job.options.signal.aborted) throw asError(job.options.signal.reason);
  if (job.settled) throw asError(job.failure);
}

function awaitAbortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(asError(signal.reason));
  return new Promise((resolve, reject) => {
    let finished = false;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      if (finished) return;
      finished = true;
      cleanup();
      reject(asError(signal.reason));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then((value) => {
      if (finished) return;
      finished = true;
      cleanup();
      resolve(value);
    }, (error) => {
      if (finished) return;
      finished = true;
      cleanup();
      reject(error);
    });
  });
}

function startWorker(job: AxisOcrJob, generation: number): Promise<WorkerRecord> {
  assertJobActive(job);
  if (workerEpoch !== generation) throw new DOMException("OCR worker initialization was cancelled", "AbortError");
  const worker = createAxisOcrWorker({
    onError: (error) => failWorker(generation, error),
  });
  const record = { worker, generation };
  // Keep the native worker reachable while the load/model handshake is pending.
  workerRecord = record;
  return worker.ready.then(() => {
    if (workerEpoch !== generation || job.settled || job.options.signal.aborted) {
      terminateWorker(worker);
      throw asError(job.options.signal.reason, "OCR worker initialization was cancelled");
    }
    return record;
  }).catch((error: unknown) => {
    if (workerEpoch === generation) failWorker(generation, error);
    throw error;
  });
}

async function getWorker(job: AxisOcrJob): Promise<WorkerRecord> {
  assertJobActive(job);
  if (job.workerGeneration == null) job.workerGeneration = workerEpoch;
  const generation = job.workerGeneration;
  if (workerRecord?.generation === generation) {
    await awaitAbortable(workerRecord.worker.ready, job.done.signal);
    assertJobActive(job);
    return workerRecord;
  }

  let initialization = workerInitialization;
  if (!initialization || initialization.generation !== generation) {
    const promise = startWorker(job, generation);
    initialization = { generation, promise };
    workerInitialization = initialization;
    void promise.finally(() => {
      if (workerInitialization === initialization) workerInitialization = null;
    }).catch(() => {});
  }
  return awaitAbortable(initialization.promise, job.done.signal);
}

function registerCleanup(job: AxisOcrJob, cleanup: () => void): () => void {
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    job.cleanup.delete(release);
    cleanup();
  };
  job.cleanup.add(release);
  return release;
}

function normalizeCrop(crop: AxisOcrCrop, width: number, height: number): AxisOcrCrop {
  if (![crop.x, crop.y, crop.width, crop.height].every(Number.isFinite)
    || crop.x < 0 || crop.y < 0 || crop.width <= 0 || crop.height <= 0) throw new TypeError("Invalid Axis OCR crop");
  const x = Math.floor(crop.x), y = Math.floor(crop.y);
  const right = Math.ceil(crop.x + crop.width), bottom = Math.ceil(crop.y + crop.height);
  if (x >= width || y >= height || right > width || bottom > height) throw new RangeError("Axis OCR crop is outside the image");
  return { x, y, width: right - x, height: bottom - y };
}

function sourceUrl(src: string): string | URL {
  if (typeof window === "undefined" || typeof document === "undefined") throw new Error("Axis OCR is available in the browser only");
  if (src.startsWith("data:")) {
    if (!isAxisOcrDataRasterUrl(src)) throw new TypeError("Only bounded base64 raster images can be recognized");
    return src;
  }
  const url = new URL(src, window.location.href);
  if (url.origin !== window.location.origin || !["http:", "https:", "blob:"].includes(url.protocol)) {
    throw new TypeError("Only same-origin raster images can be recognized");
  }
  return url;
}

/** Accept only bounded data URLs produced by a local raster image, such as a paste. */
export function isAxisOcrDataRasterUrl(src: string): boolean {
  if (typeof src !== "string" || src.length > MAX_DATA_URL_CHARS) return false;
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/i.exec(src);
  if (!match) return false;
  const payload = match[2];
  if (payload.length % 4 !== 0) return false;
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  const byteLength = payload.length / 4 * 3 - padding;
  return byteLength > 0 && byteLength <= MAX_IMAGE_BYTES;
}

/** Decode an allowed paste URL locally, avoiding fetch() and connect-src CSP checks. */
export function decodeAxisOcrDataUrl(src: string): Blob {
  if (!isAxisOcrDataRasterUrl(src)) throw new TypeError("Only bounded PNG, JPEG, or WebP data URLs can be recognized");
  const [, mimeType, payload] = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/i.exec(src)!;
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);

  const isPng = bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
  const isJpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const isWebp = bytes.length >= 12
    && String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF"
    && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP";
  const normalizedType = mimeType.toLowerCase();
  if (!(normalizedType === "image/png" && isPng)
    && !(normalizedType === "image/jpeg" && isJpeg)
    && !(normalizedType === "image/webp" && isWebp)) {
    throw new TypeError("Pasted screenshot data does not match its raster format");
  }
  return new Blob([bytes.buffer as ArrayBuffer], { type: normalizedType });
}

async function hasRasterSignature(blob: Blob): Promise<boolean> {
  const bytes = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
  const ascii = (offset: number, length: number) => String.fromCharCode(...bytes.subarray(offset, offset + length));
  return (bytes[0] === 0x89 && ascii(1, 3) === "PNG")
    || (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    || ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP"
    || ascii(0, 4) === "GIF8"
    || ascii(0, 2) === "BM"
    || ascii(4, 4) === "ftyp" && ["avif", "avis"].includes(ascii(8, 4))
    || ["II*\0", "MM\0*"].includes(ascii(0, 4));
}

async function fetchRaster(job: AxisOcrJob): Promise<Blob> {
  if (job.image.src.startsWith("data:")) {
    sourceUrl(job.image.src);
    assertJobActive(job);
    return decodeAxisOcrDataUrl(job.image.src);
  }
  const url = sourceUrl(job.image.src);
  assertJobActive(job);
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new DOMException("Image loading timed out", "TimeoutError")), IMAGE_FETCH_TIMEOUT_MS);
  try {
    const signal = AbortSignal.any([job.options.signal, job.done.signal, timeout.signal]);
    const response = await fetch(url, { cache: "no-store", credentials: "same-origin", redirect: "error", signal });
    assertJobActive(job);
    if (!response.ok) throw new Error(`Could not load screenshot (${response.status})`);
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_BYTES) throw new RangeError("Screenshot exceeds the 10 MB OCR limit");
    const blob = await response.blob();
    assertJobActive(job);
    if (blob.size <= 0 || blob.size > MAX_IMAGE_BYTES) throw new RangeError("Screenshot must be between 1 byte and 10 MB");
    const type = (response.headers.get("content-type") || blob.type).split(";", 1)[0].trim().toLowerCase();
    if (type === "image/svg+xml" || (!ALLOWED_IMAGE_TYPES.has(type) && !(await hasRasterSignature(blob)))) {
      throw new TypeError("Screenshot must be a raster image");
    }
    return blob;
  } finally {
    clearTimeout(timer);
  }
}

function loadBitmap(blob: Blob, job: AxisOcrJob): Promise<ImageBitmap> {
  if (typeof createImageBitmap !== "function") throw new Error("This browser cannot decode screenshot images");
  return createImageBitmap(blob).then((bitmap) => {
    if (job.settled || job.options.signal.aborted) {
      bitmap.close();
      assertJobActive(job);
    }
    registerCleanup(job, () => bitmap.close());
    return bitmap;
  });
}

function detectCrop(bitmap: ImageBitmap, job: AxisOcrJob): AxisOcrCrop {
  if (job.options.crop) return normalizeCrop(job.options.crop, bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const release = registerCleanup(job, () => { canvas.width = 0; canvas.height = 0; });
  try {
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Could not prepare screenshot pixels");
    context.drawImage(bitmap, 0, 0);
    const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height);
    const detected = detectAxisScoreboard({ width: bitmap.width, height: bitmap.height, data: pixels.data });
    if (!detected) throw new Error("Could not detect the scoreboard; enter a manual crop");
    return normalizeCrop(detected, bitmap.width, bitmap.height);
  } finally {
    release();
  }
}

function readRegionPixels(bitmap: ImageBitmap, crop: AxisOcrCrop): { width: number; height: number; data: Uint8ClampedArray } {
  const canvas = document.createElement("canvas");
  canvas.width = crop.width;
  canvas.height = crop.height;
  try {
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Could not prepare OCR pixels");
    context.drawImage(bitmap, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
    const image = context.getImageData(0, 0, crop.width, crop.height);
    return { width: image.width, height: image.height, data: image.data };
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

function cleanedNickname(value: string): string {
  return value.replace(/\s+/g, " ").trim().replace(/^[|,;:]+|[|,;:]+$/g, "");
}

async function recognizeText(
  worker: AxisOcrWorkerHandle,
  bitmap: ImageBitmap,
  region: AxisOcrCrop,
  job: AxisOcrJob,
  kind: "number" | "name",
  generation: number,
  progress: ProgressRange,
): Promise<{ text: string; confidence: number }> {
  assertJobActive(job);
  if (generation !== workerEpoch) throw new DOMException("OCR worker was replaced", "AbortError");
  const pixels = readRegionPixels(bitmap, region);
  const prepared = axisOcrPrepareTensor(pixels, { x: 0, y: 0, width: pixels.width, height: pixels.height }, kind);
  job.progressRange = progress;
  try {
    const result = await worker.recognize(prepared.data, prepared.dims);
    assertJobActive(job);
    if (generation !== workerEpoch) throw new DOMException("OCR worker was replaced", "AbortError");
    reportProgress(job, progress.end);
    return result;
  } catch (error) {
    if (!job.settled && !job.options.signal.aborted) failWorker(generation, error);
    throw error;
  }
}

function taskProgress(index: number, total: number): ProgressRange {
  const start = 0.12 + 0.86 * index / total;
  return { start, end: 0.12 + 0.86 * (index + 1) / total };
}

async function recognizeImage(job: AxisOcrJob): Promise<AxisOcrResult> {
  assertJobActive(job);
  if (!validImageMetadata(job.image)) throw new TypeError("Invalid screenshot dimensions");
  const blob = await fetchRaster(job);
  reportProgress(job, 0.04);
  assertJobActive(job);
  const bitmap = await loadBitmap(blob, job);
  if (!validImageMetadata({ ...job.image, width: bitmap.width, height: bitmap.height })) throw new RangeError("Screenshot exceeds the 24 million pixel OCR limit");
  reportProgress(job, 0.08);
  const crop = detectCrop(bitmap, job);
  const regions = axisOcrRegions(crop);
  const { worker, generation } = await getWorker(job);
  assertJobActive(job);

  const total = 2 + regions.rows.length * 4;
  let taskIndex = 0;
  const leftScore = parseAxisOcrNumbers((await recognizeText(worker, bitmap, regions.score.left, job, "number", generation, taskProgress(taskIndex++, total))).text, 1)?.[0] ?? null;
  const rightScore = parseAxisOcrNumbers((await recognizeText(worker, bitmap, regions.score.right, job, "number", generation, taskProgress(taskIndex++, total))).text, 1)?.[0] ?? null;
  const rowValues = new Map<string, { kills: number | null; deaths: number | null; assists: number | null }>();
  for (const row of regions.rows) {
    const kills = parseAxisOcrNumbers((await recognizeText(worker, bitmap, row.kills, job, "number", generation, taskProgress(taskIndex++, total))).text, 1)?.[0] ?? null;
    const deaths = parseAxisOcrNumbers((await recognizeText(worker, bitmap, row.deaths, job, "number", generation, taskProgress(taskIndex++, total))).text, 1)?.[0] ?? null;
    const assists = parseAxisOcrNumbers((await recognizeText(worker, bitmap, row.assists, job, "number", generation, taskProgress(taskIndex++, total))).text, 1)?.[0] ?? null;
    rowValues.set(`${row.side}:${row.index}`, {
      kills,
      deaths,
      assists,
    });
  }

  const nicknames = new Map<string, { nickname: string; confidence: number }>();
  for (const row of regions.rows) {
    const result = await recognizeText(worker, bitmap, row.name, job, "name", generation, taskProgress(taskIndex++, total));
    nicknames.set(`${row.side}:${row.index}`, { nickname: cleanedNickname(result.text), confidence: result.confidence });
  }

  const rows: AxisOcrRow[] = regions.rows.map(({ side, index }) => {
    const id = `${side}:${index}`;
    const stats = rowValues.get(id)!;
    const name = nicknames.get(id)!;
    return {
      id,
      side,
      index,
      nickname: name.nickname,
      kills: stats.kills,
      deaths: stats.deaths,
      assists: stats.assists,
      confidence: name.nickname ? name.confidence : 0,
    };
  });
  reportProgress(job, 0.99);
  return { score: { left: leftScore, right: rightScore }, rows, crop };
}

function validImageMetadata(image: AxisOcrImage): boolean {
  return typeof image.src === "string" && image.src.length > 0
    && Number.isSafeInteger(image.width) && image.width > 0
    && Number.isSafeInteger(image.height) && image.height > 0
    && image.width * image.height <= MAX_IMAGE_PIXELS;
}

async function drainQueue(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (queue.length > 0) {
      const job = queue.shift()!;
      if (job.settled || job.options.signal.aborted) {
        cancelJob(job, job.options.signal.reason);
        continue;
      }
      activeJob = job;
      job.state = "active";
      reportProgress(job, 0);
      try {
        const execution = recognizeImage(job);
        const result = await awaitAbortable(execution, job.done.signal);
        finishResolved(job, result);
      } catch (error) {
        finishRejected(job, error);
      } finally {
        if (activeJob === job) activeJob = null;
        job.workerGeneration = undefined;
      }
    }
  } finally {
    draining = false;
    if (queue.length > 0) void drainQueue();
  }
}

/** Recognize one scoreboard with a shared, serialized browser worker. */
export function recognizeAxisScreenshot(
  image: AxisOcrImage,
  options: { signal: AbortSignal; onProgress?: (n: number) => void; crop?: AxisOcrCrop },
): Promise<AxisOcrResult> {
  if (!options?.signal || typeof options.signal.addEventListener !== "function") return Promise.reject(new TypeError("An AbortSignal is required"));
  if (options.signal.aborted) return Promise.reject(asError(options.signal.reason));
  if (!validImageMetadata(image)) return Promise.reject(new TypeError("Invalid screenshot dimensions"));

  return new Promise((resolve, reject) => {
    const job = {} as AxisOcrJob;
    job.image = image;
    job.options = options;
    job.resolve = resolve;
    job.reject = reject;
    job.done = new AbortController();
    job.cleanup = new Set();
    job.progress = 0;
    job.progressRange = { start: 0, end: 0.08 };
    job.state = "queued";
    job.settled = false;
    job.abortListener = () => cancelJob(job, options.signal.reason);
    options.signal.addEventListener("abort", job.abortListener, { once: true });
    if (options.signal.aborted) {
      cancelJob(job, options.signal.reason);
      return;
    }
    queue.push(job);
    void drainQueue();
  });
}
