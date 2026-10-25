# SQLite statistics storage

`mode_players.stats_json`, `progression_snapshots.stats_json` and
`arena_mode_stats.raw_json` accept ordinary JSON objects and the version 1
compressed envelope implemented in `lib/storage-json.ts`. Arena history also
supports database-backed groups described below. No historical rows are removed,
and no database migration
runs when an application process starts. Runtime writes remain plaintext unless
`STORAGE_JSON_COMPRESSION=true` is explicitly enabled through the existing
service environment files. With that flag, writes choose compression only when
the envelope saves space. Small/noncanonical legacy values remain unchanged.

The envelope is still valid JSON text. Its reserved `__tarkovstats_storage`
property identifies the codec, version, SHA-256 and gzip/base64 payload. The payload
contains the complete original UTF-8 JSON text, including unknown fields. The
decoder validates the checksum, decompression limit and SQL projections before
returning it. Readers of the standalone columns must use
`decodeStorageJson()` or `decodeStorageJsonText()`; a direct `JSON.parse()` reads
the storage envelope rather than the full statistics object.

The top-level scalar projections in `STORAGE_JSON_PROJECTION_KEYS` preserve the
existing SQLite JSON queries without a custom SQLite extension. Missing fields,
explicit nulls, booleans and numbers retain their JSON types. Adding a SQL query
for a different field requires an explicit compatibility change: existing
compressed rows will not have a new projection automatically. Text containing
duplicate keys or other noncanonical spelling is kept plain because SQLite and
JavaScript can disagree on which duplicate value to select.

## Grouped Arena history

Offline conversion can pack up to 64 exact `arena_mode_stats_history.raw_json`
strings together. The serialized UTF-8 JSON array, including escaping, is limited
to 1 MiB. Groups are gzip-compressed into the private
`arena_history_payload_chunks` table in the **same SQLite database**. History rows
keep their normalized columns and keys; `raw_json` becomes a versioned JSON
reference containing the chunk SHA-256, array index and reference checksum.

Use `createArenaHistoryPayloadReader(db, { schema })` for history payloads. It
accepts legacy plaintext, standalone envelopes and grouped references, checks
every referenced chunk/index/checksum, and bounds its cache to 8 MiB and 64
entries. Generic `decodeStorageJson*` deliberately rejects a group reference
without its database resolver. Native SQL readers of historical `raw_json` are
unsupported; normalized history columns remain directly queryable.

Backfill and ban archival resolve groups using the same database connection and
transaction as their source rows. Portable ban archives store original plaintext
JSON, so they remain independent of the source's chunk table. Groups are immutable;
offline conversion removes unreferenced chunks. Runtime writes retain the
standalone format, so periodic offline grouping is needed to maintain the same
compression ratio as history grows. No new timer or live packing job is installed.

## Deployment compatibility

Deploy the dual-reader release with compressed writes disabled first. Before
enabling the flag or installing a converted database, ensure that every reader,
worker and the recorded rollback image supports both standalone and grouped
formats. An older image
cannot read compressed rows, including rows written before any bulk conversion.
Turning the flag off stops new compressed writes; it does not decompress rows
already stored. This rollout boundary is explicit because deployments can
automatically roll back an unhealthy image.

## Verified offline conversion

`npm run storage:compact -- --source SOURCE.db --output NEW.db` creates a new
compressed copy. `--decompress` creates a copy compatible with readers that only
understand ordinary JSON. The tool refuses existing destinations and never
replaces the source. Use a complete verified backup on an offline machine with
enough free disk; this is not a live production migration command.

The tool uses the native SQLite backup API under a read transaction, rewrites
only the selected JSON columns in an isolated staging file, restores the original
trigger definitions, and runs VACUUM and integrity_check. It compares every core
table's row count and SHA-256 of all logical values in deterministic order,
decoding only the changed JSON representation. This also verifies queues,
revision counters, change journals and sqlite_sequence. The source file and its
backup remain the rollback material. Interrupted staging files are never valid
conversion outputs and must not be installed. Batches contain row identifiers;
JSON values are loaded one at a time with a 12 MiB per-row migration limit.
The schema preflight refuses unsupported JSON readers that would require fields
outside the stored projections. The core schema and triggers must remain identical.
The private chunk table is expected storage metadata, so `schemaUnchanged` may be
false while `coreSchemaUnchanged` is true. Its referenced data is verified through
the resolved history values, not by comparing physical chunk layouts.

The preflight requires three times the source database size plus 1 GiB of free
space for the copied database, rollback journal and VACUUM temporary data. Do not
run conversion against the almost-full production volume. Replacing production
files requires a separate coordinated maintenance window with all writers and
readers closed; an offline conversion result alone does not capture subsequent
production writes. Before returning to an older application image, use verified
plaintext databases or an independently verified decompressed copy. Decompression
resolves all history references and removes the private chunk table. Keep and
transfer the whole SQLite database together; copying the history table alone
would separate references from their payloads.

## Backup capacity

The backup format remains five independently verified SQLite `.db.gz` files and
a `.complete` marker. Each archive is produced from a consistent `VACUUM INTO`
snapshot, never from a raw live database file. A player snapshot also streams all
Arena history values through the resolver, rejecting missing or corrupt chunks
before publication. The last verified set is retained
until the entire new set passes verification. The runtime free-space guard
preserves 1 GiB while gzip writes the output. Archive files, the completion
marker and directory entries are synced before an older verified set is removed.

Preflight includes the database size plus WAL, the last completed archive's size
as an estimate of the next archive, and the reserve. The estimate is not a bound
on future compression ratio; the runtime guard remains authoritative. Storage
compression lowers the temporary snapshot size after an offline conversion and
compaction, but free pages inside an existing SQLite file are not immediately
returned to the filesystem.
