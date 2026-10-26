# Rust HTTP backend migration

## Target and current slice

All application logic is to move to Rust: HTTP API, auth and mutations, storage
and migrations, integrations and background jobs, and frontend rendering/client
behavior. HTML, CSS, SQL and assets stay in suitable formats. The final
architecture must not require Node.js/Next.js. This slice does not complete that
migration: it replaces one full public HTTP endpoint, `/api/seasonal/cohort`.

The primary outcome is lower API p50/p95 and time until useful data appears.
CPU/memory/I/O reduction is secondary and measured separately. Rust source or
lower worker CPU alone is not proof of a faster working site.

Rust owns query parsing, the Seasonal rollout gate, bounded LRU and single-flight,
stale-while-revalidate, durable cache interoperability, the bounded killable Rust
compute child, HTTP status/body/headers and best-effort analytics. Next remains
for the UI and other APIs during migration. There are currently 72 API route
files; auth/session/origin policies, collectors, schema ownership and the frontend
are subsequent migration stages rather than hidden TypeScript dependencies that
can be declared complete.

## HTTP and data compatibility

The API preserves first duplicate query values, supported numeric/profile-URL
account IDs, cycle normalization, parameter defaults and validation order. It
preserves 400/404/503 envelopes, identity, successful JSON, cache generation/stale
headers and `percentiles:null`. No CORS wildcard, cookie or auth behavior is added.
The full HTTP boundary also checks HEAD, OPTIONS, 405 and trailing-slash 308.
Early redirects retain Next's Location/Refresh/body behavior; ordinary responses
retain the global security-header policy. Caddy continues to add public HSTS.

Normalized progression data is read-only. It must already have the current
schema. Missing/uninitialized data storage returns unavailable instead of
performing TypeScript's first-ever lazy bootstrap. Analytics likewise requires
its existing schema; analytics/cache failures do not fail successful API work.
Schema ownership/migrations must migrate later before removing TypeScript setup.

Common numeric, ISO/RFC3339/RFC2822 and date-only configuration forms are supported.
Other legacy JavaScript Date.parse forms fail closed; check the actual cycle
configuration before activation. Existing TypeScript directly calls Seasonal
comparison from leaderboard preview, so that helper remains during this slice.
Durable cache data is compatible in both directions and across restarts.

See the [Rust server contract](../rust/backend/README.md) for configuration,
bounded queue/cache semantics and the supported initialization boundary.

## Runtime and proxy

The existing image/web cgroup contains Next on port 3000 and, when opted in,
Rust HTTP on port 3001. No new container or resource budget is allocated.
The supervisor waits for Rust's real HTTP readiness before starting Next.
Failure of either critical server stops both, waits for cleanup, then force-kills
a remaining process after five seconds. Rust stops/reaps its compute child.
No backend port is published on the host.

One Compose input selects the exact canonical/trailing endpoint for both web
startup and Caddy: `SEASONAL_API_UPSTREAM=web:3000` (default) or `web:3001`.
Other URLs keep their existing routes. A refused dial retries the same selected
backend; Rust never silently falls back to Next. HTTP 503, read resets and
timeouts are not replayed on another backend.

During coexistence Rust HTTP and Next have separate compute admission owners.
Each has one active computation and eight admitted jobs. The old single shared
Next FIFO therefore is not a global cross-process bound. Likewise Caddy's
32-request bound is per upstream address: mixed routing permits up to 32 on each.
The web RAM cap remains 896 MiB, not an extra allocation for Rust. Mixed workloads
need separate checks before production activation.

## Validation and evidence

Differential tests run a real Rust HTTP listener against the real TypeScript GET
handler on private synthetic SQLite fixtures. They cover error/gate/query/cache
contracts, bidirectional durable cache and restart, cold-write acknowledgement,
stale refresh, revision changes, queue saturation, worker timeout/crash/protocol
recovery and malformed lookup protection. This adapter does not simulate Next's
global headers or automatic methods.

The built-image verifier instead uses actual production Next and Rust listeners
for the HTTP boundary, including security headers, HEAD/OPTIONS/405 and redirects.
Real subprocess tests check supervision and failure cleanup. The actual production
Caddy configuration is exercised for route selection, independent mixed upstream
bounds, no cross-backend retry and recovery.

