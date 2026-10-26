# Regular cohort worker

A long-lived, single-threaded Rust worker for the existing Regular comparison
cohort calculation. The Node parent owns HTTP validation, caching, the bounded
FIFO, timeouts and process restart. This binary opens `SQLITE_PATH` (default
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
Only protocol version 1 and positive safe integer IDs are accepted. The job is
restricted to `persistent` / `regular`; PvE, Seasonal, Arena and risk calculations
stay with their existing implementations.

The job arguments are hours, PMC raids, excluded account ID, dimension,
statistic, period and optional player metrics, matching `PlayerStore.cohort2d`.
The last four arguments default to hours, trimmed_mean, all and absent metrics.
Omitted or null optional arguments preserve JavaScript undefined defaults.
Regular selection always uses the last 90 days, including when period is all,
as required by the existing implementation. Invalid or negative player metric
values become absent evidence rather than an error or a zero.

## Calculation and storage

Each request opens a read transaction over the existing covering-index queries.
The same eligible population, owner/tombstone exclusions and 10/15/20/30 percent
windows determine the selected cohort. Below 20 matched players the calculation
uses the eligible population. All selected metric values are read once, then
sorted and aggregated in Rust, replacing the SQL materialization and per-metric
sorts. The vectors are released after every request. Their aggregate capacity is
limited to 128 MiB, with geometric checked allocation. Exceeding this budget
returns an explicit error; rows are never silently truncated. Roughly two
million fully populated rows fit, depending on vector capacity growth. This
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
