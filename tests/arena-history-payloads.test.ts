import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";
import { ARENA_HISTORY_PAYLOAD_TABLE,
  createArenaHistoryPayloadReader, ensureArenaHistoryPayloadSchema, storeArenaHistoryPayloadGroup } from "../lib/arena/history-payloads.ts";
import { ARENA_HISTORY_REFERENCE_MARKER, decodeStorageJsonText, encodeStorageJson } from "../lib/storage-json.ts";
import { prepareBanLocalArchive } from "../lib/ban-import.ts";
import { backfillLeaderboardExactFields } from "../scripts/backfill-leaderboard-exact-fields.mjs";

const table = ARENA_HISTORY_PAYLOAD_TABLE;
const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const raw = (i = 0) => ` { "sourceCounters": {"BestArp":${100 + i}}, "unknown": "${"Ё\\\"future".repeat(300)}", "duplicate":1,"duplicate":2 }\n`;
const marker = (ref: string): unknown[] => JSON.parse(ref)[ARENA_HISTORY_REFERENCE_MARKER];
const changeRef = (ref: string, change: (value: unknown[]) => void): string => {
  const parsed = JSON.parse(ref); change(parsed[ARENA_HISTORY_REFERENCE_MARKER]); return JSON.stringify(parsed);
};
function insertChunk(db: DatabaseSync, values: unknown[], changes: Record<string, unknown> = {}): string {
  ensureArenaHistoryPayloadSchema(db);
  const plain = Buffer.from(JSON.stringify(values));
  const sha = sha256(plain);
  const row = { row_count: values.length, plain_bytes: plain.length, payload: gzipSync(plain), ...changes };
  db.prepare(`INSERT INTO ${table} VALUES(?,?,?,?)`).run(sha, row.row_count as number, row.plain_bytes as number, row.payload as Uint8Array);
  return JSON.stringify({ [ARENA_HISTORY_REFERENCE_MARKER]: [1, sha, 0, sha256(`${sha}:0`).slice(0, 16)] });
}

test("history groups preserve exact unknown fields, duplicate keys, spelling and every row", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const values = Array.from({ length: 64 }, (_, i) => raw(i));
    const refs = storeArenaHistoryPayloadGroup(db, values)!;
    assert.equal(refs.length, values.length);
    const read = createArenaHistoryPayloadReader(db);
    assert.deepEqual(refs.map(read), values);
    assert.deepEqual(storeArenaHistoryPayloadGroup(db, values), refs);
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()!.n, 1);
    assert.throws(() => decodeStorageJsonText(refs[0]), /requires its database resolver/);
    const wrappedRef = encodeStorageJson(JSON.stringify({ ...JSON.parse(refs[0]), padding: "x".repeat(4000) }));
    assert.throws(() => decodeStorageJsonText(wrappedRef), /requires its database resolver/);
    const metadata = db.prepare(`SELECT row_count,plain_bytes,payload FROM ${table}`).get()!;
    assert.equal(metadata.row_count, 64);
    assert.equal(metadata.plain_bytes, Buffer.byteLength(JSON.stringify(values)));
    assert.deepEqual(JSON.parse(gunzipSync(metadata.payload as Uint8Array).toString()), values);
  } finally { db.close(); }
});

test("a legacy database reads mixed plaintext and old envelopes without creating a chunk table", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const read = createArenaHistoryPayloadReader(db);
    const canonical = JSON.stringify({ unknown: "future".repeat(1000) });
    const envelope = encodeStorageJson(canonical);
    assert.notEqual(envelope, canonical);
    assert.equal(read(canonical), canonical);
    assert.equal(read(envelope), canonical);
    const collision = JSON.stringify({ [ARENA_HISTORY_REFERENCE_MARKER]: { legacy: true } });
    assert.equal(read(collision), collision);
    assert.equal(decodeStorageJsonText(collision), collision);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name=?").get(table)!.n, 0);
    const refs = storeArenaHistoryPayloadGroup(db, [raw()])!;
    assert.equal(read(refs[0]), raw());
    assert.equal(read(envelope), canonical);
  } finally { db.close(); }
});

test("unprofitable and oversized groups stay inline, including JSON escaping overhead", () => {
  const db = new DatabaseSync(":memory:");
  try {
    assert.equal(storeArenaHistoryPayloadGroup(db, ["{}"]), null);
    const escaped = "\"".repeat(600_000);
    assert.ok(Buffer.byteLength(escaped) < 1024 * 1024);
    assert.equal(storeArenaHistoryPayloadGroup(db, [escaped]), null);
    assert.equal(storeArenaHistoryPayloadGroup(db, ["x".repeat(1024 * 1024 + 1)]), null);
    assert.throws(() => storeArenaHistoryPayloadGroup(db, []), /1 to 64/);
    assert.throws(() => storeArenaHistoryPayloadGroup(db, Array(65).fill(raw())), /1 to 64/);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name=?").get(table)!.n, 0);
    const exact = "x".repeat(1024 * 1024 - 4); // JSON array adds exactly four bytes.
    assert.ok(storeArenaHistoryPayloadGroup(db, [exact]));
    assert.equal(storeArenaHistoryPayloadGroup(db, [exact + "x"]), null);
  } finally { db.close(); }
});

