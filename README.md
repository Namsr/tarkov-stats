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

`npm run rust:build` builds the release executable. Set
`REGULAR_COHORT_BACKEND=rust` to use it for Regular player comparison cohorts,
or `PVE_COHORT_BACKEND=rust` for PvE comparisons. Each mode has its own switch;
`typescript` (the default) restores the existing worker. Arena, Seasonal and other
jobs keep their TypeScript implementation. Both use the same queue and deadline policy;
Rust calculation failures surface through the existing retryable API error path.
There is no automatic retry on the other backend that could double the work.

The worker reads the existing `SQLITE_PATH` database without schema changes or
upstream requests. Start the normal application/storage initialization first.
`RUST_COHORT_BIN` can override the native executable; the production image includes
it and sets the path. Build with the installed host toolchain for local use.

Run `npm run benchmark:rust-cohort -- --rows 30000 --iterations 20 --output result.json`
for an isolated synthetic API comparison. The benchmark does not access production
data. Add `--mode pve` to benchmark PvE. See [Regular measurement notes](docs/rust-cohort-performance.md)
and [PvE measurement notes](docs/rust-pve-cohort-performance.md) for methodology and
limits. `npm test` builds Rust and runs both native and TypeScript regression tests.

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
