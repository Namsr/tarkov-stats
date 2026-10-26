# Isolated Linux cohort comparison

The primary acceptance criterion is full API latency. CPU and memory counters
are separate measurements and do not substitute for a latency improvement.
All four comparison modes remain opt-in; this benchmark changes no
production backend flags, timers, deployment or database files.

## Reproducible workload

After building the production image, on a Linux machine with local Docker:

```sh
bash scripts/benchmark-rust-container.sh tarkovstats-web:REVISION /tmp/new-results
```

The script refuses an existing destination and a remote Docker endpoint. It
forces the local default Docker context, never pulls an image, and runs sixteen
fresh containers: two repetitions of Regular, PvE, Arena and Seasonal for each TypeScript/Rust
backend. The second repetition reverses backend order. Each container receives
its own fixture, process tree, response cache and cgroup, avoiding cumulative
parent high-water marks between backend runs. OS page caches are not flushed.

Defaults are 30,000 deterministic peer rows and 20 requests per scenario.
`BENCHMARK_ROWS`, `BENCHMARK_ITERATIONS`, and `BENCHMARK_ROUNDS` can change these
for deliberate experiments; the Node benchmark validates rows/iterations and
the wrapper restricts repetitions to 1-3. No output or source file is overwritten.

Each container uses the built Node/Alpine production image, including its Rust
binary and application libraries. Read-only bind mounts supply the API-handler
source and benchmark fixtures omitted from the runtime image. The adapter imports
the actual NextRequest/NextResponse classes from the traced Next.js internals:
standalone tracing omits the public `next/server.js` export wrapper. No request
or response class is replaced with a test double. They contain no
production data. Synthetic SQLite files exist only in a private 128 MiB tmpfs.
There are no published ports, production volumes, env files or external network.
Loopback HTTP remains inside each container.

Each workload has 0.5 CPU, a 384 MiB memory limit with no extra swap, read-only
root filesystem, no capabilities, no-new-privileges and at most 128 tasks.
The image's unprivileged user is retained. These deliberately constrained CI
conditions are not identical to the live VPS web container or its workload.
No production resource settings are changed.

The actual cohort GET handlers execute target-snapshot reads, cache lookup,
shared FIFO, TypeScript or native worker, SQLite and JSON serialization. Each
miss asserts one job on the requested backend; each hit asserts zero jobs.
Sequential and four-owner concurrent batches cover matched/population selection,
median and trimmed mean. Arena's matched scenario uses `lastHero`; its population
scenario uses `overall`, whose contract is population-only. Named Arena modes
retain their no-fallback behavior. The separate dynamic Arena-average contract
is covered by differential tests, not by these cohort timing series. Seasonal
uses its own progression database and an enabled synthetic cycle. These timing
series use period `all`; differential tests separately cover `90d`, cycle
isolation, unknown metrics, exclusions and selection boundaries.

Seasonal server times come from its existing structured request diagnostics
because that route has no Server-Timing header. The other three modes use their
Server-Timing total. These are different server scopes and are labeled in each
report; missing timings must not be interpreted as zero time. Fixture generation and resource sampling are outside
API latency measurements. A first request with a fresh worker is separate.
The harness excludes Next production routing, TLS/CDN, user network, browser
rendering and upstream Tarkov API. It is an API-handler benchmark, not a live
website load-time test. No relative speed threshold is asserted.

## Counters and evidence

The host validator checks effective Docker limits, network/rootfs/user/mounts,
exit status and OOM state. The report independently checks cgroup v2's effective
CPU quota, memory and swap limits and OOM counter. Missing cgroup/child counters
fail this Linux experiment instead of becoming fabricated zero measurements.
The normal cross-platform benchmark still reports unsupported counters as unavailable.

Warm child CPU excludes fixture generation and the cold request. Child working
set/peak is a process measurement. Whole-cgroup CPU and memory.peak include
fixture generation, parent, workers, tmpfs/page cache and other setup through
the final snapshot before process termination. Cgroup charged memory is not
process RSS. The whole-cgroup lifetime scope is appropriate for comparing these
fresh containers but does not isolate only the timed API operations.

Each repetition is listed independently. Medians/p95 from separate series are
not averaged into an invented aggregate percentile. Twenty requests per series
and two repetitions still provide a small sample. Shared-runner contention,
OS file caching and fixture distribution limit generalization to production.

CI stores individual reports, Docker inspection metadata, stderr logs and
summary JSON/Markdown in the `rust-linux-benchmark-COMMIT` artifact for 14 days.
The GitHub job step summary shows latency and resource tables. An interrupted
or failed workload remains a failed check with available diagnostic files;
cleanup removes only that script's named active container.

The resource definitions follow the [Docker resource documentation](https://docs.docker.com/engine/containers/resource_constraints/)
and the [kernel cgroup v2 interface](https://docs.kernel.org/admin-guide/cgroup-v2.html).

## Rollout boundary

A clean benchmark validates the harness, workload correctness and configured
resource bounds; it does not establish that Rust is faster for every scenario.
Compare p50/p95 and errors first, then child and total-resource measurements.
Treat an improvement in worker CPU alone as insufficient to activate a backend.
The native opt-in requires both existing databases and current schemas to have
been initialized through TypeScript. Read-only Rust never creates/migrates them;
uninitialized Arena/Seasonal storage reports unavailable instead of performing
TypeScript's first-ever lazy bootstrap. Defaults remain TypeScript.

Representative VPS observations and coordination with the maintenance owner
remain necessary before any production activation. A user-disabled deployment
timer stays disabled unless the user explicitly changes that instruction.
