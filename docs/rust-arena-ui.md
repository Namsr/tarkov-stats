# Rust Arena population interface

The native slice owns `/population/arena`, `/average/arena` (308 with query),
and the first decoded `mode=arena` branch of `/api/average`. The final project
scope remains all backend and frontend application logic in Rust; this slice
is an incremental step. Remaining pages, authentication/session endpoints,
support, telemetry and background collectors still use the legacy runtime.

## Runtime boundary

`ARENA_UI_UPSTREAM=web:3000|web:3001` defaults to Next. The native value starts
one supervised Rust server, even when Seasonal/Home selectors remain on Next.
Caddy routes Arena HTML, immutable assets and its API together; other average
modes stay on Next. Encoded query keys/values and duplicate mode parameters
follow URLSearchParams first-value semantics. The per-address Caddy admission
bound remains shared across all native routes. Proxy retry only handles refused
dials; accepted requests are not replayed. Port3001 remains internal.

Next ProfileModeSwitch uses plain anchors for the selected Rust boundary.
Its activation boolean is read on the server and does not expose environment
values to the browser. Rust links to remaining Next pages are document links.
No React, Next RSC implementation or Next scripts are shipped in Arena HTML.

The candidate AND rollback image require `org.tarkovstats.rust-arena-ui=v1`.
A selector change recreates both web and Caddy. Health checks inspect the actual
running selectors and require the native health endpoint when any is selected.
Keep the user-disabled `tarkovstats-deploy.timer` stopped. A source merge does
not activate native routes or demonstrate production improvement.

## Data and SSR

ArenaService is shared directly by SSR and the native API, without HTTP calls
to Next or itself. It preserves all five Arena modes, both statistics, both
histogram dimensions, six metrics, four ranges per mode, default minimum10
matches, standard publication selection and dynamic-cache interoperability.

The existing killable Rust cohort child owns the math. Seasonal/Arena jobs
share the bounded eight-job compute queue and15second lifecycle deadline.
Standard publications have the existing6.5hour maximum age and honor their
own enable flag; publicationOnly cannot bypass a disabled gate. Dynamic Arena
cache uses15minute freshness, durable versioned keys and legacy stable fallback,
stale-while-revalidate and cooldown. Invalid requests, unavailable publications,
queue/deadline/compute failure, retry headers and analytics have differential
coverage. Invalid nested publication data fails safely instead of crashing UI.
Unsafe SQLite integers fail closed consistently with node:sqlite decoding;
legacy optional null/absent population fields remain accepted.

SSR loads selected and stable unfiltered context concurrently and includes
useful numbers, mode counts, metric cards and histogram in its first document.
Request locale uses existing cookie/Accept-Language behavior. HTML is no-store
and varies by Cookie/Accept-Language. HEAD avoids database/compute work.
Leptos streaming SSR initializes the Tokio executor explicitly.

## Client and shared shell

Rust/Leptos islands hydrate through WebAssembly. Shared state/range/formatting
logic serves both SSR and browser. Filters preserve unknown query values/hash,
per-mode settings, history/popstate and inclusive discrete bucket edges.
Weighted adaptive histograms retain stable unfiltered context. Numeric fields
accept valid values outside current sample bounds; sliders clamp to the sample
and expose actual localized values to assistive technology. A native GET form
and bucket links remain usable without successful hydration.

The client shares in-flight requests, cancels unwanted demand, bounds its cache
and speculative prefetch, respects visibility/connection/saveData gates and
uses stale/retry refresh rules. Fresh SSR responses seed the cache and their
generation timestamps prevent older responses replacing newer SSR data.

The public shell retains existing CSS/components' structure: responsive header
and footer, authentication controls, language/theme, support notice, FAQ dialog,
focus trap/return, Escape, reduced motion, skip link and bounded privacy-aware
pageview/performance beacons. EN/RU dictionary values are shared with remaining
TypeScript through `lib/i18n/messages.json`; browser language changes do not
reload Arena data. Authentication/support endpoints are transitional Node calls.

During coexistence the native Arena limiter has a separate300requests/minute
trusted-IP bucket from remaining Next average routes, with a bounded5000-IP map.
This difference is deliberate and must be considered during mixed-load rollout.
Only configured trusted headers establish identity. Public project URLs and
analytics hostname/token mappings are temporarily mirrored in Rust until the
remaining shell/backend configuration is migrated.

## Build and validation

Rust1.98.1, locked Leptos0.8.22 and wasm-bindgen0.2.129 build the SSR/native and
wasm32 client targets. Official CLI archives are checksum verified. Build-time
Node/PostCSS reuses existing Tailwind/CSS; it does not implement Arena runtime
logic. Docker ships compiled Rust binaries plus three content-addressed assets.
The server verifies exact filenames, byte limits and SHA256 before startup,
serves allowlisted hashes only and provides immutable cache/ETag/HEAD contracts.
The output directory is ignored; generated dependencies/binaries are not committed.

Checks include native API HTTP differential tests, real SSR/asset HTTP tests,
actual TypeScript/Rust range/format/state contracts, Rust unit tests and strict
Clippy for SSR and actual wasm32 hydration, real Caddy routing/overload and
supervisor/deployment compatibility. CI additionally exercises the real image
and reports isolated Linux API benchmark evidence.

Local real browser checks currently cover loading/hydration, controls, numeric
Enter, localization/theme, FAQ focus/Escape, responsive360/1280layouts and actual
NextPvE-to-RustArena document navigation. Final review/CI and complete browser
measurement are still pending. No production latency/resource gain is claimed.
