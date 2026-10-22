# Axis League pre-match probabilities

The compact block inside an expanded match shows the A/B probability conditional on a decisive result.
Both percentages sum to 100%. No explanation or extra interaction is required.
Invalid or incomplete rosters display a dash rather than invented probabilities.

`lib/axis-win-probability.ts` replays each queue in timestamp order. Matches with
the same timestamp are predicted as a batch before any results are observed.
Missing or non-finite timestamps produce no forecast and never train either model:
there is no safe temporal cutoff or calibration check for these records. The UI
shows a dash, including for otherwise valid undated rosters.
No current leaderboard statistics, target-match KDA, round score, winner or MMR
change enter the target prediction. Historical corrections replay later forecasts.

The model combines team MMR, individual results relative to the rating expectation,
recent form, bounded combat contribution, round dominance, map performance,
pair/trio/full-roster results, pair results on the selected map, individual opponent
history and exact roster meetings. A further learned feature measures the gap
between each player's previously observed peak MMR and their pre-match rating.
It starts with zero weight and never grants an automatic bonus for experience.
Peaks come only from earlier pre/post-match ratings in the same queue, including
past draws; a new player has no assumed historical peak. Target-match MMR changes
cannot enter the feature. Joint performance measures excess results over
the individual-strength baseline. Counts determine shrinkage: repeatedly successful
partners carry more evidence than a pair that happened to win once. Evidence has
a 45-day half-life; recent form uses seven days plus decay per appearance. Draws
contribute combat and round evidence but do not train binary win/loss outcomes.

Evidence carries across seasons within a queue. A rating reset changes the
pre-match MMR, while the past peak and decaying results retain prior information.
The model does not read current leaderboard peak ratings or clear all experience
at a season boundary.

Regularized online logistic regression learns feature weights from prior decisive
games, starting with conservative priors and the usual Elo MMR scale. A separate
temperature calibrator fits regularized log loss on the last 1,000 earlier raw
scores and their outcomes. Every score was computed before observing its result.
The calibrator starts fitting after 100 decisive games and refits every 25. Its
one nonnegative scale is found by bounded bisection (0–5), with ridge strength 5
toward scale 1. Confidence is also shrunk by n/(n+20) when the queue has little
history; with no decisive observations it starts at 50/50. There is no team-side
intercept, so swapping teams complements the forecast. Values are limited to
5–95% and rounded to 0.1 percentage point. This is an estimate, not a guarantee;
the model has no information about voice communication, roles or unrecorded games.

