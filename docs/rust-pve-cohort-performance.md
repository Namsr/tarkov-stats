# PvE cohort Rust pilot

2026-10-26. Base: `379e612` (main after #476). This extends the existing native
comparison worker to PvE while retaining TypeScript as the default for both modes.
The primary criterion is full API latency. CPU and memory are secondary measurements.

## Scope and rollout

`PVE_COHORT_BACKEND=rust` opts PvE comparisons into the bundled native worker;
`typescript` restores the existing implementation without a database migration.
`REGULAR_COHORT_BACKEND` remains independent. Arena, Seasonal, risk, baseline and
population-average jobs keep their existing implementation. Both transports use
one bounded FIFO with the existing deadlines and only one active calculation.

PvE reads normalized scalar columns from `mode_players` with `mode='pve'`; it
never decodes `stats_json` and cannot include Regular or Arena rows with the same
AID. Unlike Regular, PvE honors `all` vs `90d` and includes unknown-PvP players
in the peer group. Per-metric known-PvP/parser requirements remain unchanged.
The native process remains read-only; its 128 MiB limit covers aggregate vector
capacities rather than the entire process or container RSS.

An earlier read-only production observation on `63f9416` found 101 PvE cohort
cache misses in the last-hour/tail-8000 log sample: request p50 80 ms, p95 757 ms.
Stored-profile PvE p95 was 17 ms. This supported investigating comparisons;
it is not a before/after experiment or a measurement of browser/network latency.

## Synthetic API comparison

```sh
npm run rust:build
npm run benchmark:rust-cohort -- --mode pve --rows 30000 --iterations 20 --output docs/rust-pve-cohort-benchmark.json
```

The benchmark runs the actual cohort GET handler behind a loopback HTTP adapter,
including target snapshot reads, caches, shared queue, child transport, SQLite,
aggregation and JSON parsing. Thirty thousand deterministic peer rows and eight
saved owner snapshots keep it offline; any upstream fetch fails. Each cache-miss
series asserts one worker job per request. Hit series assert zero worker jobs.
Memory and durable caches are cleared before each miss request/batch; concurrent
batches use four distinct owners to prevent request deduplication hiding work.

Warm-worker cache-miss HTTP latency in milliseconds, 20 requests per cell:

| Group / statistic | Concurrent requests | TS p50 | Rust p50 | TS p95 | Rust p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| matched / median | 1 | 287.744 | 225.410 | 342.795 | 309.347 |
| matched / median | 4 | 653.985 | 483.810 | 1120.770 | 999.993 |
| matched / trimmed_mean | 1 | 242.599 | 267.220 | 306.270 | 308.997 |
| matched / trimmed_mean | 4 | 805.706 | 642.165 | 1388.815 | 1350.334 |
| population / median | 1 | 381.877 | 260.083 | 536.801 | 350.680 |
| population / median | 4 | 941.244 | 600.727 | 1570.939 | 1292.473 |
| population / trimmed_mean | 1 | 442.366 | 300.861 | 583.423 | 392.818 |
| population / trimmed_mean | 4 | 911.577 | 900.091 | 1416.284 | 1316.798 |

Sequential population fallback p50 fell about 32% in this sample; p95 fell about
33-35%. The matched trimmed-mean p50 increased from 242.599 to 267.220 ms.
Concurrent improvements varied, and population trimmed-mean p50 barely changed.
This does not establish a universal API speedup. Cache hits bypass both workers;
their variation is not attributable to native aggregation.

The environment was Windows 10.0.26200, Ryzen 7 5800X3D (16 logical CPUs),
Node 24.19.0, Rust 1.98.1, Node SQLite 3.53.3 and Rust bundled SQLite 3.54.1.
TypeScript ran before Rust on the same file with warm OS file caches. No other
project test/build ran during the timed workload; desktop background activity
was not controlled. Twenty samples give a rough p95, not a stable production
estimate. Aggregation moved from SQLite metric sorts to Rust vectors as well as
changing language, so the gain is not attributed solely to the Rust compiler.

This excludes production Next routing, TLS/CDN/proxy, network to users, browser
rendering, external Tarkov API and VPS memory/CPU/I/O limits. The full report is
[rust-pve-cohort-benchmark.json](rust-pve-cohort-benchmark.json). The previous
[Regular measurement](rust-cohort-performance.md) remains a separate sample.

## CPU and memory

Process counters are read outside timed requests using Windows process counters
or Linux `/proc`. CPU is cumulative user+kernel execution time, not elapsed wall
time, number of tokens, latency or a Docker CPU percentage. Snapshots surround
the complete warmup/miss/hit series after the cold request and before the worker
stops. Fixture generation and cold startup are excluded from the CPU delta.
Each backend had one measured child, and PID/name continuity was verified.

| Worker measurement | TypeScript | Rust |
| --- | ---: | ---: |
| CPU time for the warm workload | 14.53125 s | 2.18750 s |
| Child lifetime peak working set | 105.039 MiB | 10.473 MiB |

These are child-process measurements for this workload. Peak working set is the
child's lifetime high-water mark, including startup; it is not a simultaneous
peak of parent+workers or a container limit. Parent high-water marks are
cumulative across the two series and must not be compared as independent runs.
The benchmark records parent CPU/RSS separately and marks unsupported counters
or restarted workers unavailable rather than fabricating zero measurements.
Mixed traffic can also retain an idle Node worker. No claim is made that total
VPS CPU or RSS decreases by the same factor.

## Correctness and decision

Rust unit tests cover mode isolation, period filtering including NULL dates,
tombstones, parser eligibility and metric coverage. Native/TS parity covers
matched/population paths, bounds, sparse metrics, later writes and both flags.
Only final calculated floating values permit relative rounding error 1e-12;
identity, selection, counts, nulls and distribution metadata remain exact.
The resource integration test exercises real worker counters on Windows/Linux.

Keep the mode flags on TypeScript by default. Before enabling on the VPS,
compare representative Linux/Node 22 data under the actual resource limits,
including mixed modes and concurrent writes. Check full request p50/p95,
errors and parent+child/container RSS. API latency remains the acceptance
criterion; lower worker CPU alone is insufficient to justify a rollout.
