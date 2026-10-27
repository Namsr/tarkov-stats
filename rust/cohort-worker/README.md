# Cohort worker

A long-lived, single-threaded Rust worker for Regular, PvE, Seasonal and Arena
comparison cohorts and Arena population statistics. The Node parent owns HTTP validation, caching,
the bounded FIFO, timeouts and process restart. This binary opens `SQLITE_PATH` (default
`/data/players.db`) read-only and never initializes or changes the schema.

Build and check from the repository root:

```sh
cargo test --locked --manifest-path rust/cohort-worker/Cargo.toml
cargo build --release --locked --manifest-path rust/cohort-worker/Cargo.toml
```

The executable is `rust/cohort-worker/target/release/tarkov-cohort-worker`
(`.exe` on Windows). A C compiler is required for the bundled SQLite build.

## Protocol

stdin and stdout carry one UTF-8 JSON value per newline. stdout contains only
replies; diagnostics belong on stderr. EOF shuts the worker down. The maximum
request frame is 64 KiB including its newline; oversized frames are discarded
through the next newline without retaining the whole input.

```json
{"version":1,"id":1,"args":[{"kind":"persistent","mode":"regular","args":[100,100,123,"hours","median","all",{"kd_ratio":2}]}]}
```

A successful response is `{"id":1,"result":<ComparisonCohortResult>}`. Failures
return `{"id":1,"error":"..."}`. Invalid/unrecoverable request IDs are `null`.
Only protocol version 1 and positive safe integer IDs are accepted.

Supported jobs are `persistent` (`regular`/`pve`), `arena` (cohort),
`arena_population` (the complete Arena average result) and `seasonal` (cohort).
The last three omit the top-level `mode` property. Their argument arrays match
`getArenaCohort`, `getArenaAverage` and `computeSeasonalComparisonCohort`.
Seasonal requires its explicit second `now` argument. `seasonal_average`,
`average_metrics`, baselines and risk jobs remain in TypeScript.

For `persistent` jobs, arguments are hours, PMC raids, excluded account ID, dimension,
statistic, period and optional player metrics, matching `PlayerStore.cohort2d`.
The last four arguments default to hours, trimmed_mean, all and absent metrics.
Omitted or null optional arguments preserve JavaScript undefined defaults.
Regular selection always uses the last 90 days, including when period is all,
as required by the existing implementation. PvE respects `all` or `90d` and
includes peers with unknown PvP statistics. `pmc_kd_ratio` includes only peers
with known PvP; `killed_pmc_per_raid` additionally requires parser version 1.
Invalid or negative player metric values become absent evidence rather than
an error or a zero.

## Calculation and storage

Each request opens a read transaction over normalized scalar columns.
Regular uses `players` / `idx_players_cohort`. PvE uses `mode_players` /
`idx_mode_players_cohort` with `mode = pve`; all identifiers come from a trusted
mode enum. Neither reader accesses `stats_json`. Equal account IDs in different
modes cannot mix their cohort populations or results.

The same eligible population, owner/tombstone exclusions and 10/15/20/30 percent
windows determine the selected cohort. Below 20 matched players, persistent and Seasonal calculations
use their eligible population; named Arena modes never fall back. Arena overall
always uses its eligible population. All selected metric values are read once, then
sorted and aggregated in Rust, replacing the SQL materialization and per-metric
sorts. The vectors are released after every request. Their aggregate capacity is
limited to 128 MiB, with geometric checked allocation. Exceeding this budget
returns an explicit error; rows are never silently truncated. Roughly two
million fully populated persistent rows fit, depending on capacity growth.
Arena averages also hold bucket samples and fit fewer rows. This
limit covers vector capacity, not total RSS; SQLite and runtime memory are
additional. Use the TypeScript backend for populations exceeding this limit.

Metric nullability, sparse survival samples, parser-version eligibility,
5-percent trimming, median selection, percentile ties and response metadata
follow `lib/db.ts` and `lib/profile-cohort.ts`. Float parsing preserves f64
round trips. Compensated floating summation avoids ordinary accumulation error;
parity checks still allow roundoff between SQLite and Rust while requiring
identities, selection, counts, nulls and boundaries to match exactly.

The database connection is reused, with a 250 ms busy timeout. No results or
population rows are cached inside the worker; subsequent requests observe new
committed database state. Both the database and any SQLite WAL sidecars must be
accessible to the runtime user on the same host.

Arena reads `arena_mode_stats` in the players database, uses the current parser
version 5, and preserves its separate target/peer match thresholds and raw
proportional bounds. Finite zero and negative metric values remain samples;
TEXT, BLOB and nonfinite values are unknown. Arena population results include
all metric summaries, buckets, coverage, ranges and global population counts.

Seasonal reads a separate lazy connection using `PROGRESSION_SQLITE_PATH`, then
`PROGRESSION_DB_PATH`, then `/data/progression.db`. All queries bind the cycle.
Its target may be excluded while peers cannot be; survival zero remains valid
and percentile distributions remain empty. Target conversion preserves the
TypeScript `Number()` behavior while NULL/invalid targets remain unavailable.

Native storage must already be initialized by the existing TypeScript setup.
The native worker never creates databases, migrates schema or falls back to
writes. Missing/uninitialized Seasonal storage returns
`{ "available": false, "result": null }`; Arena returns `null`. This deliberately
differs from TypeScript's first-ever lazy creation of an empty database. Failed
opens/readiness checks are not retained, so a later external initialization is
visible without restarting. Errors after established readiness remain errors.
The players and progression handles fail independently.
