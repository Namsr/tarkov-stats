import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { compactStorage } from "../scripts/compact-storage.mjs";
import { decodeStorageJsonText, encodeStorageJson } from "../lib/storage-json.ts";
import { createArenaHistoryPayloadReader } from "../lib/arena/history-payloads.ts";

const largeStats = (n) => JSON.stringify({ nickname: `player-${n}`, pmcKilledPmc: n,
  pvpStatsKnown: n % 2 === 0, lastPlayedAt: null,
  futureField: Array.from({ length: 160 }, (_, i) => ({ name: `unknown-${i}`, value: n + i })) });

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "compact-storage-"));
  const source = join(dir, "source.db");
  const output = join(dir, "compressed.db");
  const db = new DatabaseSync(source);
  try {
    db.exec(`BEGIN; PRAGMA application_id = 1234; PRAGMA user_version = 57;
      CREATE TABLE mode_players (mode TEXT, aid INTEGER, stats_json TEXT NOT NULL, PRIMARY KEY(mode, aid));
      CREATE TABLE progression_snapshots (id INTEGER PRIMARY KEY, stats_json TEXT NOT NULL);
      CREATE TABLE arena_mode_stats (aid INTEGER, arena_mode TEXT, raw_json TEXT, PRIMARY KEY(aid, arena_mode));
      CREATE TABLE arena_mode_stats_history (aid INTEGER, arena_mode TEXT, version INTEGER, raw_json TEXT, PRIMARY KEY(aid, arena_mode, version));
      CREATE TABLE changes (id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT);
      CREATE TABLE other_data (id INTEGER PRIMARY KEY, payload BLOB, nullable TEXT);
      CREATE TRIGGER custom_mode_change AFTER UPDATE ON MODE_PLAYERS BEGIN INSERT INTO changes(action) VALUES ('mode'); END;
      CREATE TRIGGER custom_progression_change BEFORE UPDATE ON progression_snapshots BEGIN INSERT INTO changes(action) VALUES ('progression'); END;
      CREATE INDEX stats_kills ON mode_players(json_extract(stats_json, '$.pmcKilledPmc'));
      CREATE VIEW stats_view AS SELECT aid, json_extract(stats_json, '$.pvpStatsKnown') AS known FROM mode_players;`);
    const mode = db.prepare("INSERT INTO mode_players VALUES ('arena', ?, ?)");
    const progression = db.prepare("INSERT INTO progression_snapshots VALUES (?, ?)");
    for (let i = 0; i < 9; i++) {
      mode.run(i, largeStats(i)); progression.run(i, largeStats(i));
      db.prepare("INSERT INTO arena_mode_stats VALUES (?, 'overall', ?)").run(i, largeStats(i));
      db.prepare("INSERT INTO arena_mode_stats_history VALUES (?, 'overall', 1, ?)").run(i, largeStats(i));
    }
    db.prepare("INSERT INTO other_data VALUES (?, ?, NULL)").run(9007199254740993n, Buffer.from([0, 1, 0, 255]));
    db.exec("INSERT INTO changes(action) VALUES ('existing'); DELETE FROM changes; COMMIT");
  } finally { db.close(); }
  return { dir, source, output };
}

