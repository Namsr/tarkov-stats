---
name: verify
summary: Exercise runtime changes through the local Next.js API surface
---

# Runtime verification

1. Start an isolated dev server on a free port. For timing-log work, force sampling:

```bash
OBSERVABILITY_SAMPLE_RATE=1 npm run dev -- -p 3107
```

2. Drive changed API routes through HTTP, not direct imports. Safe observability endpoints:

```bash
curl -sS 'http://localhost:3107/api/average?mode=regular&dimension=hours&min=0&max=100&metric=kd_ratio'
curl -sS 'http://localhost:3107/api/average/cohort?mode=regular&dimension=hours&center=100&excludeAid=1'
curl -sS 'http://localhost:3107/api/baseline?mode=regular&minHours=0&maxHours=100'
curl -sS 'http://localhost:3107/api/average/achievements?mode=regular'
```

3. Capture server stdout and verify one `request_timing_v1` JSON event per request, expected status/body, and no aid, URL, query, IP, headers, user agent, or error text in the structured event.
4. Probe one invalid request and a second achievements request to cover invalid outcome and memo hit.
5. Stop the server. Do not use real player IDs or upstream profile refreshes during routine verification.
