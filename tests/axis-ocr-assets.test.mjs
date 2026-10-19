import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const digest = async (path) => createHash("sha256").update(await readFile(path)).digest("hex");

test("prepares only pinned same-origin Paddle and ONNX Runtime assets", async () => {
  execFileSync(process.execPath, ["scripts/prepare-axis-ocr.mjs"], { stdio: "pipe" });
  const runtimeDist = dirname(require.resolve("onnxruntime-web/wasm"));
  const files = [
    ["assets/axis-ocr/model.onnx", "public/ocr/paddle-v1/model.onnx"],
    ["assets/axis-ocr/dictionary.json", "public/ocr/paddle-v1/dictionary.json"],
    ["assets/axis-ocr/LICENSE", "public/ocr/paddle-v1/PADDLEOCR-LICENSE"],
    ["assets/axis-ocr/ONNXRUNTIME-LICENSE", "public/ocr/paddle-v1/ONNXRUNTIME-LICENSE"],
    [join(runtimeDist, "ort-wasm-simd-threaded.mjs"), "public/ocr/paddle-v1/ort-wasm-simd-threaded.mjs"],
    [join(runtimeDist, "ort-wasm-simd-threaded.wasm"), "public/ocr/paddle-v1/ort-wasm-simd-threaded.wasm"],
  ];
  for (const [source, target] of files) assert.equal(await digest(target), await digest(source), `${target} should match its pinned source`);

  const dictionary = JSON.parse(await readFile("assets/axis-ocr/dictionary.json", "utf8"));
  assert.ok(Array.isArray(dictionary) && dictionary.length >= 10 && dictionary.length < 100_000);
  assert.ok(dictionary.every((character) => typeof character === "string" && character.length > 0));
});
