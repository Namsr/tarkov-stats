import assert from "node:assert/strict";
import test from "node:test";
import { createAxisOcrWorker } from "../lib/axis-ocr-worker.ts";

class FakeWorker {
  static active = 0;
  messages = [];
  onmessage = null;
  onerror = null;
  onmessageerror = null;
  terminated = false;

  constructor(autoRespond = false) {
    this.autoRespond = autoRespond;
    FakeWorker.active++;
  }

  postMessage(packet) {
    this.messages.push(packet);
    if (this.autoRespond) queueMicrotask(() => this.respond(packet));
  }

  respond(packet) {
    if (packet.type === "initialize") this.onmessage?.({ data: { id: packet.id, type: "ready" } });
    else this.onmessage?.({ data: { id: packet.id, type: "result", payload: { text: "7", confidence: 0.93 } } });
  }

  terminate() {
    if (this.terminated) return;
    this.terminated = true;
    FakeWorker.active--;
  }
}

const options = (workerFactory, onError) => ({ workerFactory, onError });
const numericTensor = () => new Float32Array(3 * 48 * 320);

test("termination during local model initialization kills the worker and rejects all waiters", async () => {
  FakeWorker.active = 0;
  let first;
  const handle = createAxisOcrWorker(options(() => (first = new FakeWorker())));
  const ready = handle.ready.then(() => null, (error) => error);
  const inference = handle.recognize(numericTensor(), [1, 3, 48, 320]).then(() => null, (error) => error);

  assert.equal(first.messages[0].type, "initialize");
  assert.equal(FakeWorker.active, 1);
  await handle.terminate();
  const [readyError, inferenceError] = await Promise.all([ready, inference]);
  assert.equal(first.terminated, true);
  assert.equal(FakeWorker.active, 0);
  assert.equal(readyError.name, "AbortError");
  assert.equal(inferenceError.name, "AbortError");

  let replacementWorker;
  const replacement = createAxisOcrWorker(options(() => (replacementWorker = new FakeWorker(true))));
  await replacement.ready;
  assert.deepEqual(replacementWorker.messages.map((message) => message.type), ["initialize"]);
  const result = await replacement.recognize(numericTensor(), [1, 3, 48, 320]);
  assert.deepEqual(result, { text: "7", confidence: 0.93 });
  assert.deepEqual(replacementWorker.messages.map((message) => message.type), ["initialize", "recognize"]);
  assert.equal(FakeWorker.active, 1, "only the replacement worker remains alive");
  await replacement.terminate();
  assert.equal(FakeWorker.active, 0);
});

test("termination during inference rejects pending work and releases the native worker", async () => {
  FakeWorker.active = 0;
  let worker;
  const handle = createAxisOcrWorker(options(() => (worker = new FakeWorker(true))));
  await handle.ready;
  const inference = handle.recognize(numericTensor(), [1, 3, 48, 320]).then(() => null, (error) => error);
  await Promise.resolve();
  assert.equal(worker.messages[1].type, "recognize");
  await handle.terminate();
  const error = await inference;
  assert.equal(error.name, "AbortError");
  assert.equal(worker.terminated, true);
  assert.equal(FakeWorker.active, 0);
});

test("invalid tensor shapes are rejected before crossing the worker boundary", async () => {
  const handle = createAxisOcrWorker(options(() => new FakeWorker(true)));
  await handle.ready;
  await assert.rejects(handle.recognize(numericTensor(), [1, 3, 48, 319]), /Invalid Axis OCR tensor/);
  await handle.terminate();
});

test("a native worker error terminates it before reporting failure", async () => {
  FakeWorker.active = 0;
  let worker;
  let terminatedWhenReported = false;
  const handle = createAxisOcrWorker(options(
    () => (worker = new FakeWorker()),
    () => { terminatedWhenReported = worker.terminated; },
  ));
  const ready = handle.ready.then(() => null, (error) => error);
  worker.onerror({ message: "worker crashed", error: new Error("worker crashed") });

  const error = await ready;
  assert.match(error.message, /worker crashed/);
  assert.equal(terminatedWhenReported, true);
  assert.equal(FakeWorker.active, 0);
});
