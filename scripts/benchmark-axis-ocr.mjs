import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { performance } from "node:perf_hooks";
import sharp from "sharp";
import * as ort from "onnxruntime-web/wasm";
import { detectAxisScoreboard, axisOcrRegions, axisOcrPrepareTensor, axisOcrDecodeCtc } from "../lib/axis-ocr-layout.ts";
import { matchAxisOcrRows, inferAxisOcrLeftTeam, parseAxisOcrCounter } from "../lib/axis-ocr.ts";

const manifestPath = process.argv[2];
if (!manifestPath) throw new Error("Usage: node --experimental-strip-types scripts/benchmark-axis-ocr.mjs <manifest.json> [output.json]");
const manifest = JSON.parse(await readFile(resolve(manifestPath), "utf8"));
if (!Array.isArray(manifest.matches) || !manifest.matches.length) throw new Error("No labeled matches");
const started = performance.now();
const dictionary = JSON.parse(await readFile(resolve("assets/axis-ocr/dictionary.json"), "utf8"));
ort.env.wasm.numThreads = 1;
const session = await ort.InferenceSession.create(new Uint8Array(await readFile(resolve("assets/axis-ocr/model.onnx"))), { executionProviders: ["wasm"] });
const initializationMs = Math.round(performance.now() - started);
const matches = [];

async function readRegion(image, region, kind) {
  const prepared = axisOcrPrepareTensor(image, region, kind);
  const outputs = await session.run({ [session.inputNames[0]]: new ort.Tensor("float32", prepared.data, prepared.dims) });
  const output = outputs[session.outputNames[0]];
  if (output.dims.length !== 3 || output.dims[0] !== 1) throw new Error("Unexpected OCR model output shape");
  return axisOcrDecodeCtc(output.data, output.dims[1], output.dims[2], dictionary);
}

try {
  for (const truth of manifest.matches) {
    const start = performance.now();
    const source = await readFile(truth.image);
    const { data, info } = await sharp(source).rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const crop = detectAxisScoreboard({ width: info.width, height: info.height, data });
    if (!crop) { matches.push({ matchNumber: truth.matchNumber, detected: false, rows: [], score: { left: null, right: null }, ms: Math.round(performance.now() - start) }); continue; }
    const regions = axisOcrRegions(crop);
    const image = { width: info.width, height: info.height, data };
    const score = {};
    for (const side of ["left", "right"]) score[side] = parseAxisOcrCounter((await readRegion(image, regions.score[side], "number")).text);
    const rows = [];
    for (const region of regions.rows) {
      const name = await readRegion(image, region.name, "name");
      const values = [];
      for (const field of ["kills", "deaths", "assists"]) values.push(parseAxisOcrCounter((await readRegion(image, region[field], "number")).text));
      rows.push({ id: `${region.side}:${region.index}`, side: region.side, index: region.index,
        nickname: name.text.replace(/\s+/g, " ").trim().replace(/^[|,;:]+|[|,;:]+$/g, "").trim(), kills: values?.[0] ?? null, deaths: values?.[1] ?? null, assists: values?.[2] ?? null,
        confidence: name.confidence });
    }
    const assignments = matchAxisOcrRows(rows, truth.participants);
    matches.push({ matchNumber: truth.matchNumber, detected: true, crop, score, rows,
      assignments, leftTeamIndex: inferAxisOcrLeftTeam(rows, assignments, truth.participants), ms: Math.round(performance.now() - start) });
    console.log(JSON.stringify({ match: truth.matchNumber, score: matches.at(-1).score, names: rows.map(row => row.nickname), ms: matches.at(-1).ms }));
  }
} finally { await session.release(); }

const metrics = { matches: manifest.matches.length, detected: 0, scoreCorrect: 0, counterTotal: 0, counterCorrect: 0, rowTotal: 0, rowCorrect: 0, assigned: 0, wrongAssignments: 0, oriented: 0, orientationCorrect: 0, completeMatches: 0 };
for (let index = 0; index < manifest.matches.length; index++) {
  const truth = manifest.matches[index], result = matches[index];
  if (result.detected) metrics.detected++;
  const scoreCorrect = result.score.left === truth.score.left && result.score.right === truth.score.right;
  if (scoreCorrect) metrics.scoreCorrect++;
  if (result.leftTeamIndex != null) { metrics.oriented++; if (result.leftTeamIndex === truth.leftTeamIndex) metrics.orientationCorrect++; }
  let complete = scoreCorrect;
  for (const expected of truth.rows) {
    const row = result.rows.find(entry => entry.id === expected.id);
    let rowCorrect = true;
    for (const field of ["kills", "deaths", "assists"]) { metrics.counterTotal++; if (row?.[field] === expected[field]) metrics.counterCorrect++; else rowCorrect = false; }
    const assigned = result.assignments?.[expected.id];
    if (assigned) { metrics.assigned++; if (assigned !== expected.discordId) metrics.wrongAssignments++; }
    metrics.rowTotal++;
    if (rowCorrect && assigned === expected.discordId) metrics.rowCorrect++; else complete = false;
  }
  if (complete) metrics.completeMatches++;
}
const report = { split: manifest.split, engine: "PP-OCRv5 English mobile; ONNX Runtime Web WASM CPU", initializationMs, note: "Node/sharp image decoding with shared browser tensor preparation and CTC decoding. Timings do not establish browser performance. Development data is not an independent accuracy estimate.", metrics, matches };
if (process.argv[3]) { const output = resolve(process.argv[3]); await mkdir(dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + "\n"); }
console.log(JSON.stringify({ initializationMs, metrics }));
