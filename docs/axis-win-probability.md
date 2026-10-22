# Axis League pre-match probabilities

The compact block inside an expanded match shows the A/B probability conditional on a decisive result.
Both percentages sum to 100%. No explanation or extra interaction is required.
Invalid or incomplete rosters display a dash rather than invented probabilities.

`lib/axis-win-probability.ts` replays each queue in timestamp order. Matches with
the same timestamp are predicted as a batch before any results are observed.
Missing timestamps use only the supplied pre-match MMR and never train the model.
No current leaderboard statistics, target-match KDA, round score, winner or MMR
change enter the target prediction. Historical corrections replay later forecasts.

The model combines team MMR, individual results relative to the rating expectation,
recent form, bounded combat contribution, round dominance, map performance,
pair/trio/full-roster results, pair results on the selected map, individual opponent
history and exact roster meetings. Joint performance measures excess results over
the individual-strength baseline. Counts determine shrinkage: repeatedly successful
partners carry more evidence than a pair that happened to win once. Evidence has
a 45-day half-life; recent form uses seven days plus decay per appearance. Draws
contribute combat and round evidence but do not train binary win/loss outcomes.

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
rollback, migration and translated rendering. Historical probability calibration
must be measured on a representative archive; synthetic correctness tests alone
do not establish predictive accuracy.

On 2026-10-22, a chronological replay of 5,732 public NeatQueue archive entries
scored 463 decisive matches in the last 500 entries (#5248–5747). The Brier score
was 0.2459, compared with 0.2510 for the pre-match MMR-only baseline (lower is
better; a constant 50% scores 0.25). This single window is a limited sanity check,
not proof of calibration or future accuracy. NeatQueue does not include the site's
manually entered KDA/round scores, so this replay cannot validate their predictive
contribution. The local synthetic benchmark replayed 6,000 matches in 562 ms;
this excludes SQLite publication time and is not a production latency measurement.
