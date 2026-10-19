import * as ort from "onnxruntime-web/wasm";
import { axisOcrDecodeCtc } from "./axis-ocr-layout.ts";

const MODEL_URL = "/ocr/paddle-v1/model.onnx";
const DICTIONARY_URL = "/ocr/paddle-v1/dictionary.json";
const WASM_PATH = "/ocr/paddle-v1/";
const MAX_MODEL_BYTES = 32 * 1024 * 1024;
const MAX_DICTIONARY_BYTES = 2 * 1024 * 1024;

interface WorkerRequest {
  id: number;
  type: "initialize" | "recognize";
  payload?: unknown;
}

interface WorkerResponse {
  id: number;
  type: "ready" | "result" | "error";
  payload?: unknown;
  fatal?: boolean;
}

interface TensorPayload {
  data: Float32Array;
  dims: [1, 3, 48, number];
}

interface WorkerContext {
  location: Location;
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerResponse): void;
}

const scope = self as unknown as WorkerContext;
let sessionPromise: Promise<ort.InferenceSession> | null = null;
let dictionaryPromise: Promise<string[]> | null = null;
let recognitionQueue: Promise<void> = Promise.resolve();

function sameOriginAssetUrl(path: string): string {
  const url = new URL(path, scope.location.origin);
  if (url.origin !== scope.location.origin || url.protocol !== scope.location.protocol) {
    throw new TypeError("Axis OCR assets must be same-origin");
  }
  return url.href;
}

async function fetchBoundedBytes(path: string, limit: number, label: string): Promise<Uint8Array> {
  const response = await fetch(sameOriginAssetUrl(path), {
    cache: "force-cache",
    credentials: "same-origin",
    redirect: "error",
  });
  if (!response.ok) throw new Error(`Could not load local OCR ${label} (${response.status})`);
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > limit) throw new RangeError(`OCR ${label} exceeds its size limit`);
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > limit) throw new RangeError(`OCR ${label} must be between 1 byte and ${limit} bytes`);
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > limit) {
        await reader.cancel();
        throw new RangeError(`OCR ${label} exceeds its size limit`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (byteLength === 0) throw new RangeError(`OCR ${label} must be between 1 byte and ${limit} bytes`);
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function loadDictionary(): Promise<string[]> {
  if (!dictionaryPromise) {
    dictionaryPromise = fetchBoundedBytes(DICTIONARY_URL, MAX_DICTIONARY_BYTES, "dictionary")
      .then((bytes) => JSON.parse(new TextDecoder().decode(bytes)) as unknown)
      .then((value) => {
        if (!Array.isArray(value) || value.length < 10 || value.length > 100_000
          || value.some((character) => typeof character !== "string" || character.length === 0 || character.length > 8)) {
          throw new TypeError("The local OCR character dictionary is invalid");
        }
        return value as string[];
      })
      .catch((error: unknown) => {
        dictionaryPromise = null;
        throw error;
      });
  }
  return dictionaryPromise;
}

function loadSession(): Promise<ort.InferenceSession> {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      // Run one CPU/WASM thread; the model stays inside this dedicated worker.
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.proxy = false;
      ort.env.wasm.wasmPaths = sameOriginAssetUrl(WASM_PATH);
      const [modelBytes] = await Promise.all([
        fetchBoundedBytes(MODEL_URL, MAX_MODEL_BYTES, "model"),
        loadDictionary(),
      ]);
      return ort.InferenceSession.create(modelBytes, {
        executionProviders: ["wasm"],
        graphOptimizationLevel: "all",
      });
    })().catch((error: unknown) => {
      sessionPromise = null;
      throw error;
    });
  }
  return sessionPromise;
}

function readTensor(value: unknown): TensorPayload {
  if (!value || typeof value !== "object") throw new TypeError("Invalid Axis OCR tensor payload");
  const payload = value as Partial<TensorPayload>;
  const { data, dims } = payload;
  if (!(data instanceof Float32Array) || !Array.isArray(dims) || dims.length !== 4
    || dims[0] !== 1 || dims[1] !== 3 || dims[2] !== 48
    || !Number.isSafeInteger(dims[3]) || dims[3] < 320 || dims[3] > 3200
    || data.length !== 3 * 48 * dims[3]) {
    throw new TypeError("Invalid Axis OCR tensor shape");
  }
  return { data, dims: dims as [1, 3, 48, number] };
}

async function recognize(value: unknown): Promise<{ text: string; confidence: number }> {
  const tensor = readTensor(value);
  const [model, dictionary] = await Promise.all([loadSession(), loadDictionary()]);
  if (model.inputNames.length !== 1 || model.outputNames.length < 1) {
    throw new Error("The local OCR model has an unsupported input or output signature");
  }
  const outputs = await model.run({
    [model.inputNames[0]]: new ort.Tensor("float32", tensor.data, tensor.dims),
  });
  const output = outputs[model.outputNames[0]];
  if (!output || output.dims.length !== 3 || output.dims[0] !== 1 || output.dims[1] < 1) {
    throw new Error("The local OCR model returned an unsupported output shape");
  }
  if (output.dims[2] !== dictionary.length + 1 || !(output.data instanceof Float32Array)) {
    throw new Error("The local OCR model output does not match its character dictionary");
  }
  return axisOcrDecodeCtc(output.data, output.dims[1], output.dims[2], dictionary);
}

function respond(id: number, type: WorkerResponse["type"], payload?: unknown, fatal?: boolean): void {
  scope.postMessage({ id, type, payload, ...(fatal === undefined ? {} : { fatal }) });
}

scope.onmessage = ({ data }) => {
  if (!data || !Number.isSafeInteger(data.id)) return;
  if (data.type === "initialize") {
    void Promise.all([loadSession(), loadDictionary()]).then(
      () => respond(data.id, "ready"),
      (error: unknown) => respond(data.id, "error", error instanceof Error ? error.message : String(error), true),
    );
    return;
  }
  if (data.type === "recognize") {
    const job = recognitionQueue.then(() => recognize(data.payload));
    recognitionQueue = job.then(() => undefined, () => undefined);
    void job.then(
      (result) => respond(data.id, "result", result),
      (error: unknown) => respond(data.id, "error", error instanceof Error ? error.message : String(error)),
    );
  }
};