test("invalid reference metadata, index bit rot and absent chunks fail closed", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const ref = storeArenaHistoryPayloadGroup(db, [raw(), raw(1)])![0];
    const read = createArenaHistoryPayloadReader(db);
    for (const mutate of [
      (m: unknown[]) => { m[0] = 2; }, (m: unknown[]) => { m[1] = "a"; },
      (m: unknown[]) => { m[2] = 1; }, (m: unknown[]) => { m[2] = -1; },
      (m: unknown[]) => { m[2] = "0"; }, (m: unknown[]) => { m[3] = "0".repeat(16); },
      (m: unknown[]) => { m.push(1); },
    ]) assert.throws(() => read(changeRef(ref, mutate)), /reference metadata or checksum/);
    const extra = JSON.parse(ref); extra.unknown = true;
    assert.throws(() => read(JSON.stringify(extra)), /reference metadata/);
    const outOfRange = changeRef(ref, m => { m[2] = 2; m[3] = sha256(`${m[1]}:2`).slice(0, 16); });
    assert.throws(() => read(outOfRange), /exceeds chunk row count/);
    db.exec(`DELETE FROM ${table}`);
    assert.throws(() => createArenaHistoryPayloadReader(db)(ref), /chunk is missing/);
    db.exec(`DROP TABLE ${table}`);
    assert.throws(() => createArenaHistoryPayloadReader(db)(ref), /chunk table is missing/);
  } finally { db.close(); }
});

test("chunk checksum, metadata, array types and bounded gzip protect the reader", () => {
  const cases = [
    { values: [raw()], changes: { plain_bytes: 1 } },
    { values: [raw()], changes: { row_count: 2 } },
    { values: [raw()], changes: { payload: gzipSync(Buffer.from('["changed"]')) } },
    { values: [raw()], changes: { payload: Buffer.from("not gzip") } },
    { values: [123], changes: {} },
    { values: [raw()], changes: { plain_bytes: 100, payload: gzipSync(Buffer.from("x".repeat(1024 * 1024 + 1))) } },
  ];
  for (const { values, changes } of cases) {
    const db = new DatabaseSync(":memory:");
    try {
      const ref = insertChunk(db, values, changes);
      assert.throws(() => createArenaHistoryPayloadReader(db)(ref), /Arena history chunk/);
    } finally { db.close(); }
  }
});

test("an existing corrupt content address cannot be overwritten by packing", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const values = [raw()];
    const ref = storeArenaHistoryPayloadGroup(db, values)![0];
    db.prepare(`UPDATE ${table} SET payload=? WHERE sha256=?`).run(Buffer.from("broken"), marker(ref)[1] as string);
    assert.throws(() => storeArenaHistoryPayloadGroup(db, values), /chunk gzip decode/);
    assert.equal(Buffer.from(db.prepare(`SELECT payload FROM ${table}`).get()!.payload as Uint8Array).toString(), "broken");
  } finally { db.close(); }
});

test("attached database resolver quotes schema names and does not read main chunks", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const ref = storeArenaHistoryPayloadGroup(db, [raw()])![0];
    db.exec(`ATTACH ':memory:' AS "players\"\"_db";
      CREATE TABLE "players\"\"_db".${table} AS SELECT * FROM main.${table}; DROP TABLE main.${table};`);
    assert.equal(createArenaHistoryPayloadReader(db, { schema: 'players"_db' })(ref), raw());
    assert.throws(() => createArenaHistoryPayloadReader(db)(ref), /chunk table is missing/);
  } finally { db.close(); }
});

test("decoded chunk cache evicts at both 64 entries and eight MiB", t => {
  for (const [count, size] of [[65, 2000], [10, 950_000]]) {
    const db = new DatabaseSync(":memory:");
    try {
      const refs = Array.from({ length: count }, (_, i) => storeArenaHistoryPayloadGroup(db, [`${i}:${"x".repeat(size)}`])![0]);
      let reads = 0;
      const original = db.prepare.bind(db);
      const mock = t.mock.method(db, "prepare", (sql: string) => {
        const statement = original(sql);
        if (sql.includes(`FROM "main".${table}`)) {
          const get = statement.get.bind(statement);
          t.mock.method(statement, "get", (...args: Parameters<typeof get>) => { reads++; return get(...args); });
        }
        return statement;
      });
      const read = createArenaHistoryPayloadReader(db);
      refs.forEach(read);
      assert.equal(reads, count);
      read(refs.at(-1)!);
      assert.equal(reads, count, "recent chunk stays cached");
      read(refs[0]);
      assert.equal(reads, count + 1, "oldest chunk was evicted");
      mock.mock.restore();
    } finally { db.close(); }
  }
});

