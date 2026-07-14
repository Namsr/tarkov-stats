# Seasonal implementation checklist

## Shared contracts

- [x] Define `GameMode`, `CycleId`, `(mode, cycleId, aid)` identity, normalized `SeasonalProfile`, progression records, task records, and store/API contracts.
- [x] Preserve legacy route semantics as `regular/persistent`.
- [x] Keep Seasonal UI and helper UI behind explicit fail-closed feature flags until the upstream contract is confirmed.

## Wave 1 — foundations

- [x] Migrate legacy progression data without losing snapshots; backfill `regular/persistent`.
- [x] Add mode/cycle-aware profiles, snapshots, intervals, daily aggregates, cohorts, tasks, runs, and helper sessions.
- [x] Enforce snapshot uniqueness on `(mode, cycle_id, aid, profile_updated_at)`.
- [x] Support both possible Seasonal upstream shapes with runtime validation and fixtures.
- [x] Derive activity from maximum skill `LastAccess` and achievement timestamp.
- [x] Implement interval/reset rules, percentiles, exact Tempo/Form weights, confidence, cohort expansion, trimmed means, weighted overall, and progression risk.
- [x] Review Wave 1 changes and run focused tests plus TypeScript.

## Wave 2 — collection and APIs

- [x] Implement one five-minute-lease queue with the four required priorities and operator-only ban tasks.
- [x] Fill the 2,000-member panel across eight lifetime-hour bands (150 minimum each, proportional remainder/reallocation).
- [x] Resume operator runs and stop after five consecutive system failures.
- [x] Persist explicit upstream outcomes and expose operator status/coverage/error queues.
- [x] Capture a deduplicated snapshot from canonical profile API reads.
- [x] Build latest-snapshot-per-account daily aggregates and progression cohort queries.
- [x] Return player/nearby/overall series, P25/P75, actual range, `n`, confidence, and freshness.
- [x] Add signed anonymous HttpOnly helper cookie, claim/skip/status/verify flow, lease checks, server-side upstream verification, and rate limits.
- [x] Review Wave 2 changes and run focused storage/API/security tests.

## Wave 3 — user experience and verification

- [x] Add canonical `/player/[mode]/[aid]` and `/average/[mode]` pages while preserving old URLs.
- [x] Add cumulative XP chart with Moscow dates/season day, level bands, and independent series toggles.
- [x] Add hours/PMC-raids comparison, nearby-range disclosure, P25–P75, and weighted overall.
- [x] Add Tempo/Form charts, norm line, interval risk markers, and long-term delta metrics.
- [x] Combine server-derived static and progression risk without automatic exclusion; show confidence, layer contributions, reasons, and disclaimer.
- [x] Add small opt-in helper block, 1–3 tasks, five-second polling, three-minute timeout, manual retry, and skip.
- [x] Add natural EN/RU strings for every visible label and verify parity.
- [ ] Verify the rendered layout at 360 px and preserve existing pages/navigation.

## Rollout and final verification

- [x] Document cycle configuration, flags, operator runbook, queue states, migrations, and rollout gates.
- [x] Test legacy SQLite migration, identity isolation, both fixtures, LastAccess, panel allocation, deduplication, daily selection, missing days, reset handling, K/D definitions, scoring weights, percentiles/confidence, cohort expansion, weighted overall, risk, leases, forged helper operations, aid/timestamp mismatches, and rate limits.
- [x] Run `npm run i18n:check`.
- [x] Run `npm run lint`.
- [x] Run `npm test` and focused test commands.
- [x] Run `npm run build` and `npm run cf-build` after the final review.
- [x] Review the full diff for unrelated changes, hardcoded UI strings, unsafe input handling, and mode/cycle leakage.
