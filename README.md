# Tarkov Stats

Tarkov Stats is an open-source web app for exploring public Escape from Tarkov
player statistics. Search for a player, compare profiles, and follow changes in
historical statistics.

## Development

Requires Node.js 22.18 or newer. CI and the production image use Node.js 22.
The native cohort pilot and full test suite also need Rust 1.89+ and a C compiler
for bundled SQLite (CI uses Rust 1.98.1). The web app defaults to TypeScript.

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

The optional [AXIS Discord bot](docs/axis-discord-bot.md) accepts match screenshots
from configured Discord channels without requiring a website account.

Useful checks before opening a pull request:

```bash
npm run i18n:check
npm run lint
npm run typecheck
npm test
npm run build
```

Pull requests run the same checks on Linux before the production image is built.

Most local development works without additional configuration. If a local
integration needs environment variables, copy `.env.example` to `.env` and use
local values only. Never commit `.env` files, credentials, databases, backups,
or deployment configuration.

## Contributing

Bug reports, small fixes, tests, and focused improvements are welcome. Please
open an issue for a larger change before starting implementation, then submit a
pull request with a short description and the checks you ran.

## Project structure

- `app/` — pages and API routes
- `components/` — reusable UI components
- `lib/` — application logic and data access
- `tests/` — automated tests

The application reads public Tarkov data from JSON endpoints and is not
affiliated with Battlestate Games or Tarkov.dev.

## Rust cohort pilot

`npm run rust:build` builds the release executable. Each comparison mode has
its own opt-in switch: `REGULAR_COHORT_BACKEND`, `PVE_COHORT_BACKEND`,
`ARENA_COHORT_BACKEND`, and `SEASONAL_COHORT_BACKEND`. Set a switch to `rust`
to use native computation, or `typescript` (the default) to use the existing
worker. Arena includes both player cohorts and dynamic population averages;
Seasonal includes player cohorts. Seasonal average publication, baselines and
other jobs retain their TypeScript implementation. Jobs dispatched by Next share the same bounded FIFO and deadline policy. Calculation failures use the existing
retryable API error path; there is no automatic retry on the other backend.

The worker reads the existing `SQLITE_PATH` players database and, for Seasonal,
`PROGRESSION_SQLITE_PATH` / `PROGRESSION_DB_PATH` (default `/data/progression.db`).
Both databases and their current schemas must be initialized through the normal
TypeScript storage path before native activation. Rust is strictly read-only:
it neither creates a missing database nor migrates an old schema. Unlike
TypeScript's first-ever lazy bootstrap, uninitialized Arena/Seasonal storage
reports unavailable through the existing API error path. Failed readiness is
retried on a later job, so external initialization does not require a worker
restart. Normal startup behavior is preserved by the TypeScript defaults.

`RUST_COHORT_BIN` can override the native executable; the production image includes
it and sets the path. Build with the installed host toolchain for local use.

Run `npm run benchmark:rust-cohort -- --mode arena --rows 30000 --iterations 20 --output result.json`
for an isolated synthetic API comparison. `--mode` accepts `regular`, `pve`,
`arena`, or `seasonal`; the benchmark does not access production data.
See [Regular measurement notes](docs/rust-cohort-performance.md) and
[PvE measurement notes](docs/rust-pve-cohort-performance.md) for the earlier local
experiments and their limits. `npm test` builds Rust and runs native/TypeScript
compatibility and regression tests.

For a Linux comparison using the built production image without production data:

```bash
bash scripts/benchmark-rust-container.sh tarkovstats-web:REVISION /tmp/new-benchmark-results
```

This requires a local Linux Docker default context and an output directory that
does not exist. It never pulls images or uses production volumes/credentials.
CI runs the same command, preserves JSON/logs as a 14-day artifact, and writes a
step summary. See [Linux benchmark methodology](docs/rust-linux-cohort-performance.md).
`--backend typescript|rust|both` selects one implementation in the underlying
Node benchmark; the default remains `both`.

## Rust HTTP migration

The target is all application logic in Rust, including the API, background work,
storage ownership and frontend SSR/client behavior. Node.js and Next.js remain
migration dependencies until their application responsibilities are replaced.

The first full HTTP endpoint is `/api/seasonal/cohort`. It has its own Rust
request validation, cycle gate, memory/durable cache, compute admission, response
format, security headers and analytics. The request path does not call a
TypeScript handler or forward business logic to Next. Its compute child is also
Rust, preserving killable deadlines without duplicating the calculation.

The image includes both servers. `SEASONAL_API_UPSTREAM=web:3000` keeps the current
Next route (the default). `web:3001` starts the Rust HTTP server and lets Caddy
route exactly that endpoint directly to it. The existing web memory budget is
retained; port 3001 is internal. Changing this selector requires coordinated
web/Caddy recreation and a compatible rollback image, not just a web image
update. Nothing enables the user-disabled deployment timer.

The Rust HTTP process has its own bounded queue and cache. Legacy Next helpers,
including leaderboard preview, keep their queue during coexistence. Caddy's
32-request bound is per upstream address, so mixed routing can admit 32 requests
to each server. Mixed-load and production readiness must be checked before
activation; worker-only results do not establish that the HTTP migration is
faster. See [HTTP migration, validation and rollout](docs/rust-http-backend.md).

`/api/home/showcase` also has a native Rust handler, including its own showcase
schema initialization and legacy mode migration. Independent
`HOME_SHOWCASE_API_UPSTREAM=web:3000|web:3001` selects Next (default) or Rust.
Either native selector starts the same supervised Rust process; the public
configuration read does not use the cohort/analytics write queue. Activation
requires coordinated web/Caddy recreation and a rollback image labeled
`org.tarkovstats.rust-home-showcase=v1`. See the [home endpoint contract](docs/rust-home-showcase.md).

The [first complete Rust UI slice](docs/rust-ui-migration.md) is planned around
the Arena population dashboard, including native data access, SSR, interactive
controls and shared site behavior. That interface is not implemented by the
home configuration endpoint or the Seasonal computation port.
