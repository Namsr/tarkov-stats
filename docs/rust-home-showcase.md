# Native home showcase configuration

## Scope

`GET /api/home/showcase` is the first request made by `HomePage` before it knows
which profile, comparison and timeline to load. Rust now owns this public
configuration handler, its SQLite read, and initialization/migration of its two
showcase tables. It returns the existing `groupId`, `groupName`, `mode`, `aids`,
`items`, `updatedAt`, and `seasonalCycleId` JSON fields. This moves application
logic into Rust and prepares a shared native data source for future rendering.
It does not server-render the home page or move its profile/risk pipeline.

The migration still targets the whole application, including UI, without a
mandatory Node/Next runtime. The next complete UI slice and its remaining data
work are described in [the Rust UI migration plan](rust-ui-migration.md).

## Behavior and storage

The handler selects the lowest-id active group, filters enabled items and sorts
by `sort`, then `aid`. Admin changes are visible on the next uncached request;
there is no additional in-process result cache. All four modes are preserved,
with Regular as the legacy unknown-mode fallback. A configured ready Seasonal
cycle is included even with an empty initialized showcase. A storage failure
returns the existing empty Regular fallback with a null cycle.

Every successful/fallback GET has the exact existing policy
`public, max-age=30, s-maxage=60`. Query keys are ignored. HEAD, OPTIONS, 405,
canonical/trailing-slash redirects and global security headers retain the Next
boundary. No user-specific state, cookies or CORS policy are added.

The existing `ADMIN_ANALYTICS_SQLITE_PATH` is used (default
`/data/admin-analytics.db`). The Rust connection creates only
`home_showcase_groups`, `home_showcase_items` and their existing index. Legacy
groups gain the same `mode TEXT NOT NULL DEFAULT 'regular'` column as the TS
store. Other analytics tables and existing journal mode are untouched. Admin
configuration mutations remain on their existing API during this stage.

A separate blocking database thread admits at most 32 queued reads and one
active read. It uses 100 ms SQLite busy waits instead of the TS store's 5 s
wait, keeping contention off Tokio and separate from cohort/cache/event work.
A deferred read transaction keeps group and item reads on one snapshot and
rolls back on errors. Open/schema failures back off for 5 s; query failures
drop the connection so a subsequent request can recover after a lock clears.
Full queues and failed reads use the same public fallback. These deliberately
shorter contention waits can expose a fallback sooner during a write lock;
that response still has the existing 30/60 s public cache policy.

## Runtime selection and rollback

`HOME_SHOWCASE_API_UPSTREAM` accepts only `web:3000` (default, existing Next
route) or `web:3001` (native Rust route). Compose supplies the same explicit
value to web and Caddy. `SEASONAL_API_UPSTREAM` stays independent. Either native
selection starts the existing Rust process; selecting both starts it once.
Both listeners retain the existing 896 MiB combined web cgroup budget.

Caddy selects only `/api/home/showcase` and `/api/home/showcase/`. Other home
routes stay on Next. A refused TCP dial retries the selected backend; a native
503/reset never replays onto Next. The existing per-address 32-request proxy
limit remains shared by both native routes when selected together.

The deployment wrapper defers changes to either selector because web and Caddy
must be recreated together. With home routing already selected, both the running
rollback image and the new candidate must carry capability label
`org.tarkovstats.rust-home-showcase=v1`. The existing Seasonal capability remains
required independently when its selector is native. Native health is checked
if either actual running-container selector uses port 3001.

Install a capable image with routing off before any coordinated opt-in. Source
merges do not activate routes or prove production improvements. Honor the
existing deployment/data locks during server operations; the former maintenance
chat is no longer a coordination dependency by direct user instruction.
`tarkovstats-deploy.timer` remains enabled by the latest user instruction;
source approval and CI do not themselves enable native routing.

## Validation and performance limits

`tests/rust-home-showcase.test.mjs` compares a real Rust HTTP listener with the
actual TS GET export using private temporary SQLite fixtures. It covers empty
storage/bootstrap, all modes, active selection, ordering/disabled items, admin
changes, legacy migration, read-lock fallback/recovery, unavailable initialization
and the public HTTP policy. The production-image runtime verifier compares real
Next/Rust method, redirect, JSON and security headers. Proxy/supervisor/deploy
checks cover independent route selection and rollback compatibility.

These are compatibility and lifecycle checks. Home endpoint p50/p95 and browser
LCP/INP/CLS/time-to-useful-data have not yet been measured. The existing Seasonal
HTTP/cohort benchmarks do not measure this route or establish a speedup for the
home page. Preserve that distinction when reporting results or choosing UI work.
