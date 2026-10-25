import { createHash } from "node:crypto";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { gunzipSync, gzipSync } from "node:zlib";
import { ARENA_HISTORY_REFERENCE_MARKER, decodeStorageJsonText,
  isArenaHistoryPayloadReferenceCandidate, StorageJsonError } from "../storage-json.ts";

export const ARENA_HISTORY_PAYLOAD_TABLE = "arena_history_payload_chunks";
export const ARENA_HISTORY_PAYLOAD_SCHEMA = `
CREATE TABLE IF NOT EXISTS ${ARENA_HISTORY_PAYLOAD_TABLE} (
  sha256 TEXT PRIMARY KEY,
  row_count INTEGER NOT NULL,
  plain_bytes INTEGER NOT NULL,
  payload BLOB NOT NULL
) WITHOUT ROWID;`;

const MAX_GROUP_ROWS = 64;
const MAX_GROUP_BYTES = 1024 * 1024;
const MAX_COMPRESSED_BYTES = MAX_GROUP_BYTES + 1024;
const MAX_CACHE_BYTES = 8 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 64;
const SHA256 = /^[0-9a-f]{64}$/;
const REF_CHECKSUM = /^[0-9a-f]{16}$/;

function hash(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function invalid(message: string): never {
  throw new StorageJsonError(`Arena history ${message}`);
}

function reference(sha: string, index: number): string {
  return JSON.stringify({ [ARENA_HISTORY_REFERENCE_MARKER]: [1, sha, index, hash(`${sha}:${index}`).slice(0, 16)] });
}

function decodeChunk(row: Record<string, unknown>, sha: string): { values: string[]; bytes: number } {
  if (!Number.isSafeInteger(row.row_count) || Number(row.row_count) < 1 || Number(row.row_count) > MAX_GROUP_ROWS ||
    !Number.isSafeInteger(row.plain_bytes) || Number(row.plain_bytes) < 2 || Number(row.plain_bytes) > MAX_GROUP_BYTES ||
    !(row.payload instanceof Uint8Array) || row.payload.byteLength > MAX_COMPRESSED_BYTES) invalid("chunk metadata is invalid");
  let plain: Buffer;
  try {
    plain = gunzipSync(row.payload as Uint8Array, { maxOutputLength: MAX_GROUP_BYTES });
  } catch { invalid("chunk gzip decode failed"); }
  if (plain.length !== row.plain_bytes || hash(plain) !== sha) invalid("chunk checksum or size mismatch");
  let values: unknown;
  try { values = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plain)); }
  catch { invalid("chunk is not a UTF-8 JSON array"); }
  if (!Array.isArray(values) || values.length !== row.row_count || values.some(value => typeof value !== "string")) {
    invalid("chunk row count or value type mismatch");
  }
  return { values: values as string[], bytes: plain.length };
}

export function ensureArenaHistoryPayloadSchema(db: DatabaseSync): void {
  db.exec(ARENA_HISTORY_PAYLOAD_SCHEMA);
}

/** Offline only: retain exact source strings; reject groups that would increase storage. */
export function storeArenaHistoryPayloadGroup(db: DatabaseSync, values: string[]): string[] | null {
  if (!Array.isArray(values) || values.length < 1 || values.length > MAX_GROUP_ROWS) {
    throw new RangeError("Arena history group must contain 1 to 64 strings");
  }
  let sourceBytes = 0;
  for (const value of values) {
    if (typeof value !== "string") throw new TypeError("Arena history payload must be text");
    sourceBytes += Buffer.byteLength(value, "utf8");
    if (sourceBytes > MAX_GROUP_BYTES) return null;
  }
  // Check before allocating bytes: escaping exact JSON strings also counts toward the limit.
  const serialized = JSON.stringify(values);
  if (Buffer.byteLength(serialized, "utf8") > MAX_GROUP_BYTES) return null;
  const plain = Buffer.from(serialized, "utf8");
  const sha = hash(plain);
  const payload = gzipSync(plain, { level: 6 });
  const refs = values.map((_, index) => reference(sha, index));
  const storedBytes = payload.length + 128 + refs.reduce((sum, ref) => sum + Buffer.byteLength(ref), 0);
  if (storedBytes + 64 > sourceBytes) return null;
  ensureArenaHistoryPayloadSchema(db);
  db.prepare(`INSERT INTO ${ARENA_HISTORY_PAYLOAD_TABLE}(sha256,row_count,plain_bytes,payload)
    VALUES(?,?,?,?) ON CONFLICT(sha256) DO NOTHING`).run(sha, values.length, plain.length, payload);
  const existing = db.prepare(`SELECT row_count,plain_bytes,payload FROM ${ARENA_HISTORY_PAYLOAD_TABLE}
    WHERE sha256=? AND length(payload)<=?`).get(sha, MAX_COMPRESSED_BYTES);
  if (!existing) invalid("chunk missing or oversized after insert");
  const verified = decodeChunk(existing, sha);
  if (verified.values.some((value, index) => value !== values[index])) invalid("chunk content collision");
  return refs;
}

/** Legacy databases need no private table until an actual reference is encountered. */
export function createArenaHistoryPayloadReader(db: DatabaseSync, options: { schema?: string } = {}): (value: unknown) => string {
  const schema = options.schema ?? "main";
  const qualifiedTable = `"${schema.replaceAll('"', '""')}".${ARENA_HISTORY_PAYLOAD_TABLE}`;
  let lookup: StatementSync | undefined;
  let cachedBytes = 0;
  const cache = new Map<string, { values: string[]; bytes: number }>();
  return (value: unknown): string => {
    if (typeof value !== "string") return decodeStorageJsonText(value);
    let parsed: unknown;
    try { parsed = JSON.parse(value); } catch { return decodeStorageJsonText(value); }
    if (!isArenaHistoryPayloadReferenceCandidate(parsed)) return decodeStorageJsonText(value);
    const object = parsed as Record<string, unknown>;
    const marker = object[ARENA_HISTORY_REFERENCE_MARKER] as unknown[];
    const [version, sha, index, checksum] = marker;
    if (Object.keys(object).length !== 1 || marker.length !== 4 || version !== 1 ||
      typeof sha !== "string" || !SHA256.test(sha) || !Number.isSafeInteger(index) ||
      Number(index) < 0 || Number(index) >= MAX_GROUP_ROWS || typeof checksum !== "string" || !REF_CHECKSUM.test(checksum) ||
      checksum !== hash(`${sha}:${index}`).slice(0, 16)) invalid("reference metadata or checksum is invalid");
    let chunk = cache.get(sha);
    if (chunk) cache.delete(sha);
    else {
      try {
        lookup ??= db.prepare(`SELECT row_count,plain_bytes,payload FROM ${qualifiedTable} WHERE sha256=? AND length(payload)<=?`);
      } catch { invalid("chunk table is missing or unavailable"); }
      const row = lookup.get(sha, MAX_COMPRESSED_BYTES);
      if (!row) invalid("chunk is missing or oversized");
      chunk = decodeChunk(row, sha);
      while (cache.size >= MAX_CACHE_ENTRIES || cachedBytes + chunk.bytes > MAX_CACHE_BYTES) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cachedBytes -= cache.get(oldest)!.bytes;
        cache.delete(oldest);
      }
      cachedBytes += chunk.bytes;
    }
    cache.set(sha, chunk);
    if (Number(index) >= chunk.values.length) invalid("reference index exceeds chunk row count");
    return chunk.values[Number(index)];
  };
}
