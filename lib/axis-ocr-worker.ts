export type AxisOcrTensorDimensions = [1, 3, 48, number];

export interface AxisOcrWorkerResult {
  text: string;
  confidence: number;
}

export interface AxisOcrWorkerHandle {
  readonly ready: Promise<void>;
  recognize(data: Float32Array, dims: AxisOcrTensorDimensions): Promise<AxisOcrWorkerResult>;
  terminate(): Promise<void>;
}

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

interface WorkerPort {
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  postMessage(message: WorkerRequest, transfer?: Transferable[]): void;
  terminate(): void;
}

export interface AxisOcrWorkerOptions {
  onError?: (error: unknown) => void;
  /** Injected only by focused protocol tests. */
  workerFactory?: () => WorkerPort;
}

interface PendingRequest {
  type: WorkerRequest["type"];
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

function toError(value: unknown, fallback = "Axis OCR worker failed"): Error {
  if (value instanceof Error) return value;
  if (typeof value === "string" && value) return new Error(value);
  if (value && typeof value === "object" && "message" in value && typeof value.message === "string") {
    return new Error(value.message);
  }
  return new Error(fallback);
}

function abortError(): DOMException {
  return new DOMException("Axis OCR worker was terminated", "AbortError");
}

function validTensor(data: Float32Array, dims: AxisOcrTensorDimensions): boolean {
  return data instanceof Float32Array
    && Array.isArray(dims) && dims.length === 4
    && dims[0] === 1 && dims[1] === 3 && dims[2] === 48
    && Number.isSafeInteger(dims[3]) && dims[3] >= 320 && dims[3] <= 3200
    && data.length === 3 * 48 * dims[3];
}

/**
 * Start a module worker immediately so its native handle is available before
 * model fetching/session initialization begins. Termination can therefore stop
 * both initialization and inference without waiting for either promise.
 */
export function createAxisOcrWorker(options: AxisOcrWorkerOptions = {}): AxisOcrWorkerHandle {
  const createNativeWorker = options.workerFactory ?? (() => {
    if (typeof Worker === "undefined") throw new Error("This browser cannot start OCR workers");
    return new Worker(new URL("./axis-ocr-runtime.worker.ts", import.meta.url), { type: "module" }) as WorkerPort;
  });
  const worker = createNativeWorker();
  const pending = new Map<number, PendingRequest>();
  let sequence = 0;
  let terminated = false;
  let failed = false;

  const terminate = (reason: unknown = abortError()): Promise<void> => {
    if (terminated) return Promise.resolve();
    terminated = true;
    worker.onmessage = null;
    worker.onerror = null;
    worker.onmessageerror = null;
    try { worker.terminate(); } catch { /* A failed worker may already be stopped. */ }
    for (const request of pending.values()) request.reject(reason);
    pending.clear();
    return Promise.resolve();
  };

  const fail = (reason: unknown): void => {
    if (failed || terminated) return;
    failed = true;
    const error = toError(reason);
    void terminate(error);
    try { options.onError?.(error); } catch { /* Reporting cannot block cleanup. */ }
  };

  const request = <T>(type: WorkerRequest["type"], payload?: unknown, transfer?: Transferable[]): Promise<T> => {
    if (terminated) return Promise.reject(abortError());
    const id = ++sequence;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { type, resolve: resolve as (value: unknown) => void, reject });
      try { worker.postMessage({ id, type, payload }, transfer); }
      catch (error) {
        pending.delete(id);
        reject(error);
        fail(error);
      }
    });
  };

  worker.onmessage = ({ data }) => {
    if (!data || !Number.isSafeInteger(data.id)) return;
    const current = pending.get(data.id);
    if (!current) return;
    if (data.type === "error") {
      const error = toError(data.payload);
      pending.delete(data.id);
      current.reject(error);
      if (data.fatal) fail(error);
      return;
    }
    const expectedType = current.type === "initialize" ? "ready" : "result";
    if (data.type !== expectedType) return;
    pending.delete(data.id);
    current.resolve(data.payload);
  };
  worker.onerror = (event) => fail(event.error ?? event.message);
  worker.onmessageerror = () => fail(new Error("Could not read an Axis OCR worker response"));

  const ready = request<void>("initialize").catch((error: unknown) => {
    fail(error);
    throw error;
  });

  return {
    ready,
    recognize: async (data, dims) => {
      if (!validTensor(data, dims)) throw new TypeError("Invalid Axis OCR tensor");
      await ready;
      if (terminated) throw abortError();
      const owned = data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
        ? data
        : new Float32Array(data);
      const result = await request<unknown>("recognize", { data: owned, dims }, [owned.buffer as ArrayBuffer]);
      if (!result || typeof result !== "object") throw new Error("Invalid Axis OCR worker result");
      const { text, confidence } = result as Partial<AxisOcrWorkerResult>;
      if (typeof text !== "string" || typeof confidence !== "number" || !Number.isFinite(confidence)) {
        throw new Error("Invalid Axis OCR worker result");
      }
      return { text, confidence };
    },
    terminate,
  };
}