This replaces version 2's single-step temperature updates. The base feature
weights still learn independently; calibration changes the confidence scale,
not which side has the higher raw score. Rounding can create or remove 50/50
ties. Draws and cancellations do not count as calibration outcomes. See the
[scikit-learn calibration guide](https://scikit-learn.org/stable/modules/calibration.html)
for temperature scaling, reliability curves and the distinction between Brier
score and calibration alone. No Python/runtime ML dependency is added.

Predictions are materialized atomically during archive imports and KDA/round edits.
An unchanged import checks a revision and does not rebuild. HTTP history/profile
reads fetch only their requested prediction rows. Existing installations backfill
on the first successful import after deployment. The model version invalidates old
materializations when its calculation changes.

Archive refreshes collect their bounded set of pages before opening the write
transaction. All successfully fetched pages, cursor/seasons and predictions are
then committed together, with one replay per worker tick. A failed later fetch
still publishes the earlier successful pages and marks the archive stale. A
failed publication rolls back the entire batch; no transaction spans network I/O.

Saving identical KDA/round values checks optimistic concurrency but performs no
statistics writes or replay. Archive name/avatar/team-label updates also reuse
predictions: comparison includes every input the model reads, and skips replay
only if the saved model matched the revision before this transaction. Unseen
changes from another process and model-version changes still force rebuilding.
New results, real KDA/round changes, roster/MMR changes and other model inputs
still replay the complete archive synchronously inside the write transaction.
This can delay the editing request and other work in that process; ordinary
history reads continue to use the saved probabilities.

Local performance check (Windows, Node 24.19.0, 5,732 saved public entries):

| Operation | Before optimization | After optimization |
|---|---:|---:|
| Save identical KDA | 534 ms | 0.09 ms |
| Change an archived name | 531 ms | 42 ms |
| Import three pages of 50 new entries | 1.77 s | 0.59 s |
| Read a warm history page | 1.08 ms | 1.14 ms |

These isolate computation with in-memory SQLite. Repeated operations use the
median of seven runs (25 for history); the three-page import is one run with
synthetic new entries appended to the real archive. Ordinary real KDA edits still
take roughly 0.4–0.7 seconds in this setup. A separate temporary file-backed
SQLite run measured unchanged KDA saves at 874 → 0.35 ms and the three-page import
at 3.02 → 1.55 seconds; real KDA edits remained around 0.8 seconds. Filesystem
commit latency varies considerably. These are local store timings, not HTTP or
production latency measurements, and make no speed claim for necessary full
replays. All 5,117 persisted forecasts from the public snapshot match the
pre-optimization results exactly, including the saved KDA/round overlays.

Validation covers chronological isolation, team symmetry, cold starts, cancelled
games, queue isolation, combat, map and joint evidence, decay, persistence, edits,
rollback, migration, peak transfer, safe undated forecasts and translated rendering. Historical probability calibration
must be measured on a representative archive; synthetic correctness tests alone
do not establish predictive accuracy.

On 2026-10-22, version 2 was compared with version 1 by chronological replay of
5,732 public NeatQueue archive entries. For the 3,405 decisive games in the primary
Axis queue, Brier decreased from 0.247377 to 0.242395. For 463 decisive games in
the last 500 entries (#5248–5747), it decreased from 0.245927 to 0.235699;
the fixed MMR-only baseline on that last window scored 0.251022. Lower is better;
a constant 50% scores 0.25. Both versions learned only from preceding outcomes.

Seven successive chronological blocks of primary-queue outcomes (six of 500,
then 405) all improved:

| Matches | Version 1 Brier | Version 2 Brier |
|---|---:|---:|
| #8–662 | 0.252783 | 0.252440 |
| #669–1838 | 0.251055 | 0.249648 |
| #1839–2987 | 0.251162 | 0.248049 |
| #2988–3903 | 0.246101 | 0.242831 |
| #3904–4698 | 0.246413 | 0.239245 |
| #4699–5307 | 0.238562 | 0.228293 |
| #5308–5747 | 0.245136 | 0.234823 |

All 16 season ranges returned by `detectAxisSeasons` also had a lower Brier.
Most boundaries are inferred, and some ranges contain only 32–47 decisive games;
the confirmed current season has 88 (0.245221 → 0.235177). These checks use one
existing archive, including the data that motivated the new feature. They do not
establish independent validation, precise calibration or future accuracy.

NeatQueue does not include the site's manually entered KDA/round scores, so this
replay cannot validate their predictive contribution. The earlier version 1 local
synthetic benchmark replayed 6,000 matches in 562 ms; this excludes SQLite
publication time and is not a production latency measurement for version 2.

## Version 3 calibration validation

A saved public site archive includes all 5,732 entries plus its manually saved
KDA/round scores (83 matches). For selection of the calibrator, the first 2,400
decisive games of the primary queue were used (ending #4547). The later 1,005
games, starting #4548, were not used to choose its window or regularization.
Evaluation is walk-forward: an outcome may update calibration only for subsequent
games. Simultaneous timestamps cannot straddle the evaluation split.

| Later 1,005 matches | Version 2 | Version 3 |
|---|---:|---:|
| Brier | 0.231185 | 0.230205 |
| Log loss | 0.654341 | 0.652176 |
| Team A probability ECE, ten 10-point bins | 4.12 pp | 2.58 pp |
| Favorite probability ECE, five 10-point bins | 3.64 pp | 1.67 pp |

ECE is the count-weighted absolute difference between a bin's average probability
and observed win frequency. Different bins, small samples and repeated players
affect this measurement. Exact 50/50 forecasts are excluded from favorite metrics;
they remain in Brier, log loss and team A reliability using actual outcomes.

Version 3 favorite reliability on this later period:

| Average forecast | Favorite wins | Observed win rate |
|---|---:|---:|
| 54.48% | 323 / 575 | 56.17% |
| 64.09% | 190 / 290 | 65.52% |
| 73.97% | 84 / 110 | 76.36% |
| 83.17% | 19 / 23 | 82.61% |

There were seven 50/50 forecasts. The highest-probability group has only 23
matches and cannot establish precise 80%+ calibration.

For the current season alone (88 matches), favorite ECE decreases from 9.47 pp
to 6.88 pp, but team A ECE increases from 10.73 pp to 12.76 pp. The group averaging
64.28% wins 22/34 (64.71%); other current-season groups remain uncertain. This is
not uniform improvement or proof that each current-season percentage is accurate.

The archive previously informed base feature development, so the later period is
held out from this calibrator's selection, not a completely independent or
prospective test of the entire model. Future games and stable results across
larger samples are still required. No exact win-frequency guarantee is made.

To reproduce a report from a saved JSON array of matches (no network access):

```sh
node --experimental-strip-types scripts/backtest-axis-probability.mjs archive.json --development-count 2400
```

The JSON report contains development, later-period and current-season metrics,
reliability bins with approximate Wilson intervals, and every evaluated match.
Duplicate match numbers are rejected. Wilson intervals assume independent binary
trials; repeated players/lineups mean they should not be read as definitive
uncertainty bounds.
