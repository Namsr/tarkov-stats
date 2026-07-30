# Production performance baseline

Recorded on 2026-07-18 before deploying P0 observability or implementing P1 SSR.

## Conditions

- Production regular-player page on `https://tarkovstats.ru`
- One fixed public profile for every run
- Chrome for Testing 151.0.7922.34 through Chrome DevTools MCP
- Headless, isolated browser; CPU throttling 1x; no network throttling
- Cold/forced: hard reload with cache ignored; Navigation Timing `reload`; exactly one `/api/player/profile?...&refresh=1`
- Warm: normal top-level navigation with the browser cache retained; Navigation Timing `navigate`; profile request has no `refresh=1`
- Request count includes the document and Resource Timing entries

Cloudflare Web Analytics values captured before P0:

| Metric | Value |
| --- | ---: |
| Page Load | 565 ms |
| Processing | 131 ms |
| Request | 101 ms |
| Response | 21 ms |

## Raw browser runs

All timings are milliseconds.

### Cold/forced

| Run | LCP | TTFB | LCP render delay | CLS | FCP | TBT | responseEnd | DCL | load | Requests | Profile API |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 8891 | 7472 | 1419 | 0.01 | 8048 | 0 | 7585 | 8038 | 8370 | 35 | 476 |
| 2 | 2861 | 1862 | 999 | 0.01 | 2024 | 0 | 1884 | 2016 | 2230 | 35 | 586 |
| 3 | 806 | 177 | 630 | 0.01 | 276 | 0 | 202 | 268 | 431 | 35 | 331 |
| **Median** | **2861** | **1862** | **999** | **0.01** | **2024** | **0** | **1884** | **2016** | **2230** | **35** | **476** |
| Range | 806–8891 | 177–7472 | 630–1419 | 0.01 | 276–8048 | 0 | 202–7585 | 268–8038 | 431–8370 | 35 | 331–586 |

### Warm navigation

| Run | LCP | TTFB | LCP render delay | CLS | FCP | TBT | responseEnd | DCL | load | Requests | Profile API |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 641 | 148 | 493 | 0.01 | 516 | 0 | 498 | 501 | 546 | 34 | 59 |
| 2 | 226 | 57 | 169 | 0.01 | 104 | 0 | 88 | 91 | 105 | 34 | 80 |
| 3 | 417 | 45 | 372 | 0.01 | 92 | 0 | 64 | 77 | 79 | 34 | 302 |
| **Median** | **417** | **57** | **372** | **0.01** | **104** | **0** | **88** | **91** | **105** | **34** | **80** |
| Range | 226–641 | 45–148 | 169–493 | 0.01 | 92–516 | 0 | 64–498 | 77–501 | 79–546 | 34 | 59–302 |

## Waterfall findings

Every measured navigation showed the same client waterfall:

1. The document loads and hydrates.
2. `/api/auth/me`, `/api/player/profile`, and `/api/favorites?all=1` begin together only after `load`.
3. `/api/average/cohort`, `/api/baseline`, and two duplicate `/api/average/achievements` requests begin only after the profile request completes.

The cold runs correctly issued one forced profile request. The warm runs issued one normal profile request. The two achievements requests were present in all six runs.

A safe real click on the radar dimension button produced an Event Timing interaction of **32 ms**. This is a single lab interaction, not a p75 INP result; Cloudflare RUM remains the source for production INP.

## P1 comparison gate

Repeat the same 3 cold + 3 warm protocol after P1. Confirm normal navigation makes no `/api/player/profile` request, hard reload makes exactly one `refresh=1` request, and compare medians without treating these six lab samples as field p75 values.
