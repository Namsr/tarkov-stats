# Leaderboard performance score with hours

The existing performance score retains its three normalized components: total kills (40%), smoothed K/D (30%), and kills per raid or match (30%). Its logarithmic normalization, mode-specific reference cohort and 20-match smoothing remain unchanged.

The final score is the existing composite multiplied by `hours / (hours + 10)`. This is a confidence adjustment, not a separate rating or a 0–100 scale. The score can exceed 100. Ten hours is the half-strength point; three hours retain 23.08%, one hundred hours retain 90.91%, and seven hundred hours retain 98.59% of the original composite. Increasing hours never lowers the score, and its marginal effect decreases.

All eight scopes calculate this composite: regular PvP, PvE, seasonal PvP, and the five Arena modes. Each keeps its existing reference cohort. The normal minimum sample and activity requirements still apply. Missing, negative or non-finite hours make the composite unavailable; explicit zero hours yields zero points. Arena uses overall Arena hours and counters from the selected Arena mode. Seasonal PvP uses lifetime PvP hours, as before.

The new `score` order is independent of the primary order. PvP, PvE, seasonal PvP and performance-based Arena primary orders use the adjusted composite. BlastGang keeps its primary Best ARP order; Last Hero keeps its primary kills-per-match order. Both also expose the composite score as a separate selectable top. In BlastGang the Score column follows Best ARP, on desktop and in mobile cards.

Raw K/D sorting remains numeric, independent of hours. Zero-death players use their displayed kill count for this order, so 370 sorts ahead of 353 instead of being resolved by account ID. K/D is not the composite score.

## Public-data check, 2026-09-10

Two public PvP top-500 windows (primary and K/D) yielded 676 unique players, including 23 with fewer than ten hours. These are overlapping, top-heavy samples rather than a representative population. Applying only the hours adjustment to their published scores gives:

| Account | Hours | Published score | With hours adjustment |
| --- | --- | --- | --- |
| 10493246 | 703.2 | 418.19 | 412.33 |
| 8008486 | 2018.1 | 377.51 | 375.65 |
| 7584112 | 1001.9 | 373.87 | 370.18 |
| 14790032 | 3.0 | 228.29 | 52.68 |
| 14836465 | 9.4 | 252.00 | 122.10 |

These figures isolate the multiplier, not the exact full-rebuild outcome: rebuilding can update reference values and the published generation may predate the current repository formula. Ten hours is a product setting illustrating the intended strong reduction for new accounts, not a statistically optimal estimate. A high K/D can still contribute a high score; ranking cannot validate implausible upstream counters or establish cheating.

Formula version 3 and metric version 4 force a full rebuild on the next materialization, including reference formulas for BlastGang and Last Hero. Focused requests do not insert freshly calculated values into an older metric generation. Source activity checks, live exclusions, atomic publication and stable account-ID tie-breaking remain in place.
