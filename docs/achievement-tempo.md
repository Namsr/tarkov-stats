# Experimental achievement-speed analysis

The private admin tab `/admin?tab=achievements` measures calendar intervals from
saved achievement timestamps. It does not change any public risk score, model
version, moderation decision or ban. No new upstream requests are made.

## Measurements and populations

There are nine transitions: Killa 1→15, 15→100 and 1→100, and prestige 1–6.
Prestige 1 starts at First Time Always Hurts. This is the first successful
extraction, not the beginning of an account's development; treat it as a weaker
anchor. Other prestige transitions start at the previous prestige achievement.

Regular requires both timestamps after 15 November 2025, Moscow time; prestige
1–4 require both after 8 May 2026. Seasonal Killa timestamps must belong to the
configured active cycle. Seasonal prestige is disabled: the earlier study found
imported, identical and reversed timestamps, and their provenance is unverified.
Regular and Seasonal populations never mix. PvE and Arena are outside this model.

Missing, future, malformed, conflicting, zero-length and reversed dates do not
become fast transitions. A contradictory known Killa/prestige chain disables the
affected family. Dates can be upstream seconds or normalized milliseconds;
calendar time never substitutes for active playtime.

Known boss-event windows are conservatively excluded when any part of the
transition overlaps them. The historical windows in `TEMPO_EVENTS` come from the
earlier site study and are not a complete event calendar. In particular, their
presence does not certify that a recent transition was event-free. Changes to
periods, events, normalization or quantile rules must bump `TEMPO_VERSION`; this
also forces decoding of saved profiles again.

Only the latest saved snapshot per account and mode/cycle participates. Exclusion
tombstones and confirmed bans in any stored mode remove the account from all
reference groups. These groups are **not verified honest players**: they are
sampled, completed transitions from accounts without known bans. Slow incomplete
transitions do not appear, especially in a young season.

## Interpretation

The report shows both dates, duration, reference count, median, time percentile
and diagnostic reason. A percentile is the proportion of peers with duration
less than or equal to the player's duration, not a cheating probability. Ties
are included conservatively. Quantiles use nearest rank.

The checked account is removed from its own published population by account ID,
even if the checked observation or its duration changes. P5 signals require 100
remaining peers. P1 requires 500. Strictly shorter durations produce a signal;
ties at the boundary do not. The smallest percentile is identified for review;
overlapping Killa and prestige transitions are never added as risk points.
The first five shortest intervals in each adequate cohort are review shortcuts,
not automatic accusations or a verified list of anomalous players.

## Publication and operations

The existing `ops/materialize-publications.sh` runs
`scripts/materialize-achievement-tempo.mjs` after population publication, in a
separate bounded worker process. This releases the earlier population worker's
memory before the experiment starts. The runtime image explicitly includes the
script. The daily schedule needs no additional service; successful generations
remain fresh for 24 hours. Reports older than 48 hours are unavailable.

The worker reads a consistent transaction of progression.db, using personal
revisions to decode only changed raw snapshots. It writes compact normalized
dates and a complete reference generation to a separate achievement-tempo.db.
All updates for a scope commit atomically. An error or 180-second deadline leaves
the previous generation intact; Regular and Seasonal can succeed independently.
The source database remains readable while the output transaction is built.

`ACHIEVEMENT_TEMPO_SQLITE_PATH` overrides the output path; by default the file is
beside the configured progression database. It is derived and rebuildable, so it
does not need to be added to the authoritative profile-backup set. Deleting it
while workers are stopped loses only experimental publications and normalized
cache. The next scheduled run rebuilds it from preserved raw snapshots.

Only the worker installs a small exclusion-revision table, ban/exclusion triggers
and a partial confirmed-ban index in the source database. Changes to bans or
restorations invalidate existing reports immediately across processes. Reads
fail closed until the next publication; opening the admin panel never rebuilds
the population. The API requires the real admin session, sends no-store/noindex
headers and opens both files read-only. It returns aggregate references, up to
five review IDs per cohort and the requested profile, never the full population.

## Validation and remaining evidence

Unit/integration tests compare leave-one-out ranks and quantiles with an
independent array calculation, including ties and minimum samples. They cover
date formats and boundaries, malformed data, inconsistent chains, cross-mode
bans, restoration, incremental decoding, failed commits, deadlines and API
authorization/input validation.

On the developer's Windows machine, a synthetic scale run with 150,000 profiles
and 15,000 owners per transition measured approximately 3.31 s for the first
publication, 1.78 s for a forced repeat (zero raw profiles decoded), and 19.9 ms
for the p95 prepared-report read. The derived database was 27.3 MB and peak
process RSS was about 310 MiB. This includes synthetic setup and SQLite cache;
it is not a VPS or production-load measurement. Reproduce with:

```
node --experimental-strip-types --experimental-sqlite scripts/benchmark-achievement-tempo.mjs 150000
```

A local replay of the saved 21 October study reproduced all 491 selected Killa
intervals and 738 selected prestige intervals from their original timestamps.
These are previously selected fast cases, not an independent validation set.
Synthetic controls and exact arithmetic tests establish implementation behavior,
not discrimination between honest and cheating players.

Keep public scoring unchanged until event coverage and timestamp provenance are
adequate and an independent review set includes typical experienced farmers,
event participants and confirmed cases from matching periods. The old ban archive
does not supply enough modern prestige transitions to calibrate this signal.
Manual bans chosen using these same speed measurements must not be reused as
independent evidence of accuracy.
