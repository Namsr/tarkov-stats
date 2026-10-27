# Rust HTTP backend

This is the first complete HTTP endpoint moved from Next.js to Rust:
`GET /api/seasonal/cohort`. Rust owns query validation, the Seasonal rollout
gate, memory and durable caches, computation scheduling, HTTP responses,
security headers and best-effort request analytics. No Node process handles
this endpoint in the native deployment path. Other application endpoints
remain in Next.js during the migration.

Build both binaries from the repository root:

```sh
cargo build --release --locked --manifest-path rust/cohort-worker/Cargo.toml
cargo build --release --locked --manifest-path rust/backend/Cargo.toml
cargo test --locked --manifest-path rust/backend/Cargo.toml
```

Run `rust/backend/target/release/tarkov-backend` (`.exe` on Windows). Supply
configuration through the process environment; this binary does not read
`.env` files. `RUST_API_BIND` defaults to `127.0.0.1:3001`; port `0` chooses an
available port. The container supervisor sets the internal Docker address.
Startup writes one JSON line to stdout:

```json
{"event":"rust_api_ready","address":"127.0.0.1:3001"}
```

`/healthz` stays responsive independently of computation. SIGTERM on Unix
and Ctrl+C stop admission, stop/reap the compute child and drain HTTP work.
Public traffic should enter through the existing Caddy hardening; no backend
host port needs to be exposed. The proxy owns the opt-in and rollback choice.

## Compatibility

The canonical route preserves the current Seasonal JSON schema and status
codes. Query parsing uses the first decoded value of duplicate keys. Numeric
account IDs and Tarkov profile links use the same validation; unknown queries
are ignored. Invalid revisions are ignored. The active Seasonal cycle and
rollout configuration use the existing `SEASONAL_*` environment variables.
GET supports HEAD; OPTIONS returns 204 with `Allow: GET, HEAD, OPTIONS`;
unsupported methods return an empty 405. The trailing-slash path redirects
with 308 and preserves its raw query, Location/Refresh headers and literal
location body (empty for HEAD). It precedes the global application headers,
matching Next; the public Caddy HSTS policy still applies. No CORS policy or new
authentication is introduced. Headers mirror the existing Next configuration.

Configuration dates support positive numeric seconds/milliseconds, ISO date,
RFC3339, RFC2822 and ISO local date-time forms. Other legacy JavaScript
`Date.parse` formats fail closed. ISO dates are UTC; date-times without an
offset use the local timezone. Operator collection keeps the existing time
gate rules; JSON-feed rollout also checks the configured collection window.

## Cache and storage

The Seasonal cache retains five-minute results, a stale result during refresh,
revision-independent fallback identities, shared in-flight work and bounded
retry delays. The in-memory LRU is limited to 2048 identities and 32 MiB of
serialized saved payloads. Durable entries interoperate with TypeScript in
`AVERAGE_PUBLICATION_SQLITE_PATH` (default `/data/average-publications.db`),
using the existing `statistics_response_cache` table and saved-value format.
Disk retention is bounded to 4096 rows / 64 MiB; individual writes over 1 MiB
are skipped. Persistence uses the same enable predicate: nonempty SQLITE_PATH
and either production NODE_ENV or AVERAGE_PUBLICATIONS_ENABLED=true.

Memory is published before a durable write, while the original cold loader
awaits the bounded best-effort storage acknowledgement. Stale callers return
immediately. Cache storage failures do not turn a computed response into an
HTTP failure. SQLite cache reads/writes run on a dedicated bounded storage
queue rather than blocking HTTP execution. The cache writer creates only its
own existing cache table. The analytics writer appends compatible request
facts to an already initialized `request_events` table at
`ADMIN_ANALYTICS_SQLITE_PATH` and logs/backoffs if that table is unavailable.
It does not create or migrate the analytics schema.

The progression database must already be initialized by the existing setup.
The compute binary keeps progression data read-only and never creates or
migrates it. Missing/uninitialized storage returns the documented 503 rather
than emulating TypeScript's first-ever lazy bootstrap. No request is forwarded
to Next.js to initialize a database or perform business logic.

## Bounded compute

`RUST_COHORT_BIN` selects the existing Rust JSONL compute binary; by default it
is `rust/cohort-worker/target/release/tarkov-cohort-worker` relative to the
current directory (`.exe` on Windows). Optional `RUST_COHORT_ARGS` is a JSON
array of executable arguments for a compatible worker. Jobs have one active
slot and at most eight admitted jobs including that active job. FIFO wait is
included in the default 15-second deadline. `RUST_API_COMPUTE_TIMEOUT_MS` can
shorten that budget; values above 15000 are clamped. The existing optional
`DYNAMIC_COMPUTE_TIMEOUT_MS` still bounds the cold cache wait separately.

The worker is long-lived and runs at the existing low priority. Crashes,
malformed/oversized replies and deadlines kill/reap it; following live jobs
start a fresh worker. Frames are bounded to 64 KiB requests and 1 MiB replies.
A single client's disconnect does not cancel work shared with another caller.

This process's queue is separate from the remaining Next.js cohort queue;
it does not preserve a global one-active-job limit across both processes.
Enable the proxy route only after mixed-load latency, errors and the existing
web-container resource budget have been checked. The frontend URLs stay the
same. Structured request/worker events include the selected backend, phases
and allowlisted identity fields, never cookies or arbitrary query strings.