test("offline compaction preserves all decoded data, SQL projections, triggers, sequences and the original file", async () => {
  const f = await fixture();
  try {
    const originalFile = await readFile(f.source);
    const result = await compactStorage({ ...f, batchSize: 2 });
    assert.equal(result.sourceJournalMode, "delete");
    assert.equal(result.outputJournalMode, "delete");
    assert.equal(result.integrityCheck, "ok");
    assert.equal(result.coreSchemaUnchanged, true);
    assert.ok(result.arenaHistoryStorage.chunks > 0);
    assert.equal(result.tables.length, 4);
    assert.equal(result.tables.every((table) => table.changed === 9 && table.textBytesAfter < table.textBytesBefore), true);
    assert.deepEqual(await readFile(f.source), originalFile);
    const db = new DatabaseSync(f.output);
    try {
      assert.equal(db.prepare("PRAGMA journal_mode").get().journal_mode, "delete");
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM changes").get().n, 0);
      assert.equal(db.prepare("SELECT seq FROM sqlite_sequence WHERE name='changes'").get().seq, 1);
      assert.equal(db.prepare("PRAGMA application_id").get().application_id, 1234);
      assert.equal(db.prepare("PRAGMA user_version").get().user_version, 57);
      assert.deepEqual(db.prepare("SELECT aid FROM mode_players WHERE json_extract(stats_json, '$.pmcKilledPmc')=5").all().map((row) => row.aid), [5]);
      assert.equal(db.prepare("SELECT known FROM stats_view WHERE aid=2").get().known, 1);
      for (const row of db.prepare("SELECT aid, stats_json FROM mode_players").all()) {
        assert.equal(decodeStorageJsonText(row.stats_json), largeStats(row.aid));
      }
      const historyPayload = createArenaHistoryPayloadReader(db);
      for (const row of db.prepare("SELECT aid, raw_json FROM arena_mode_stats_history").all()) {
        assert.equal(historyPayload(row.raw_json), largeStats(row.aid));
      }
      db.exec("UPDATE mode_players SET stats_json=stats_json WHERE aid=2; UPDATE progression_snapshots SET stats_json=stats_json WHERE id=2");
      assert.deepEqual(db.prepare("SELECT id, action FROM changes ORDER BY id").all().map((row) => [row.id, row.action]), [[2, "mode"], [3, "progression"]]);
    } finally { db.close(); }
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("WAL compression and decompression publish self-contained copies with concurrent readers and writers", async () => {
  const f = await fixture();
  try {
    const source = new DatabaseSync(f.source);
    try { source.exec("PRAGMA journal_mode=WAL"); } finally { source.close(); }
    const originalFile = await readFile(f.source);
    const compressed = await compactStorage(f);
    const isolated = join(f.dir, "file-only-copies");
    await mkdir(isolated);
    const copyPublishedFile = async (name, path) => {
      const publishedFiles = await readdir(f.dir);
      assert.equal(publishedFiles.includes(`${name}-wal`), false);
      assert.equal(publishedFiles.includes(`${name}-shm`), false);
      const copy = join(isolated, name);
      await copyFile(path, copy); // Transfer only the published .db, never sidecars.
      return copy;
    };
    const compressedCopy = await copyPublishedFile("compressed.db", f.output);
    const legacy = join(f.dir, "legacy.db");
    const decompressed = await compactStorage({ source: f.output, output: legacy, decompress: true });
    const legacyCopy = await copyPublishedFile("legacy.db", legacy);
    assert.deepEqual(await readFile(f.source), originalFile);
    for (const [copy, report] of [[compressedCopy, compressed], [legacyCopy, decompressed]]) {
      assert.equal(report.sourceJournalMode, "wal");
      assert.equal(report.outputJournalMode, "wal");
      const readonly = new DatabaseSync(copy, { readOnly: true });
      try {
        assert.equal(readonly.prepare("PRAGMA quick_check").get().quick_check, "ok");
        assert.equal(decodeStorageJsonText(readonly.prepare("SELECT stats_json FROM mode_players WHERE aid=4").get().stats_json), largeStats(4));
      } finally { readonly.close(); }
      const reader = new DatabaseSync(copy);
      const writer = new DatabaseSync(copy);
      try {
        writer.exec("PRAGMA busy_timeout=0");
        reader.exec("BEGIN");
        assert.equal(reader.prepare("SELECT COUNT(*) AS n FROM mode_players").get().n, 9);
        // DELETE mode used to make this commit fail with SQLITE_BUSY while
        // the HTTP reader retained its snapshot. Do not set WAL in the test.
        writer.prepare("INSERT INTO mode_players VALUES ('pve', ?, ?)").run(100, largeStats(100));
        assert.equal(writer.prepare("SELECT COUNT(*) AS n FROM mode_players").get().n, 10);
        assert.equal(reader.prepare("SELECT COUNT(*) AS n FROM mode_players").get().n, 9);
        reader.exec("ROLLBACK");
        assert.equal(reader.prepare("SELECT COUNT(*) AS n FROM mode_players").get().n, 10);
        assert.equal(writer.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
      } finally { reader.close(); writer.close(); }
    }
    assert.equal((await readdir(f.dir)).some((name) => name.startsWith(".storage-compact-")), false);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("offline decompression produces a verified legacy-compatible copy and can compact mixed rows again", async () => {
  const f = await fixture();
  try {
    await compactStorage(f);
    const rollback = join(f.dir, "legacy.db");
    const result = await compactStorage({ source: f.output, output: rollback, decompress: true, batchSize: 3 });
    assert.equal(result.direction, "decompress");
    const db = new DatabaseSync(rollback, { readOnly: true });
    try {
      assert.equal(db.prepare("SELECT stats_json FROM mode_players WHERE aid=4").get().stats_json, largeStats(4));
      assert.equal(db.prepare("SELECT raw_json FROM arena_mode_stats_history WHERE aid=4").get().raw_json, largeStats(4));
      assert.equal(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='arena_history_payload_chunks'").get(), undefined);
    } finally { db.close(); }
    const mixed = new DatabaseSync(f.output);
    try { mixed.prepare("UPDATE mode_players SET stats_json=? WHERE aid=4").run(largeStats(4)); }
    finally { mixed.close(); }
    const next = await compactStorage({ source: f.output, output: join(f.dir, "again.db") });
    assert.equal(next.tables.find((table) => table.table === "mode_players").changed, 1);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("failed migration discards every staged file and leaves the source and existing output untouched", async () => {
  const f = await fixture();
  try {
    await writeFile(f.output, "existing operator file");
    await assert.rejects(compactStorage(f), /already exists/);
    assert.equal(await readFile(f.output, "utf8"), "existing operator file");
    await rm(f.output);
    const db = new DatabaseSync(f.source);
    try { db.prepare("UPDATE progression_snapshots SET stats_json=? WHERE id=6").run(Buffer.from("unexpected BLOB")); }
    finally { db.close(); }
    const originalFile = await readFile(f.source);
    await assert.rejects(compactStorage({ ...f, batchSize: 2 }));
    assert.deepEqual(await readFile(f.source), originalFile);
    assert.deepEqual(await readdir(f.dir), ["source.db"]);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("the native SQLite copy pins a consistent WAL snapshot while another connection commits", async () => {
  const f = await fixture();
  const writer = new DatabaseSync(f.source);
  try {
    writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
    writer.prepare("INSERT INTO mode_players VALUES ('pve', ?, ?)").run(20, largeStats(20));
    let committed = false;
    const result = await compactStorage({ ...f, onProgress(event) {
      if (event.phase === "copy" && !committed) {
        writer.prepare("INSERT INTO mode_players VALUES ('pve', ?, ?)").run(21, largeStats(21));
        committed = true;
      }
    } });
    assert.equal(committed, true);
    assert.equal(result.verifiedTables.find((table) => table.table === "mode_players").rows, 10);
    assert.equal(writer.prepare("SELECT COUNT(*) AS n FROM mode_players").get().n, 11);
  } finally { writer.close(); await rm(f.dir, { recursive: true, force: true }); }
});

test("corrupt encoded rows cannot be published as valid profiles", async () => {
  const f = await fixture();
  try {
    const encoded = encodeStorageJson(largeStats(1));
    const db = new DatabaseSync(f.source);
    try { db.prepare("UPDATE mode_players SET stats_json=? WHERE aid=1").run(encoded.replace(/sha256[^,]+/, 'sha256":"invalid"')); }
    finally { db.close(); }
    await assert.rejects(compactStorage(f));
    assert.deepEqual(await readdir(f.dir), ["source.db"]);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("interrupted offline conversion never publishes its partial copy", async () => {
  const f = await fixture();
  const controller = new AbortController();
  try {
    const originalFile = await readFile(f.source);
    await assert.rejects(compactStorage({ ...f, signal: controller.signal, onProgress(event) {
      if (event.phase === "table_done") controller.abort(new Error("operator interrupted"));
    } }), /operator interrupted/);
    assert.deepEqual(await readFile(f.source), originalFile);
    assert.deepEqual(await readdir(f.dir), ["source.db"]);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("custom SQL schema readers of unprojected fields are rejected before conversion", async () => {
  const f = await fixture();
  try {
    const db = new DatabaseSync(f.source);
    try { db.exec("CREATE VIEW unsupported_reader AS SELECT json_extract(stats_json, '$.futureField') FROM mode_players"); }
    finally { db.close(); }
    await assert.rejects(compactStorage(f), /Unsupported JSON schema reader in unsupported_reader/);
    assert.deepEqual(await readdir(f.dir), ["source.db"]);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("direct, length-based and implicit SQL readers cannot silently change their contract", async () => {
  const f = await fixture();
  try {
    const readers = [
      "CREATE VIEW raw_reader AS SELECT stats_json FROM mode_players",
      "CREATE VIEW raw_reader AS SELECT length(stats_json) AS n FROM mode_players",
      "CREATE VIEW raw_reader AS SELECT * FROM mode_players",
      "CREATE VIEW raw_reader AS SELECT DISTINCT * FROM mode_players",
      'CREATE VIEW raw_reader AS SELECT "p".* FROM mode_players AS p',
      "CREATE INDEX raw_reader ON mode_players(length(stats_json))",
      "CREATE TRIGGER raw_reader AFTER UPDATE ON mode_players BEGIN INSERT INTO changes(action) VALUES(NEW.stats_json); END",
    ];
    for (const ddl of readers) {
      const db = new DatabaseSync(f.source);
      try { db.exec(ddl); } finally { db.close(); }
      await assert.rejects(compactStorage(f), /Unsupported JSON schema reader in raw_reader/);
      const cleanup = new DatabaseSync(f.source);
      try { cleanup.exec(`DROP ${ddl.split(" ")[1]} raw_reader`); } finally { cleanup.close(); }
    }
    const db = new DatabaseSync(f.source);
    try { db.exec("CREATE VIEW pve_players AS SELECT * FROM mode_players WHERE mode = 'pve'"); }
    finally { db.close(); }
    const alias = new DatabaseSync(f.source);
    try { alias.exec("CREATE VIEW raw_reader AS SELECT * FROM pve_players"); } finally { alias.close(); }
    await assert.rejects(compactStorage(f), /Unsupported JSON schema reader in raw_reader/);
    const cleanup = new DatabaseSync(f.source);
    try { cleanup.exec("DROP VIEW raw_reader"); } finally { cleanup.close(); }
    await compactStorage(f);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("an oversized JSON row fails safely instead of filling a whole batch in memory", async () => {
  const f = await fixture();
  try {
    const db = new DatabaseSync(f.source);
    try { db.prepare("UPDATE mode_players SET stats_json=? WHERE aid=2").run(JSON.stringify({ huge: "x".repeat(13 * 1024 * 1024) })); }
    finally { db.close(); }
    await assert.rejects(compactStorage(f), /JSON row exceeds migration limit/);
    assert.deepEqual(await readdir(f.dir), ["source.db"]);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("native history JSON projections cannot bypass the chunk resolver", async () => {
  const f = await fixture();
  try {
    const db = new DatabaseSync(f.source);
    try { db.exec("CREATE VIEW unsupported_history AS SELECT json_extract(raw_json, '$.pmcKilledPmc') FROM arena_mode_stats_history"); }
    finally { db.close(); }
    await assert.rejects(compactStorage(f), /history payloads require a database resolver/);
    assert.deepEqual(await readdir(f.dir), ["source.db"]);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("a damaged shared chunk aborts conversion and cannot publish a legacy rollback copy", async () => {
  const f = await fixture();
  try {
    await compactStorage(f);
    const db = new DatabaseSync(f.output);
    try { db.exec("UPDATE arena_history_payload_chunks SET payload=zeroblob(length(payload))"); }
    finally { db.close(); }
    const rollback = join(f.dir, "rollback.db");
    await assert.rejects(compactStorage({ source: f.output, output: rollback, decompress: true }), /Arena history/);
    assert.deepEqual((await readdir(f.dir)).sort(), ["compressed.db", "source.db"]);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("large stored envelopes with small decoded values can be grouped without retaining their padding", async () => {
  const f = await fixture();
  try {
    const db = new DatabaseSync(f.source);
    try {
      db.exec("BEGIN");
      for (let aid = 0; aid < 9; aid++) {
        const envelope = JSON.parse(encodeStorageJson(largeStats(aid)));
        envelope.unusedPadding = "x".repeat(512 * 1024);
        db.prepare("UPDATE arena_mode_stats_history SET raw_json=? WHERE aid=?").run(JSON.stringify(envelope), aid);
      }
      db.exec("COMMIT");
    } finally { db.close(); }
    const report = await compactStorage({ ...f, batchSize: 64 });
    assert.ok(report.coreSchemaUnchanged);
    const result = new DatabaseSync(f.output, { readOnly: true });
    try {
      const read = createArenaHistoryPayloadReader(result);
      for (const row of result.prepare("SELECT aid,raw_json FROM arena_mode_stats_history").all()) {
        assert.equal(read(row.raw_json), largeStats(row.aid));
      }
    } finally { result.close(); }
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

for (const [name, select] of [
  ["line-comment literal", "'--' AS label, json_extract(stats_json, '$.futureField') AS value"],
  ["block-comment literals", "'/*' AS label, json_extract(stats_json, '$.futureField') AS value, '*/' AS suffix"],
  ["quoted identifier", '1 AS "--", json_extract(stats_json, \'$.futureField\') AS value'],
]) {
  test(`comment-like SQL ${name} cannot hide an unsupported JSON reader`, async () => {
    const f = await fixture();
    try {
      const db = new DatabaseSync(f.source);
      try {
        db.exec(`CREATE VIEW unsupported_literal AS SELECT ${select} FROM mode_players`);
        assert.notEqual(db.prepare("SELECT value FROM unsupported_literal LIMIT 1").get().value, null);
      } finally { db.close(); }
      const original = await readFile(f.source);
      await assert.rejects(compactStorage(f), /Unsupported JSON schema reader in unsupported_literal/);
      assert.deepEqual(await readFile(f.source), original);
      assert.deepEqual(await readdir(f.dir), ["source.db"]);
    } finally { await rm(f.dir, { recursive: true, force: true }); }
  });
}
