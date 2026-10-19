import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "assets", "axis-ocr");
const target = join(root, "public", "ocr", "paddle-v1");
const runtimeDist = dirname(require.resolve("onnxruntime-web/wasm"));

await mkdir(target, { recursive: true });
for (const [input, output] of [
  [join(source, "model.onnx"), join(target, "model.onnx")],
  [join(source, "dictionary.json"), join(target, "dictionary.json")],
  [join(source, "LICENSE"), join(target, "PADDLEOCR-LICENSE")],
  [join(source, "ONNXRUNTIME-LICENSE"), join(target, "ONNXRUNTIME-LICENSE")],
  [join(runtimeDist, "ort-wasm-simd-threaded.mjs"), join(target, "ort-wasm-simd-threaded.mjs")],
  [join(runtimeDist, "ort-wasm-simd-threaded.wasm"), join(target, "ort-wasm-simd-threaded.wasm")],
]) {
  await stat(input);
  await copyFile(input, output);
}

const dictionary = JSON.parse(await readFile(join(target, "dictionary.json"), "utf8"));
if (!Array.isArray(dictionary) || dictionary.length < 10 || dictionary.length > 100_000
  || dictionary.some((character) => typeof character !== "string" || character.length === 0)) {
  throw new TypeError("Expected the ordered PP-OCRv5 English character dictionary without CTC blank");
}
console.log("Prepared same-origin PP-OCRv5 English OCR assets and ONNX Runtime Web WASM.");
