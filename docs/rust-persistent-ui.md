# Regular and PvE population pages in Rust

This slice moves `/population/regular` and `/population/pve`, their legacy
`/average/<mode>` redirects, population data, progression projection and
achievement aggregation into the existing Rust server and Rust/WASM client.
It does not finish the application migration: profiles, auth, support,
analytics, collectors, schema/bootstrap ownership and other pages still need
Rust implementations before Node/Next can be removed.

## Runtime and rollout

`REGULAR_UI_UPSTREAM` and `PVE_UI_UPSTREAM` independently select `web:3000`
(default Next) or `web:3001` (Rust). A single Rust process serves all selected
native boundaries; there is no extra container allocation. Both Compose web
and Caddy receive the same selectors. The selected population document,
immutable assets and these API branches move together:

- `/api/average`: portrait, fixed buckets, histogram and range filtering.
- `/api/average/metrics`: six metric series.
- `/api/progression/average`: scheduled progression publication or compatible
  durable fallback; no request-time history scan.
- `/api/average/achievements`: baseline publication and reference metadata.

Caddy uses the first decoded `mode` query value. Missing mode defaults to
Regular; an explicitly empty mode stays invalid. Other modes retain their
existing selectors. A shared persistent asset route works when either page
is selected. Native routes share Caddy's existing per-address admission bound.
Only refused dials retry the selected upstream: accepted errors or timeouts
never fall back to another application implementation.

Both running rollback and candidate images require
`org.tarkovstats.rust-persistent-ui=v1` and
`org.tarkovstats.rust-population-api=v1` before a persistent selector is native.
Changing a selector requires recreating web and Caddy together. Install a
capable image with selectors off first, validate representative data and a
compatible rollback, then switch one mode and observe errors and latency.
Autodeployment remains enabled by the latest direct user instruction. Honor
existing deploy/data locks; do not contact the former maintenance chat.

## Server and data behavior

SSR calls the same population/progression services as the APIs, without
server-to-self HTTP. Selected and unfiltered context replies and a cheap
scheduled progression publication are included in the first HTML. A single
admission check covers the document; HEAD avoids database/compute work.
HTML is no-store and varies by Cookie/Accept-Language. Cold reference-network
requests do not delay main HTML: achievements load on the client; metric
series retain the existing successful-progression-mount fetch gate.

The bounded killable worker implements the actual Regular/PvE population
mathematics and preserves zero/known-PvP/tombstone rules, all/90d periods,
median/trimmed mean, integer-SQL edge cases and the existing response shape.
It shares an eight-job FIFO with other native calculations, rather than
creating an unbounded task pool. Persistent average jobs have a 30-second
compute deadline; other compute jobs retain 15 seconds, and custom settings
can only shorten those deadlines. The cold response cache wait is separately
bounded. This tighter native admission is not the old Next average queue of16.
Mixed-runtime resource/queue behavior still needs observation.

The shared LRU, singleflight, SWR and durable-cache format remain compatible
with TypeScript. A bounded storage thread reads existing scheduled
progression/achievement publications. Missing/corrupt publication, unsafe SQL
integers and errors retain their distinct HTTP outcomes. An old scheduled
progression publication sets publication staleness; it does not cause a new
five-second compute polling loop.

Achievement metadata uses a reused HTTPS client, bounded response bodies,
verified platform roots, normalized bilingual cache files, atomic private
writes and last-good fallback. The image includes CA certificates. Reference
refresh runs outside the shared statistical compute child. Defensive caps:
16MiB task feed,4MiB translation feed,2MiB normalized metadata file and1MiB
baseline payload. Current upstream sizes were checked once for headroom;
this does not prove unlimited future growth. Existing analytics records some
HTTP503 achievement failures as status500; this slice preserves that source
behavior. Seasonal achievements are not routed to this native service.

Existing database schemas must already be initialized by their current owner.
The read-only population/progression path does not take over schema migrations
or run TypeScript bootstrap as a fallback.

## Interface and assets

The Rust interface retains population gauges/portrait, histogram, numeric and
slider ranges, period/statistic/axis/metric controls, selection comparison,
XP progression and level overlay, metric overlays and achievements. It shares
the existing translations, CSS,79-row versioned XP snapshot and public assets.
URL/history, unknown query values, discrete inclusive edges, keyboard/focus,
responsive behavior and reduced motion remain compatibility requirements.

Two separate WASM builds avoid shipping the other page's hydration root:
`hydrate` exports ArenaApp; `hydrate-persistent` exports PersistentApp.
`scripts/build-rust-ui.mjs` builds both, or accepts a prebuilt directory with
`arena/` and `persistent/` bindgen outputs. Each package has exactly JS/WASM/CSS
with a content-addressed manifest. Persistent CSS also includes the existing
`components/arena-profile.css`, used by population gauges and comparisons.
Build-time Node CSS tooling remains temporary; native documents contain no
Next/React client runtime. Shared same-origin auth/support/telemetry endpoints
remain explicit migration dependencies.

## Evidence and remaining acceptance

Source unit/differential checks cover the real TypeScript population math,
HTTP data/status/cache behavior, progression publication and achievement
metadata/durable restart contracts. Pure UI checks compare actual TypeScript
histogram/range/XP functions and cover SSR structure. Supervision/proxy/deploy
checks exercise independent selectors, one Rust process, immutable assets,
shared admission and compatible rollback labels.

The production-image CI verifier checks each mode independently with a private
30-row real SQLite fixture and shipped asset hashes/entrypoints. Full browser
acceptance must use actual production-image Next and Rust implementations,
identical fixtures and real hydration; compilation or SSR strings alone do not
prove it. No timing/load/browser performance experiments run on the user's
active gaming PC. Synthetic CI, production observations and artifact byte sizes
must remain separate evidence. There is no claimed production speedup for
these population pages before measured rollout.


The local current-source build has one hydration root per package. Its persistent
WASM is2,360,691 bytes (gzip712,376; Brotli523,961), loader69,649 bytes
(gzip11,127; Brotli9,194), CSS175,101 bytes (gzip30,208; Brotli25,327).
These are deterministic artifact-composition observations, not browser wire sizes
or PC performance measurements; CI may produce different native artifacts.

The new API experiment uses four fresh, constrained production containers in
opposite orders,30,000 synthetic rows per mode and20 observations per timed
series. It keeps full raw replies, status failures, per-round p50/p95 and cgroup
resource observations. Each container has a360-second hard run limit and the
384MiB private tmpfs remains charged to its896MiB memory cap. The separate browser
experiment uses4fresh cold-asset and6warm PvE pairs with the declared Linux
CPU/network recipe; Regular gets functional/navigation checks, not a repeated
browser timing series. Runtime/browser execution remains required before claiming
results. Linux TLS/network reference refresh also needs a real cold-reference
check before production activation; a fresh local metadata fixture does not prove
that path. Shared UI references are fixture-isolated using a deny proxy where
applicable, not a claimed OS firewall.
