# SQLite statistics storage

`mode_players.stats_json`, `progression_snapshots.stats_json`,
`arena_mode_stats.raw_json` and `arena_mode_stats_history.raw_json` accept both
ordinary JSON objects and the version 1 compressed JSON envelope implemented in
`lib/storage-json.ts`. No historical rows are removed, and no database migration
runs when an application process starts. Runtime writes remain plaintext unless
`STORAGE_JSON_COMPRESSION=true` is explicitly enabled through the existing
service environment files. With that flag, writes choose compression only when
the envelope saves space. Small/noncanonical legacy values remain unchanged.

The envelope is still valid JSON text. Its reserved `__tarkovstats_storage`
property identifies the codec, version, SHA-256 and gzip/base64 payload. The payload
contains the complete original UTF-8 JSON text, including unknown fields. The
decoder validates the checksum, decompression limit and SQL projections before
returning it. All application readers of these columns must use
`decodeStorageJson()` or `decodeStorageJsonText()`; a direct `JSON.parse()` reads
the storage envelope rather than the full statistics object.

The top-level scalar projections in `STORAGE_JSON_PROJECTION_KEYS` preserve the
existing SQLite JSON queries without a custom SQLite extension. Missing fields,
explicit nulls, booleans and numbers retain their JSON types. Adding a SQL query
for a different field requires an explicit compatibility change: existing
compressed rows will not have a new projection automatically. Text containing
duplicate keys or other noncanonical spelling is kept plain because SQLite and
JavaScript can disagree on which duplicate value to select.

## Deployment compatibility

Deploy the dual-reader release with compressed writes disabled first. Before
enabling the flag or installing a converted database, ensure that every reader,
worker and the recorded rollback image supports this format. An older image
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
trigger definitions, and runs VACUUM and integrity_check. It compares every
table's row count and SHA-256 of all logical values in deterministic order,
decoding only the changed JSON representation. This also verifies queues,
revision counters, change journals and sqlite_sequence. The source file and its
backup remain the rollback material. Interrupted staging files are never valid
conversion outputs and must not be installed. Batches contain row identifiers;
JSON values are loaded one at a time with a 12 MiB per-row migration limit.
The schema preflight refuses unsupported JSON readers that would require fields
outside the stored projections.

The preflight requires three times the source database size plus 1 GiB of free
space for the copied database, rollback journal and VACUUM temporary data. Do not
run conversion against the almost-full production volume. Replacing production
files requires a separate coordinated maintenance window with all writers and
readers closed; an offline conversion result alone does not capture subsequent
production writes. Before returning to an older application image, use verified
plaintext databases or an independently verified decompressed copy.

## Backup capacity

The backup format remains five independently verified SQLite `.db.gz` files and
a `.complete` marker. Each archive is produced from a consistent `VACUUM INTO`
snapshot, never from a raw live database file. The last verified set is retained
until the entire new set passes verification. The runtime free-space guard
preserves 1 GiB while gzip writes the output.

Preflight includes the database size plus WAL, the last completed archive's size
as an estimate of the next archive, and the reserve. The estimate is not a bound
on future compression ratio; the runtime guard remains authoritative. Storage
compression lowers the temporary snapshot size after an offline conversion and
compaction, but free pages inside an existing SQLite file are not immediately
returned to the filesystem.
