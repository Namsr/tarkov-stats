import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

/**
 * `stats_json` is queried by SQLite in a few hot paths.  The compressed form
 * therefore remains valid JSON and repeats only the scalar fields used by
 * those queries at the top level.  The complete original JSON text lives in
 * the gzip payload and is returned by `decodeStorageJsonText`.
 */
export const STORAGE_JSON_PROJECTION_KEYS = [
  "pmcKilledPmc",
  "pmcKdRatio",
  "pvpStatsKnown",
  "pvpStatsVersion",
  "pvpStatsParserVersion",
  "pmcSurvived",
  "pmcKills",
  "lastPlayedAt",
  "raidsOrMatches",
  "leaderboardActivityAt",
] as const;

export type StorageJsonProjectionKey = typeof STORAGE_JSON_PROJECTION_KEYS[number];

const STORAGE_MARKER = "__tarkovstats_storage";
const STORAGE_MAGIC = "tarkovstats-json";
const STORAGE_VERSION = 1;
const STORAGE_CODEC = "gzip-base64";
const MIN_SOURCE_BYTES = 256;
const MIN_SAVINGS_BYTES = 64;
const MAX_STORAGE_JSON_BYTES = 8 * 1024 * 1024;
const MAX_ENVELOPE_BYTES = 12 * 1024 * 1024;

type JsonObject = Record<string, unknown>;

interface StorageEnvelopeMarker {
  magic: string;
  version: number;
  codec: string;
  sha256: string;
  data: string;
}

export class StorageJsonError extends Error {
  constructor(message: string) {
    super(`invalid stored JSON envelope: ${message}`);
    this.name = "StorageJsonError";
  }
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function jsonEqual(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function parseObject(value: string): JsonObject | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function storageJsonText(value: unknown): string {
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  if (typeof raw !== "string") throw new TypeError("stored JSON must be serializable");
  return raw;
}

function isEnvelopeCandidate(value: unknown): value is { [STORAGE_MARKER]: unknown } {
  if (!isObject(value) || !Object.hasOwn(value, STORAGE_MARKER)) return false;
  const marker = value[STORAGE_MARKER];
  // A legacy payload may contain an unrelated reserved property. A marker
  // shaped like our envelope must still fail closed if its magic is damaged.
  return isObject(marker) && (marker.magic === STORAGE_MAGIC ||
    ["version", "codec", "sha256", "data"].every((key) => Object.hasOwn(marker, key)));
}

function projectionFor(parsed: JsonObject): JsonObject {
  const projection: JsonObject = {};
  for (const key of STORAGE_JSON_PROJECTION_KEYS) {
    if (Object.hasOwn(parsed, key)) projection[key] = parsed[key];
  }
  return projection;
}

function validateProjection(envelope: JsonObject, decoded: JsonObject): void {
  for (const key of STORAGE_JSON_PROJECTION_KEYS) {
    const sourceHas = Object.hasOwn(decoded, key);
    const envelopeHas = Object.hasOwn(envelope, key);
    if (sourceHas !== envelopeHas || (sourceHas && !jsonEqual(envelope[key], decoded[key]))) {
      throw new StorageJsonError(`projection mismatch for ${key}`);
    }
  }
}

function readMarker(value: JsonObject): StorageEnvelopeMarker | null {
  if (!isEnvelopeCandidate(value)) return null;
  const marker = value[STORAGE_MARKER];
  if (!isObject(marker) || marker.magic !== STORAGE_MAGIC) throw new StorageJsonError("invalid magic");
  if (marker.version !== STORAGE_VERSION || marker.codec !== STORAGE_CODEC) {
    throw new StorageJsonError("unsupported version or codec");
  }
  if (typeof marker.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(marker.sha256)) {
    throw new StorageJsonError("invalid checksum");
  }
  if (typeof marker.data !== "string" || marker.data.length === 0 || marker.data.length > MAX_ENVELOPE_BYTES ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(marker.data) || marker.data.length % 4 !== 0) {
    throw new StorageJsonError("invalid payload");
  }
  return marker as unknown as StorageEnvelopeMarker;
}

/**
 * Encode a JSON object or a JSON text.  Invalid/non-object text remains
 * untouched because the legacy column has always permitted it.  The original
 * text is kept byte-for-byte inside the payload when compression is selected.
 */
export function encodeStorageJson(value: unknown): string {
  const raw = storageJsonText(value);
  if (Buffer.byteLength(raw, "utf8") < MIN_SOURCE_BYTES || Buffer.byteLength(raw, "utf8") > MAX_STORAGE_JSON_BYTES) return raw;
  const parsed = parseObject(raw);
  if (!parsed || Object.hasOwn(parsed, STORAGE_MARKER)) return raw;
  // SQLite's JSON1 returns the first value for a duplicate key, while
  // JSON.parse returns the last.  Only canonical JSON.stringify output has
  // unambiguous projection semantics, so retain every other legacy spelling.
  if (JSON.stringify(parsed) !== raw) return raw;

  const bytes = Buffer.from(raw, "utf8");
  const compressed = gzipSync(bytes, { level: 6 });
  const envelope: JsonObject = {
    [STORAGE_MARKER]: {
      magic: STORAGE_MAGIC,
      version: STORAGE_VERSION,
      codec: STORAGE_CODEC,
      sha256: sha256(bytes),
      data: compressed.toString("base64"),
    },
    ...projectionFor(parsed),
  };
  const encoded = JSON.stringify(envelope);
  if (Buffer.byteLength(encoded, "utf8") + MIN_SAVINGS_BYTES > bytes.length) return raw;
  return encoded;
}

/**
 * Encode a new runtime row only after the operator explicitly enables the
 * dual-read rollout flag.  Keeping writes plaintext by default lets an older
 * image safely serve or roll back while the new readers are deployed.
 */
export function encodeStorageJsonForWrite(value: unknown): string {
  const raw = storageJsonText(value);
  return process.env.STORAGE_JSON_COMPRESSION === "true" ? encodeStorageJson(raw) : raw;
}

/** Decode a legacy plaintext or a validated compressed envelope to its exact JSON text. */
export function decodeStorageJsonText(value: unknown): string {
  if (typeof value !== "string") throw new StorageJsonError("value is not text");
  const parsed = parseObject(value);
  if (!parsed) return value;
  const marker = readMarker(parsed);
  if (!marker) return value;

  let decodedBytes: Buffer;
  try {
    const encoded = Buffer.from(marker.data, "base64");
    if (encoded.toString("base64") !== marker.data) throw new Error("invalid base64 payload");
    decodedBytes = gunzipSync(encoded, { maxOutputLength: MAX_STORAGE_JSON_BYTES });
  } catch (error) {
    throw new StorageJsonError(`gzip decode failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (decodedBytes.length > MAX_STORAGE_JSON_BYTES || sha256(decodedBytes) !== marker.sha256) {
    throw new StorageJsonError("checksum or size mismatch");
  }
  const decoded = decodedBytes.toString("utf8");
  const decodedObject = parseObject(decoded);
  if (!decodedObject) throw new StorageJsonError("payload is not a JSON object");
  validateProjection(parsed, decodedObject);
  return decoded;
}

/** Decode and parse either storage format. */
export function decodeStorageJson<T = unknown>(value: unknown): T {
  return JSON.parse(decodeStorageJsonText(value)) as T;
}
