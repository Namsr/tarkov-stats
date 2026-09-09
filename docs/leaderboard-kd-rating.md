# K/D rating calibration — 2026-09-10

The K/D order uses a bounded rating rather than raw K/D:

`100 × kd / (kd + 2) × hours / (hours + 10) × matches / (matches + 20)`

`kd = kills / max(1, deaths)`. The interface retains raw K/D and shows the published rating below it. The rating is between 0 and 100; it is not a probability or a cheating assessment.

K/D 2 contributes 50% of its maximum, K/D 10 contributes 83.3%, and K/D 353 contributes 99.4%. This limits the advantage of extreme ratios. Hours and matches each contribute a bounded confidence factor. Ten hours and twenty matches are their respective half-strength points. More hours never reduce the score, but their marginal effect decreases.

The existing minimum sample and activity requirements remain. Missing or invalid hours exclude a player from this order; explicit zero hours produces zero points. Arena uses overall Arena hours but matches from the selected Arena mode. Other modes use their existing hours source and raid count; seasonal PvP hours are lifetime PvP hours. ARP, performance-score, kills, kills-per-match and hours orders keep their existing formulas.

## Evidence and limits

Read-only public `/api/leaderboard` responses for Arena BlastGang were collected on 2026-09-10, generation `1788915678488`, generatedAt `1788915710302`. Four top-500 windows (`kd`, `primary`, `hours`, `killsPerMatch`) yielded 1,179 unique accounts with at least six matches. The `kills` window was empty in this published generation and was not used. This is a deliberately top-heavy sample, not a random sample or the whole leaderboard. There are no ground-truth skill labels; the comparison supports the requested behavior, not a statistically optimal formula.

43 sampled accounts had zero recorded deaths. The previous K/D order put every positive-kill zero-death account ahead of finite K/D and broke their ties by account ID, while displaying kills as K/D. This explains the reported order of 353 before 370.

Compared candidates:

| Candidate | Observed limitation or result |
| --- | --- |
| `kd × h/(h+20)` | Top account still scores 2,476; extreme K/D dominates. |
| `ln(1+kd) × h/(h+20)` | Accounts with just 6–8 BlastGang matches remain in the top ten due to overall Arena hours. |
| `100 × ln(1+kd) × h/(h+10) × m/(m+20)` | Low-sample examples fall, but a 2,741 K/D remains first at about 600 points. |
| Bounded formula above | The 2,741 K/D account moves to sixth; the top five have 118–331 matches. |

We also compared hour half-strength points 20 and 50, match points 20 and 50, and K/D saturation points 5 and 10. Ten hours reduces the duration of the hours penalty as requested. Twenty matches retains the existing smoothing scale; the separate match factor prevents unrelated Arena hours from establishing confidence in a tiny mode sample. Saturation at K/D 2 reduces extreme-K/D dominance more than 5 or 10. These are product defaults, not population-derived estimates.

Example ranks within the 1,179-account sample under the selected formula:

| Account ID | Kills / deaths | Hours | Matches | Sample rank |
| --- | --- | --- | --- | --- |
| 481173 | 353 / 0 | 16.34 | 11 | 771 |
| 1582340 | 370 / 0 | 34.60 | 22 | 340 |
| 2499892 | 632 / 0 | 1.71 | 19 | 1170 |
| 7408394 | 210 / 0 | 542.50 | 6 | 761 |

These are not predicted full-database positions. Calibration evidence is specific to BlastGang; behavior in other modes is covered by arithmetic and publication tests, not by population calibration. High K/D can still rank highly when supported by hours and matches. Implausible upstream counters cannot be validated by a ranking formula.

Metric version 3 forces the next materialization to rebuild the ordering. Until then, focused requests keep the previous published generation rather than mixing old and new keys. No production data is changed by the code review itself.