The full-HTTP experiment compares three separate runtime paths: production Next
with TypeScript computation, production Next with the Rust compute worker, and
Rust HTTP with its Rust compute worker. Six fresh constrained containers and reversed
repetitions keep memory high-water measurements separate. Next remains running
for the frontend in the Rust HTTP workload, so combined runtime costs are counted.
Per-repetition HTTP p50/p95 and errors are the primary evidence. Whole-cgroup CPU
and charged memory include setup, fixture/client, both servers when enabled,
workers and storage work; they are not process RSS or warm-only worker CPU.

No production gain is asserted by the harness. Shared-runner/synthetic limits,
cache-hit variation and any regressions must stay visible in the PR evidence.
Representative data, mixed workload and user-facing latency remain rollout gates.

## Coordinated activation and rollback

These are future operator steps after the maintenance chat explicitly frees the
VPS. No server action is part of this source change; the deployment timer remains
disabled during and after maintenance unless the user changes that instruction.

1. Install/verify the new image with routing still at web:3000. Keep a known-good
   image with capability label `org.tarkovstats.rust-http=seasonal-v1` as rollback.
   Initialize/verify data and analytics schemas through their current owners.
2. Validate the real cycle configuration and representative/mixed workloads.
   Install the reviewed proxy/Compose source without discarding local secrets,
   TLS volumes, storage configuration or other operator changes.
3. Change the selector once and recreate BOTH web and Caddy. Caddy's environment
   is frozen at container creation; reloading its file or recreating web alone
   does not synchronize a changed environment value.
4. Verify both HTTP listeners, the public endpoint, errors, p50/p95 and combined
   resources. A rollback of routing likewise recreates both services together.
   Record the exact image/config pair and validate the rollback before rollout.

The automatic image updater defers selector changes so it cannot apply only
half of a web/Caddy switch. With Rust selected, both the running rollback image
and the candidate must carry the compatible capability label. Deployment health
checks verify Next and the selected Rust listener; a healthy Next port alone is
insufficient. Later compatible image updates retain the selected mode.

## Official implementation references

[Axum HTTP serving](https://docs.rs/axum/latest/axum/serve/struct.Serve.html),
[Tokio blocking-task cancellation](https://docs.rs/tokio/latest/tokio/task/fn.spawn_blocking.html),
[Caddy reverse proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy),
and [Caddy error routes](https://caddyserver.com/docs/caddyfile/directives/handle_errors).
A timeout around an in-process blocking calculation cannot stop that work;
retaining the existing Rust child provides a killable computation boundary.

Build and run the isolated full HTTP experiment on local Linux Docker:

```sh
docker build --build-arg SOURCE_REVISION="$(git rev-parse HEAD)" -t tarkovstats-web:REVISION .
bash scripts/benchmark-rust-http-container.sh --image tarkovstats-web:REVISION --output /tmp/new-http-results
```

The output directory must not exist. The wrapper pins a local immutable image ID
and a matching source-revision label, never pulls images or uses production
volumes/env files, and runs six private containers: TypeScript, Next+Rust worker,
Rust HTTP, then the reverse order. Defaults are 30,000 synthetic peers and 20
requests per series. Each container has 0.5 CPU, 896 MiB RAM with no extra swap,
a read-only root and private tmpfs; these are controlled CI conditions rather
than an exact reproduction of production CPU/swap configuration.

Each measured miss has a distinct preseeded owner; unique revisions alone would
serve stale saved answers and would not prove a computation miss. Population
owners are isolated from each other so they cannot accidentally form a matched
group. Hit owners are prewarmed and must perform no worker jobs. Identical cache
and analytics schemas are initialized before either server starts; persisted
analytics counts and cold durable acknowledgement are checked. Reports preserve
per-repetition p50/p95, all errors, actual worker backends and the incremental
Next+Rust-worker versus Rust-HTTP comparison. CI artifacts retain raw reports,
inspection metadata and summaries for 14 days. No relative speed threshold is
used to turn a correctness check into a claim of universal performance gain.
