# Regular cohort Rust pilot

Measured on 2026-10-26 against main revision `63f9416`. Rust is opt-in:
`REGULAR_COHORT_BACKEND=rust`; the default remains `typescript`.
This change covers Regular two-dimensional comparison cohorts only.

## Local API measurements

Command:

```sh
npm run rust:build
npm run benchmark:rust-cohort -- --rows 30000 --iterations 12 --output docs/rust-cohort-benchmark.json
```

The benchmark sends HTTP requests over loopback to the actual
`app/api/average/cohort/route.ts` GET handler. It includes stored-profile reads,
cache lookup, the shared FIFO, child transport, SQLite reads, aggregation and
JSON response parsing. Eight stored owner snapshots prevent upstream fetches;
any external fetch fails the benchmark. Fixture creation is excluded.

The machine used Windows 10.0.26200, Ryzen 7 5800X3D (16 logical CPUs),
Node 24.19.0, Rust 1.98.1 and Node SQLite 3.53.3. Rust uses bundled SQLite 3.54.1.
There are 30,000 synthetic peer rows with varied metric values. Both backends
read the same file, in TypeScript-then-Rust order. OS page caches are warm and
not flushed. The production image uses Linux / Node 22, so these are not VPS
measurements. No other task test/build was deliberately run during this sample;
normal desktop background activity was not controlled.

HTTP latency with a warm worker and a cache miss, milliseconds:

| Group / statistic | Concurrent requests | TS p50 | Rust p50 | TS p95 | Rust p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Matched / median | 1 | 273.001 | 259.515 | 485.261 | 350.909 |
| Matched / trimmed mean | 1 | 260.143 | 268.023 | 335.044 | 610.334 |
| Population / median | 1 | 384.648 | 276.496 | 459.437 | 302.768 |
| Population / trimmed mean | 1 | 401.207 | 284.313 | 526.250 | 368.200 |
| Matched / median | 4 | 757.005 | 559.563 | 1273.360 | 1067.401 |
| Matched / trimmed mean | 4 | 627.093 | 543.774 | 1175.976 | 1284.496 |
| Population / median | 4 | 666.115 | 534.848 | 1117.700 | 1342.637 |
| Population / trimmed mean | 4 | 759.025 | 522.197 | 1578.804 | 959.292 |

Each table cell has 12 requests; this p95 is the sample maximum and is not a
stable production percentile estimate. There were no non-200 responses or
unexpected group strategies. Every miss produced one actual worker job.
Both memory and durable response caches were cleared before each sequential
request or batch of four distinct owners, avoiding hidden cache hits and deduplication.

Population fallback had about 28-29% lower sequential HTTP p50 in this sample.
Its observed worker p50 decreased from 152 to 19 ms for median and from 144 to
19 ms for trimmed mean. These phase measurements include IPC and delivery back
to the parent event loop; they are not isolated CPU timings. Parent synchronous
work can delay delivery, especially for concurrent requests.

A first matched request with a fresh worker took 775.942 ms for TypeScript and
284.496 ms for Rust. This is one sample per backend; route imports, schemas and
file caches were already initialized. It is not a cold application startup test.

Cache hits bypassed both workers (verified: zero jobs per hit series). Their p50
varied from 625-1191 ms for TS series and 634-1091 ms for Rust series with four
concurrent requests. This variability and several p95 regressions prevent a
claim that Rust improves every API request. Stored reads, cache handling,
analytics writes and other parent work still contribute to the measured path.
No causal timing breakdown for those costs is claimed here.

The full machine-readable results are in
[rust-cohort-benchmark.json](rust-cohort-benchmark.json).
The sample excludes the production Next server/router, proxy/CDN/TLS, user
network, browser rendering, Tarkov API, production data and VPS resource limits.
It does not measure peak RSS, CPU consumption or energy use.

## Correctness and operational limits

The same target player, exclusions, recent-profile eligibility and expanding
10/15/20/30 percent windows select the cohort. If fewer than 20 peers match,
Regular falls back to the eligible population, exactly as before. Rust then
sorts the selected metric vectors instead of asking SQLite to materialize and
sort each metric. This changes the aggregation implementation as well as the
language; the measured gain must not be attributed solely to Rust.

Parity tests compare native and TypeScript workers on the same SQLite fixture:
identity, selection, ranges, counts, nulls, ties, sample thresholds, sparse
metrics, signed zero, owner/tombstone exclusions, recency and later committed
writes. Only final floating averages and percentiles permit relative rounding
error of 1e-12; their counts and distribution metadata remain exact.

The two backends share one FIFO, at most eight admitted jobs, one active job,
and the existing 15-second execution/end-to-end budgets. Switching transports
reuses idle processes; idle handles do not keep CLI callers alive. Tests cover
mixed admission, timeouts, crashes, corrupt frames and recovery. Rust vector
capacity has a checked aggregate limit of 128 MiB, not a total RSS guarantee.
Exceeding it returns an error without truncating the population. SQLite cache,
allocator overhead, the Node parent and an idle TS worker consume additional
memory. Larger populations can use the TS switch until separately evaluated.

Rust opens the database read-only and takes a read transaction per job.
It performs no schema changes, stored-result writes or upstream requests. The
existing API handles compute errors; automatic cross-backend retry is avoided.
The image includes the native binary, but existing deployments retain TS until
explicitly configured. Changing the switch back needs no database migration.

## Rollout decision

Keep TypeScript as the default for this pilot. Before changing the deployment
setting, repeat on Linux / Node 22 with representative profile counts and mixed
Regular/Arena/Seasonal traffic under the existing VPS memory/CPU limits. Compare
full-route p50/p95 and errors separately for hits/misses, include writer
contention, and measure peak process/container RSS. Only enable Rust if the
relevant latency improves without increased errors or memory pressure.

## Validation

Local checks passed: Rust unit tests (12), rustfmt, clippy with warnings denied,
TypeScript, i18n (2,061 matching keys), production Next build, production npm
audit and targeted native/Node worker, parity, API identity and test-registry
checks. ESLint has no errors; the existing HomeComparison navigation warning
remains outside this change.

The full Windows `npm test` run completed its pretest groups, then two existing
analytics initialization subprocess probes exceeded their 20-second deadlines.
The main run was stopped rather than reported as passing. Their source files
and implementation are unchanged in this branch. The same two probes extracted
from origin/main passed separately in about 16.5 seconds each on this machine;
this leaves little margin under parallel Windows load. Full Linux / Node 22 CI
and the Alpine image smoke test remain required before merging.
