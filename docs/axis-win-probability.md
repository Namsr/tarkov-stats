# Axis League pre-match probabilities

The compact block inside an expanded match shows the A/B probability conditional on a decisive result.
Both percentages sum to 100%. No explanation or extra interaction is required.
Invalid or incomplete rosters display a dash rather than invented probabilities.

`lib/axis-win-probability.ts` replays each queue in timestamp order. Matches with
the same timestamp are predicted as a batch before any results are observed.
Missing timestamps use only the supplied pre-match MMR with a fixed Elo weight
and no learned temperature. They never train the model or use learned history.
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
games, starting with conservative priors and the usual Elo MMR scale. An online
temperature adjustment also uses earlier results only. There is no team-side
intercept, so swapping teams complements the forecast. Values are limited to
5–95% and rounded to 0.1 percentage point. This is an estimate, not a guarantee;
the model has no information about voice communication, roles or unrecorded games.

Predictions are materialized atomically during archive imports and KDA/round edits.
An unchanged import checks a revision and does not rebuild. HTTP history/profile
reads fetch only their requested prediction rows. Existing installations backfill
on the first successful import after deployment. The model version invalidates old
materializations when its calculation changes.

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