test("ban row archives resolve every storage JSON field before source chunks disappear", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const ref = storeArenaHistoryPayloadGroup(db, [raw()])![0];
    const canonical = JSON.stringify({ unknown: "keep".repeat(1000) });
    const envelope = encodeStorageJson(canonical);
    db.exec(`CREATE TABLE banned_stored_rows(aid INTEGER,source_table TEXT,source_key TEXT,row_json_gzip BLOB,PRIMARY KEY(aid,source_table,source_key));
      ATTACH ':memory:' AS players_db; ATTACH ':memory:' AS progression_db;
      CREATE TABLE players_db.${table} AS SELECT * FROM main.${table}; DROP TABLE main.${table};
      CREATE TABLE players_db.excluded_players(aid INTEGER PRIMARY KEY,reason TEXT,created_at INTEGER);
      CREATE TABLE progression_db.excluded_players(aid INTEGER PRIMARY KEY,reason TEXT,created_at INTEGER);
      CREATE TABLE players_db.mode_players(aid INTEGER PRIMARY KEY,stats_json TEXT);
      CREATE TABLE players_db.arena_mode_stats(aid INTEGER PRIMARY KEY,raw_json TEXT);
      CREATE TABLE players_db.arena_mode_stats_history(aid INTEGER PRIMARY KEY,raw_json TEXT);
      CREATE TABLE progression_db.progression_snapshots(aid INTEGER PRIMARY KEY,stats_json TEXT);`);
    for (const source of ["players_db.mode_players", "players_db.arena_mode_stats", "progression_db.progression_snapshots"]) {
      db.prepare(`INSERT INTO ${source} VALUES(42,?)`).run(envelope);
    }
    db.prepare("INSERT INTO players_db.arena_mode_stats_history VALUES(42,?)").run(ref);
    db.exec("BEGIN");
    prepareBanLocalArchive(db, new Set([42]))(42);
    db.exec("COMMIT");
    assert.equal(db.prepare("SELECT raw_json FROM players_db.arena_mode_stats_history").get()!.raw_json, ref);
    db.exec(`DROP TABLE players_db.${table}`);
    const rows = db.prepare("SELECT source_table,row_json_gzip FROM banned_stored_rows").all();
    assert.equal(rows.length, 4);
    for (const row of rows) {
      const archived = JSON.parse(gunzipSync(row.row_json_gzip as Uint8Array).toString());
      assert.equal(archived.stats_json ?? archived.raw_json,
        row.source_table === "players_db.arena_mode_stats_history" ? raw() : canonical);
    }
  } finally { db.close(); }
});

test("backfill reads grouped historical counters and rolls back on a missing chunk", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`CREATE TABLE mode_players(mode TEXT,aid INTEGER,profile_updated_at INTEGER,stats_json TEXT,pmc_killed_pmc INTEGER,last_played_at INTEGER,pvp_stats_version INTEGER);
      CREATE TABLE players(pmc_killed_pmc INTEGER,last_played_at INTEGER);
      CREATE TABLE arena_mode_stats(aid INTEGER,arena_mode TEXT,upstream_version INTEGER,parser_version INTEGER,raw_json TEXT,best_arp INTEGER);
      CREATE TABLE arena_mode_stats_history AS SELECT * FROM arena_mode_stats;`);
    const ref = storeArenaHistoryPayloadGroup(db, [raw()])![0];
    db.prepare("INSERT INTO arena_mode_stats_history VALUES(42,'overall',1,1,?,NULL)").run(ref);
    assert.equal(backfillLeaderboardExactFields(db).arenaUpdated, 1);
    assert.equal(db.prepare("SELECT best_arp FROM arena_mode_stats_history").get()!.best_arp, 100);
    db.exec(`UPDATE arena_mode_stats_history SET best_arp=NULL; DELETE FROM ${table};`);
    db.prepare("INSERT INTO arena_mode_stats VALUES(42,'overall',1,1,?,NULL)").run(raw(1));
    assert.throws(() => backfillLeaderboardExactFields(db), /chunk is missing/);
    assert.equal(db.prepare("SELECT best_arp FROM arena_mode_stats").get()!.best_arp, null);
  } finally { db.close(); }
});
