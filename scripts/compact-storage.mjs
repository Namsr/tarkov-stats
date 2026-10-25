import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, openSync, realpathSync, statfsSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { ARENA_HISTORY_REFERENCE_MARKER, decodeStorageJsonText, encodeStorageJson, STORAGE_JSON_PROJECTION_KEYS } from "../lib/storage-json.ts";
import { ARENA_HISTORY_PAYLOAD_TABLE, ARENA_HISTORY_PAYLOAD_SCHEMA,
  createArenaHistoryPayloadReader, storeArenaHistoryPayloadGroup } from "../lib/arena/history-payloads.ts";

const TARGET_COLUMNS = {
  mode_players: "stats_json",
  progression_snapshots: "stats_json",
  arena_mode_stats: "raw_json",
  arena_mode_stats_history: "raw_json",
};
const TARGETS = new Set(Object.keys(TARGET_COLUMNS));
const RESERVE = 1024n ** 3n;
const MAX_JSON_ROW_BYTES = 12 * 1024 * 1024;
const quote = (name) => `"${name.replaceAll('"', '""')}"`;

function assertCheck(db, pragma) {
  const rows = db.prepare(`PRAGMA ${pragma}`).all();
  if (rows.length !== 1 || Object.values(rows[0])[0] !== "ok") {
    throw new Error(`SQLite ${pragma} failed`);
  }
}

function inventory(db) {
  return db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type, name").all();
}

function coreSchema(schema) {
  const normalize = (sql) => sql.replace(/\bIF\s+NOT\s+EXISTS\b/gi, "").replace(/\s+/g, " ").trim().replace(/;$/, "").toLowerCase();
  return schema.filter((item) => {
    if (item.name.toLowerCase() !== ARENA_HISTORY_PAYLOAD_TABLE) {
      if (new RegExp(`\\b${ARENA_HISTORY_PAYLOAD_TABLE}\\b`, "i").test(item.sql)) {
        throw new Error(`Unsupported private Arena storage schema reader in ${item.name}`);
      }
      return true;
    }
    if (item.type !== "table" || normalize(item.sql) !== normalize(ARENA_HISTORY_PAYLOAD_SCHEMA)) {
      throw new Error("Unsupported Arena history storage schema");
    }
    return false;
  });
}

function assertSchemaJsonAccess(schema) {
  // These databases can contain old/custom schema objects. Fail closed for
  // JSON paths whose values the envelope does not expose to native SQLite.
  // A false positive is safe: it asks the operator to review that object.
  const paths = new Set(STORAGE_JSON_PROJECTION_KEYS.map((key) => `$.${key}`));
  const name = '(?:stats_json|raw_json|"stats_json"|"raw_json"|`stats_json`|`raw_json`|\\[stats_json\\]|\\[raw_json\\])';
  const column = `(?:(?:[a-z_]\\w*|"[^"]+"|\x60[^\x60]+\x60|\\[[^\\]]+\\])\\s*\\.\\s*)?${name}`;
  const projection = new RegExp(`\\bjson(?:b)?_(?:extract|type|array_length|valid)\\s*\\(\\s*${column}\\s*(?:,\\s*(['"])\\$[^'"]*\\1\\s*)?\\)`, "gi");
  const declaration = new RegExp(`${name}\\s+TEXT\\b`, "gi");
  for (const item of schema) {
    const sql = item.sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, " ");
    // These are the project's two decoder-aware transparent aliases. Unknown
    // SELECT * views/triggers can copy envelopes into a plaintext contract.
    const transparentMode = new Map([["pve_players", "pve"], ["arena_players", "arena"]]).get(item.name.toLowerCase());
    const normalized = sql.replace(/["`\[\]]/g, "").replace(/\s+/g, " ").trim().replace(/;$/, "");
    if (item.type === "view" && transparentMode && new RegExp(
      `^CREATE VIEW ${item.name} AS SELECT \\* FROM mode_players WHERE mode\\s*=\\s*'${transparentMode}'$`, "i",
    ).test(normalized)) continue;
    const referencesTarget = /\b(?:mode_players|progression_snapshots|arena_mode_stats|arena_mode_stats_history|pve_players|arena_players)\b/i.test(sql);
    // Conservative on purpose: DISTINCT, quoted aliases, CTEs and SELECT via
    // a transparent alias must not conceal an implicit payload copy. Even
    // COUNT(*) in a custom schema object requires operator review here.
    if (item.type !== "table" && referencesTarget && /\b(?:SELECT|RETURNING)\b[\s\S]*\*/i.test(sql)) {
      throw new Error(`Unsupported JSON schema reader in ${item.name}; implicit columns require an explicit contract`);
    }
    if (!/\b(?:stats_json|raw_json)\b/i.test(sql)) continue;
    if (/\braw_json\b/i.test(sql) && /\bjson(?:b)?_\w+\s*\(|->/i.test(sql)) {
      throw new Error(`Unsupported JSON schema reader in ${item.name}; history payloads require a database resolver`);
    }
    const accessed = [...sql.matchAll(/['"](\$[^'"]*)['"]/g)].map((match) => match[1]);
    const functions = [...sql.matchAll(/\b(json(?:b)?_\w+|json|jsonb)\s*\(/gi)].map((match) => match[1].toLowerCase());
    const extracts = [...sql.matchAll(/\bjson(?:b)?_extract\s*\(/gi)].length;
    const simpleExtracts = [...sql.matchAll(/\bjson(?:b)?_extract\s*\([^()]*?,\s*(['"])\$[^'"]*\1\s*\)/gi)].length;
    const dynamicType = [...sql.matchAll(/\bjson(?:b)?_(?:type|array_length)\s*\(([^()]*)\)/gi)]
      .some((match) => match[1].includes(",") && !/,\s*(['"])\$[^'"]*\1\s*$/.test(match[1]));
    if (accessed.some((path) => !paths.has(path)) ||
      functions.some((name) => !/^json(?:b)?_(?:extract|type|array_length|valid)$/.test(name)) ||
      extracts !== simpleExtracts || dynamicType || (!accessed.length && /->/i.test(sql))) {
      throw new Error(`Unsupported JSON schema reader in ${item.name}; review its paths before compaction`);
    }
    let remaining = sql.replace(projection, "");
    if (item.type === "table" && TARGETS.has(item.name.toLowerCase())) remaining = remaining.replace(declaration, "");
    if (item.type === "trigger" && TARGETS.has(item.tbl_name.toLowerCase())) {
      remaining = remaining.replace(/\bOLD\.(stats_json|raw_json)\s+IS\s+NOT\s+NEW\.\1\b/gi, "");
    }
    if (/\b(?:stats_json|raw_json)\b/i.test(remaining)) {
      throw new Error(`Unsupported JSON schema reader in ${item.name}; direct representation access requires review`);
    }
  }
}

function hashValue(hash, value) {
  if (value === null) { hash.update("null;"); return; }
  if (value instanceof Uint8Array) {
    hash.update(`blob:${value.byteLength}:`); hash.update(value); return;
  }
  if (typeof value === "number") {
    const bytes = Buffer.allocUnsafe(8); bytes.writeDoubleBE(value);
    hash.update("float:"); hash.update(bytes); return;
  }
  const bytes = Buffer.from(String(value));
  hash.update(`${typeof value}:${bytes.byteLength}:`); hash.update(bytes);
}

// Compare every logical value, including revisions/queues/sqlite_sequence. Only
// the selected JSON columns are decoded before hashing. BigInt reads
// avoid rounding SQLite integers that are outside JavaScript's safe range.
function fingerprint(db) {
  const result = [];
  const historyPayload = createArenaHistoryPayloadReader(db);
  for (const { name } of db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND lower(name) <> ? ORDER BY name").all(ARENA_HISTORY_PAYLOAD_TABLE)) {
    const columns = db.prepare(`PRAGMA table_info(${quote(name)})`).all();
    const keys = columns.filter((column) => column.pk).sort((a, b) => a.pk - b.pk);
    const order = (keys.length ? keys : columns).map((column) => quote(column.name)).join(", ");
    const statement = db.prepare(`SELECT * FROM ${quote(name)}${order ? ` ORDER BY ${order}` : ""}`);
    statement.setReadBigInts(true);
    const hash = createHash("sha256");
    let rows = 0;
    for (const row of statement.iterate()) {
      hash.update("row:");
      for (const [column, raw] of Object.entries(row)) {
        hashValue(hash, column);
        hashValue(hash, TARGET_COLUMNS[name.toLowerCase()] === column.toLowerCase()
          ? (name.toLowerCase() === "arena_mode_stats_history" ? historyPayload(raw) : decodeStorageJsonText(raw)) : raw);
      }
      rows++;
    }
    result.push({ table: name, rows, sha256: hash.digest("hex") });
  }
  return result;
}

function assertSame(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${label} changed during compaction`);
}

function syncFile(path) {
  const fd = openSync(path, "r+");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Create a verified offline copy. Never modifies/replaces the source or an
 * existing destination. An incomplete staging file is discarded on failure. */
export async function compactStorage({ source, output, decompress = false, batchSize = 128, onProgress = () => {}, signal }) {
  if (!source || !output) throw new Error("Both --source and --output are required");
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1024) throw new Error("batch-size must be between 1 and 1024");
  const input = resolve(source);
  const destination = resolve(output);
  if (!lstatSync(input).isFile() || lstatSync(input).isSymbolicLink()) throw new Error("Source must be a regular, non-symlink database file");
  if (existsSync(destination)) throw new Error("Output already exists; refusing to overwrite it");
  const parent = realpathSync(dirname(destination));
  if (realpathSync(input) === resolve(parent, basename(destination))) throw new Error("Source and output must differ");
  const stage = resolve(parent, `.storage-compact-${randomUUID()}.db`);
  let sourceDb;
  let targetDb;
  let ownsStage = false;
  const started = Date.now();
  try {
    signal?.throwIfAborted();
    sourceDb = new DatabaseSync(input, { readOnly: true });
    sourceDb.exec("PRAGMA busy_timeout = 5000; BEGIN");
    const pageSize = sourceDb.prepare("PRAGMA page_size").get().page_size;
    const pageCount = sourceDb.prepare("PRAGMA page_count").get().page_count;
    const bytesBefore = pageSize * pageCount;
    const space = statfsSync(parent, { bigint: true });
    // The copy, its rollback journal and VACUUM may coexist. Deliberately require
    // off-host headroom instead of attempting this on the almost-full VPS.
    const required = BigInt(bytesBefore) * 3n + RESERVE;
    if (space.bavail * space.bsize < required) throw new Error(`Insufficient offline disk space: require ${required} bytes free`);
    assertCheck(sourceDb, "quick_check");
    const schema = inventory(sourceDb);
    const originalCoreSchema = coreSchema(schema);
    assertSchemaJsonAccess(originalCoreSchema);
    const metadata = {
      applicationId: sourceDb.prepare("PRAGMA application_id").get().application_id,
      userVersion: sourceDb.prepare("PRAGMA user_version").get().user_version,
    };
    onProgress({ phase: "copy", bytesBefore });
    closeSync(openSync(stage, "wx", 0o600)); ownsStage = true;
    await backup(sourceDb, stage, { rate: 256 });
    signal?.throwIfAborted();
    targetDb = new DatabaseSync(stage);
    targetDb.exec("PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; PRAGMA temp_store = FILE; PRAGMA cache_size = -8192");
    const targets = schema.filter((item) => item.type === "table" && TARGETS.has(item.name.toLowerCase())).map((item) => item.name);
    if (!targets.length) throw new Error("No supported JSON storage tables found");
    const triggers = schema.filter((item) => item.type === "trigger" && TARGETS.has(item.tbl_name.toLowerCase()));
    // This is an isolated unpublished copy. Drop all triggers attached to the
    // rewritten tables so representation changes do not advance business state.
    targetDb.exec("BEGIN IMMEDIATE");
    try {
      for (const trigger of triggers) targetDb.exec(`DROP TRIGGER ${quote(trigger.name)}`);
      targetDb.exec("COMMIT");
    } catch (error) { targetDb.exec("ROLLBACK"); throw error; }
    const tables = [];
    for (const table of targets) {
      const column = TARGET_COLUMNS[table.toLowerCase()];
      const isHistory = table.toLowerCase() === "arena_mode_stats_history";
      const readPayload = isHistory ? createArenaHistoryPayloadReader(targetDb) : decodeStorageJsonText;
      // Batch only rowids, not JSON payloads: 1024 large legacy profiles must
      // not become a multi-gigabyte JavaScript array.
      const select = targetDb.prepare(`SELECT rowid AS storage_rowid FROM ${quote(table)} WHERE rowid > ? ORDER BY rowid LIMIT ?`);
      select.setReadBigInts(true);
      const first = targetDb.prepare(`SELECT rowid AS storage_rowid FROM ${quote(table)} ORDER BY rowid LIMIT ?`);
      first.setReadBigInts(true);
      const size = targetDb.prepare(`SELECT length(CAST(${quote(column)} AS BLOB)) AS bytes FROM ${quote(table)} WHERE rowid = ?`);
      const read = targetDb.prepare(`SELECT ${quote(column)} AS storage_json FROM ${quote(table)} WHERE rowid = ?`);
      const update = targetDb.prepare(`UPDATE ${quote(table)} SET ${quote(column)} = ? WHERE rowid = ?`);
      let last = null;
      let rows = 0; let changed = 0; let textBytesBefore = 0; let textBytesAfter = 0;
      for (;;) {
        signal?.throwIfAborted();
        const batch = last === null ? first.all(batchSize) : select.all(last, batchSize);
        if (!batch.length) break;
        targetDb.exec("BEGIN IMMEDIATE");
        try {
          let group = [];
          let groupBytes = 2;
          const save = (row, replacement) => {
            if (readPayload(replacement) !== row.original) throw new Error(`JSON round-trip failed in ${table}`);
            const replacementHash = createHash("sha256").update(replacement).digest("hex");
            if (replacementHash !== row.storedHash) { update.run(replacement, row.storage_rowid); changed++; }
            textBytesBefore += row.storedBytes;
            textBytesAfter += Buffer.byteLength(replacement);
            rows++; last = row.storage_rowid;
          };
          const flush = () => {
            if (!group.length) return;
            const refs = storeArenaHistoryPayloadGroup(targetDb, group.map((row) => row.original));
            for (let i = 0; i < group.length; i++) save(group[i], refs?.[i] ?? encodeStorageJson(group[i].original));
            group = []; groupBytes = 2;
          };
          for (const row of batch) {
            if (size.get(row.storage_rowid).bytes > MAX_JSON_ROW_BYTES) throw new Error(`JSON row exceeds migration limit in ${table}`);
            const { storage_json: stored } = read.get(row.storage_rowid);
            const original = readPayload(stored);
            // Do not retain the encoded source in a group: accepted legacy
            // envelopes can be much larger than their decoded JSON text.
            const entry = { storage_rowid: row.storage_rowid, original,
              storedBytes: Buffer.byteLength(stored), storedHash: createHash("sha256").update(stored).digest("hex") };
            if (isHistory && !decompress) {
              // Bound serialized bytes, including escaping inside the array.
              const itemBytes = Buffer.byteLength(JSON.stringify(original)) + 1;
              if (group.length >= 64 || groupBytes + itemBytes > 1024 * 1024) flush();
              if (itemBytes + 2 <= 1024 * 1024) { group.push(entry); groupBytes += itemBytes; }
              else save(entry, encodeStorageJson(original));
            } else save(entry, decompress ? original : encodeStorageJson(original));
          }
          if (isHistory && !decompress) flush();
          targetDb.exec("COMMIT");
        } catch (error) { targetDb.exec("ROLLBACK"); throw error; }
        if (rows % (batchSize * 64) === 0) onProgress({ phase: "encode", table, rows, changed });
        // Deliver cancellation between bounded transactions. The original is
        // read-only and the partially rewritten copy is never published.
        await new Promise(setImmediate);
      }
      tables.push({ table, column, rows, changed, textBytesBefore, textBytesAfter });
      onProgress({ phase: "table_done", ...tables.at(-1) });
    }
    const storageExists = targetDb.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND lower(name)=?").get(ARENA_HISTORY_PAYLOAD_TABLE);
    if (storageExists) {
      if (decompress) targetDb.exec(`DROP TABLE ${quote(ARENA_HISTORY_PAYLOAD_TABLE)}`);
      else {
        // Offline-only garbage collection. The immutable chunks referenced by
        // surviving history rows remain; old/repacked orphan chunks are pruned.
        const history = targets.find((name) => name.toLowerCase() === "arena_mode_stats_history");
        if (!history) throw new Error("Arena payload storage has no history table");
        targetDb.prepare(`DELETE FROM ${quote(ARENA_HISTORY_PAYLOAD_TABLE)} WHERE sha256 NOT IN
          (SELECT sha FROM (SELECT CASE WHEN json_valid(raw_json) THEN json_extract(raw_json, ?) END AS sha
            FROM ${quote(history)}) WHERE typeof(sha)='text')`).run(`$.${ARENA_HISTORY_REFERENCE_MARKER}[1]`);
      }
    }
    targetDb.exec("BEGIN IMMEDIATE");
    try {
      for (const trigger of triggers) targetDb.exec(trigger.sql);
      targetDb.exec("COMMIT");
    } catch (error) { targetDb.exec("ROLLBACK"); throw error; }
    signal?.throwIfAborted();
    onProgress({ phase: "vacuum" });
    targetDb.exec("VACUUM");
    onProgress({ phase: "verify" });
    assertCheck(targetDb, "integrity_check");
    const finalSchema = inventory(targetDb);
    assertSame(coreSchema(finalSchema), originalCoreSchema, "Core schema/trigger inventory");
    assertSame({
      applicationId: targetDb.prepare("PRAGMA application_id").get().application_id,
      userVersion: targetDb.prepare("PRAGMA user_version").get().user_version,
    }, metadata, "Database metadata");
    const before = fingerprint(sourceDb);
    const after = fingerprint(targetDb);
    assertSame(after, before, "Logical table contents");
    const chunkStorage = targetDb.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND lower(name)=?").get(ARENA_HISTORY_PAYLOAD_TABLE)
      ? targetDb.prepare(`SELECT COUNT(*) AS chunks, COALESCE(SUM(length(payload)),0) AS compressedBytes FROM ${quote(ARENA_HISTORY_PAYLOAD_TABLE)}`).get()
      : { chunks: 0, compressedBytes: 0 };
    targetDb.close(); targetDb = undefined;
    sourceDb.exec("ROLLBACK"); sourceDb.close(); sourceDb = undefined;
    signal?.throwIfAborted();
    syncFile(stage);
    // A hard link on the same filesystem publishes atomically without the
    // overwrite race of rename(). The source and its backup remain untouched.
    linkSync(stage, destination);
    unlinkSync(stage); ownsStage = false;
    return { version: 1, direction: decompress ? "decompress" : "compress", source: input, output: destination,
      bytesBefore, bytesAfter: statSync(destination).size, elapsedMs: Date.now() - started,
      integrityCheck: "ok", schemaUnchanged: JSON.stringify(finalSchema) === JSON.stringify(schema),
      coreSchemaUnchanged: true, arenaHistoryStorage: chunkStorage, tables, verifiedTables: after };
  } finally {
    targetDb?.close(); sourceDb?.close();
    if (ownsStage) {
      for (const path of [stage, `${stage}-journal`, `${stage}-wal`, `${stage}-shm`]) {
        try { unlinkSync(path); } catch (error) { if (error.code !== "ENOENT") throw error; }
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const controller = new AbortController();
  const interrupt = () => controller.abort(new Error("Offline conversion interrupted"));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    const { values } = parseArgs({ options: { source: { type: "string" }, output: { type: "string" },
      decompress: { type: "boolean", default: false }, "batch-size": { type: "string", default: "128" } } });
    const result = await compactStorage({ source: values.source, output: values.output,
      decompress: values.decompress, batchSize: Number(values["batch-size"]), signal: controller.signal,
      onProgress: (event) => console.error(JSON.stringify(event)) });
    console.log(JSON.stringify(result));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt); }
}
