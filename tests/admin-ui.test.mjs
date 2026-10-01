import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("admin access uses only the exact Google subject and hides the page", async () => {
  const [auth, page, me] = await Promise.all([
    readFile("lib/admin-auth.ts", "utf8"),
    readFile("app/admin/page.tsx", "utf8"),
    readFile("app/api/auth/me/route.ts", "utf8"),
  ]);
  assert.match(auth, /adminSub && user\?\.sub === adminSub/);
  assert.doesNotMatch(auth, /user\?\.(?:email|name)\s*===/);
  assert.match(auth, /if \(!user\) return \{ ok: false, status: 401 \}/);
  assert.match(auth, /\{ ok: false, status: 403 \}/);
  assert.match(page, /getAdminSession\(\)[\s\S]*?notFound\(\)/);
  assert.match(page, /robots: \{ index: false, follow: false \}/);
  assert.match(me, /isAdmin: isAdminUser\(user\)/);
  assert.match(me, /"Cache-Control": "no-store"/);
});

test("admin UI exposes the agreed tabs, manual refresh, and guarded moderation inputs", async () => {
  const [dashboard, profile, dictionary, styles, accountsRoute] = await Promise.all([
    readFile("components/AdminDashboard.tsx", "utf8"),
    readFile("app/profile/page.tsx", "utf8"),
    readFile("lib/i18n/dictionary.ts", "utf8"),
    readFile("app/globals.css", "utf8"),
    readFile("app/api/admin/accounts/route.ts", "utf8"),
  ]);
  for (const tab of ["overview", "traffic", "accounts", "suspicious", "health", "monitoring"]) assert.match(dashboard, new RegExp(`"${tab}"`));
  assert.match(dashboard, /"showcase"/);
  assert.match(dashboard, /"support"/);
  assert.doesNotMatch(dashboard, /setInterval|autoRefresh/);
  assert.match(dashboard, /setRefreshKey\(\(key\) => key \+ 1\)/);
  // Source-shape assertions, not behaviour: this suite reads the component as text
  // because it has no DOM, so the race guard is pinned by shape. The checks below
  // name the pattern each one pins and deliberately avoid identifier names.
  const loadStart = dashboard.search(/\n {2}const \w+ = useRef\(0\);/);
  const loadEnd = dashboard.indexOf("const runAudit = useCallback");
  assert.ok(loadStart !== -1 && loadEnd > loadStart, "the load callback and its request counter must be findable");
  const loadBody = dashboard.slice(loadStart, loadEnd);
  // Each load claims a generation by incrementing the counter ref and compares it
  // against that same ref before writing, so only the newest load may touch state.
  // Both names come out of the claim, so a guard reading a second, never-incremented
  // ref cannot satisfy this.
  const claim = loadBody.match(/const (\w+) = \+\+(\w+)\.current;/);
  assert.ok(claim, "every load must claim a generation from the counter ref");
  const guard = loadBody.match(new RegExp(`const (\\w+) = \\(\\) => !mounted\\.current \\|\\| ${claim[1]} !== ${claim[2]}\\.current;`))?.[1];
  assert.ok(guard, "the claimed generation must be re-checked against the same counter ref");
  // The guard is checked before each fetched payload write, one per tab, so no
  // superseded load can leave a panel half-updated, and every one of those fetches
  // carries the controller's signal, so the loser is cancelled on each route too.
  // Pinned per setter and route: a single guard, or a single `signal:` somewhere in
  // `load`, would satisfy a count but not these sites. The source is read raw, so
  // the line breaks are matched CRLF-tolerantly.
  for (const [setter, route] of [["Summary", "summary"], ["Audit", "data-audit"], ["Showcase", "showcase"], ["Traffic", "traffic"], ["SystemMetrics", "system-metrics"], ["Accounts", "accounts"]]) {
    assert.match(loadBody, new RegExp(`if \\(${guard}\\(\\)\\) return;\\r?\\n\\s+set${setter}\\(`), `set${setter} must be written only by the newest load`);
    assert.match(loadBody, new RegExp(`getJson<[^>]*>\\(["'\`]\\/api\\/admin\\/${route}[^)\r\n]*, \\{ signal: request\\.signal \\}\\)`), `the /api/admin/${route} request must carry the abort signal`);
  }
  // A silent moderation reload keeps the panel mounted; only the current load
  // may clear the flags, regardless of whether that load set `loading`.
  assert.match(loadBody, /setRefreshError\(""\);\s*setReloading\(true\);\s*if \(!options\?\.silent\) \{ setLoading\(true\); setError\(""\); \}/);
  assert.match(loadBody, new RegExp(`finally \\{ if \\(!${guard}\\(\\)\\) \\{ setReloading\\(false\\); setLoading\\(false\\); \\} \\}`));
  // No payload is written straight from the fetch, which would skip the guard.
  assert.doesNotMatch(loadBody, /await getJson[^\n]*\r?\n\s*set[A-Z]\w*\(/);
  // The search box writes on every keystroke, so `load` must read a debounced copy
  // of the term; the immediate loads (filters, tabs, refresh, retry) stay immediate.
  const setter = dashboard.match(/window\.setTimeout\(\(\) => set(\w+)\(search\), 250\)/)?.[1];
  assert.ok(setter, "the search term feeding load must be debounced by 250 ms");
  const debounced = setter[0].toLowerCase() + setter.slice(1);
  assert.match(dashboard, /window\.clearTimeout\(timer\)/);
  assert.match(loadBody, new RegExp(`\\[domain, mode, period, ${debounced}, sort, tab, t\\]`));
  assert.match(dashboard, /useEffect\(\(\) => \{ void load\(\); \}, \[load, refreshKey\]\);/);
  assert.match(dashboard, /role="tablist"/);
  assert.match(dashboard, /confirmAid: Number\(confirmAid\)/);
  assert.match(dashboard, /!reason\.trim\(\)/);
  assert.match(dashboard, /maxLength=\{2000\}/);
  assert.match(dashboard, /import \{ appRouteMode, GAME_MODES/);
  assert.match(dashboard, /return `\/player\/\$\{appRouteMode\(mode\)\}\/\$\{aid\}`/);
  assert.match(dashboard, /href=\{profileHref\(account\.aid, defaultMode\)\}/);
  assert.match(dashboard, /href=\{profileHref\(account\.aid, mode\)\}/);
  assert.match(dashboard, /onClick=\{\(event\) => event\.stopPropagation\(\)\}/);
  assert.match(dashboard, /onKeyDown=\{\(event\) => event\.stopPropagation\(\)\}/);
  assert.match(dashboard, /const riskMode = moderation\?\.risk\?\.mode/);
  assert.match(dashboard, /moderation\.risk\.mode/);
  assert.match(dashboard, /moderation\?\.risk\?\.profileUpdatedAt/);
  assert.match(dashboard, /admin\.health\.scope/);
  assert.match(dashboard, /\["15m", "24h", "7d", "30d", "90d"\]/);
  assert.match(dashboard, /healthPhaseLabel/);
  assert.match(dictionary, /"admin\.period\.15m": "15 minutes"/);
  assert.match(dictionary, /"admin\.period\.15m": "15 минут"/);
  assert.match(profile, /isAdmin && <Link href="\/admin"/);
  assert.match(dictionary, /"profile\.admin": "Admin console"/);
  assert.match(dictionary, /"admin\.account\.openProfile": "Open \{mode\} profile"/);
  assert.match(dictionary, /"admin\.account\.profileUpdated": "Profile updated \(MSK\)"/);
  assert.match(dictionary, /"admin\.source\.reported": "Marked suspicious: \{n\}"/);
  assert.match(dictionary, /"admin\.suspicious\.heading": "Awaiting a decision"/);
  assert.match(dictionary, /"admin\.suspicious\.confirmedHeading": "Confirmed global bans"/);
  assert.match(dictionary, /"admin\.metric\.newSuspicious": "Awaiting review \(total\)"/);
  assert.match(dictionary, /"admin\.metric\.severeRisk": "Severe risk \(total\)"/);
  assert.match(dictionary, /"admin\.metric\.accountRequests": "Exact nickname searches"/);
  assert.match(dictionary, /"admin\.account\.requests": "Exact nickname searches"/);
  assert.match(dictionary, /"admin\.account\.last": "Last exact nickname search \(MSK\)"/);
  assert.match(dictionary, /"admin\.sort\.last": "Latest exact nickname search"/);
  assert.match(dictionary, /"admin\.sort\.requests": "Most exact nickname searches"/);
  assert.match(dictionary, /"admin\.account\.snapshots": "Snapshots \(all time\)"/);
  assert.match(dictionary, /"admin\.health\.scope": "Health counts cover only API routes instrumented by local request timing/);
  assert.match(dictionary, /"admin\.health\.lastProfile": "Last profile API call \(MSK\)"/);
  assert.match(dictionary, /"admin\.account\.openProfile": "Открыть профиль \{mode\}"/);
  assert.match(dictionary, /"admin\.account\.profileUpdated": "Профиль обновлён \(МСК\)"/);
  assert.match(dictionary, /"admin\.source\.reported": "Отмечен подозрительным: \{n\}"/);
  assert.match(dictionary, /"admin\.suspicious\.heading": "Ожидают решения"/);
  assert.match(dictionary, /"admin\.suspicious\.confirmedHeading": "Подтверждённые глобальные баны"/);
  assert.match(dictionary, /"admin\.metric\.newSuspicious": "Ожидают проверки \(итого\)"/);
  assert.match(dictionary, /"admin\.metric\.severeRisk": "Критический риск \(итого\)"/);
  assert.match(dictionary, /"admin\.metric\.accountRequests": "Точные поиски по никнейму"/);
  assert.match(dictionary, /"admin\.account\.requests": "Точные поиски по никнейму"/);
  assert.match(dictionary, /"admin\.account\.last": "Последний точный поиск по никнейму \(МСК\)"/);
  assert.match(dictionary, /"admin\.sort\.last": "По последнему точному поиску по никнейму"/);
  assert.match(dictionary, /"admin\.sort\.requests": "По числу точных поисков по никнейму"/);
  assert.match(dictionary, /"admin\.account\.snapshots": "Снимки \(за всё время\)"/);
  assert.match(dictionary, /"admin\.health\.scope": "Показатели состояния включают только API-маршруты/);
  assert.match(dictionary, /"admin\.health\.lastProfile": "Последний вызов API профиля \(МСК\)"/);
  assert.match(styles, /\.admin-account__mode-link/);
  assert.match(dashboard, /reportedMode && profileModes\.includes\(reportedMode\)/);
  assert.match(dashboard, /admin\.account\.reportedModes/);
  assert.match(dashboard, /const confirmed = data\.accounts\.filter/);
  assert.match(accountsRoute, /storedReportNicknames/);
  assert.match(accountsRoute, /account\.confirmedBan \|\| account\.review\.status !== "false_positive"/);
  assert.match(accountsRoute, /reportedModes: report\.modes/);
  assert.match(dictionary, /"profile\.admin": "Админ-панель"/);
  assert.match(styles, /@media \(max-width: 420px\)[\s\S]*?\.admin-metrics/);
  assert.match(dashboard, /useMemo/);
  assert.match(dashboard, /onPointerMove=\{moveToPointer\}/);
  assert.match(dashboard, /onPointerDown=\{moveToPointer\}/);
  assert.match(dashboard, /ArrowLeft.*ArrowRight.*Home.*End/);
  assert.match(dashboard, /admin-chart__crosshair/);
  assert.match(dashboard, /admin-chart__line--visits/);
  assert.match(dashboard, /admin-chart-stage/);
  assert.match(dashboard, /admin-chart-overlay/);
  assert.match(dashboard, /chartHeight = 58/);
  assert.match(dashboard, /preserveAspectRatio="none"/);
  assert.match(dashboard, /admin\.chart\.description/);
  assert.match(dictionary, /"admin\.chart\.description": "Hourly Cloudflare Web Analytics \(RUM\) data, shown in MSK\. One visit can include multiple pageviews\."/);
  assert.match(dictionary, /"admin\.chart\.description": "Почасовые данные Cloudflare Web Analytics \(RUM\), время указано по МСК\. Один визит может включать несколько просмотров страниц\."/);
  assert.match(styles, /\.admin-chart-description/);
  assert.match(dashboard, /formatChartDate/);
  assert.match(dashboard, /aria-live="polite"/);
  assert.match(dashboard, /aria-keyshortcuts="ArrowLeft ArrowRight Home End"/);
  assert.match(dictionary, /"admin\.chart\.selection": "Selected \{date\}: \{pageviews\} pageviews · \{visits\} visits"/);
  assert.match(dictionary, /"admin\.chart\.selection": "Выбрано \{date\}: просмотры страниц — \{pageviews\} · визиты — \{visits\}"/);
  assert.match(styles, /\.admin-chart-wrap/);
  assert.match(styles, /\.admin-chart__line--visits[\s\S]*?stroke-dasharray/);
  assert.match(styles, /\.admin-chart-legend__swatch--visits[\s\S]*?border-top-style: dashed/);
  assert.match(dashboard, /\/api\/admin\/system-metrics/);
  assert.match(dashboard, /function SystemMonitoringPanel/);
  assert.match(dashboard, /function SystemMetricChart/);
  assert.match(dashboard, /function SystemMetricsTable/);
  assert.match(dashboard, /admin\.monitoring\.notConfigured/);
  assert.match(dashboard, /tab !== "monitoring"/);
  assert.match(dictionary, /"admin\.tab\.monitoring": "Monitoring"/);
  assert.match(dictionary, /"admin\.tab\.monitoring": "Мониторинг"/);
  assert.match(dictionary, /"admin\.monitoring\.chart\.diskIo": "Disk activity"/);
  assert.match(dictionary, /"admin\.monitoring\.chart\.diskIo": "Нагрузка на диск"/);
  assert.match(styles, /\.admin-monitoring-grid/);
  assert.match(styles, /\.admin-monitoring-chart__line--2[\s\S]*?stroke-dasharray/);
  assert.match(styles, /\.admin-monitoring-table > summary[\s\S]*?min-height: 44px/);
});

test("suspicious queue enriches stored nicknames only after pagination (N+1 guard)", async () => {
  const accountsRoute = await readFile("app/api/admin/accounts/route.ts", "utf8");
  // Must not fan out stored reads over the whole reviews() table.
  assert.doesNotMatch(accountsRoute, /storedReportNicknames\(reportRows/);
  assert.match(accountsRoute, /storedReportNicknames\(pageReports/);
  // Order: filter -> sort -> slice -> stored lookup. Slice must precede the lookup.
  const sliceIdx = accountsRoute.indexOf(".slice(0, limit)");
  const lookupIdx = accountsRoute.indexOf("await storedReportNicknames(");
  assert.ok(sliceIdx !== -1 && lookupIdx !== -1 && sliceIdx < lookupIdx, "stored lookup must run after slice(0, limit)");
  // The paged slice is built from filtered/sorted rows, then enriched.
  assert.match(accountsRoute, /const filteredSuspicious = suspiciousOnly/);
  assert.match(accountsRoute, /const pageSlice = suspiciousOnly \? filteredSuspicious\.slice\(0, limit\)/);
  assert.match(accountsRoute, /nickname: account\.nickname \?\? storedNicknames\.get\(account\.aid\)/);
});

test("suspicious queue resolves seasonal nicknames per-mode and documents ban-wins", async () => {
  const [accountsRoute, db] = await Promise.all([
    readFile("app/api/admin/accounts/route.ts", "utf8"),
    readFile("lib/community-reports-db.ts", "utf8"),
  ]);
  // Bug 2: iterate per-mode, not via latest report.mode; use per-mode seasonal cycle.
  assert.match(accountsRoute, /if \(reportMode === "seasonal"\)/);
  assert.match(accountsRoute, /report\.seasonalCycleId/);
  assert.doesNotMatch(accountsRoute, /\? report\.mode === "seasonal"\s*\n?\s*\? \(await seasonalStore/);
  assert.match(db, /seasonal_cycle_id/);
  assert.match(db, /seasonalCycleId/);
  // Bug 3: deterministic modes order.
  assert.match(db, /\.split\(","\)\.filter\(Boolean\)\.sort\(\)/);
  // Bug 4: ban-wins precedence is documented and enforced.
  assert.match(accountsRoute, /ban-wins/);
  assert.match(accountsRoute, /account\.confirmedBan \|\| account\.review\.status !== "false_positive"/);
});

test("a moderation result message survives the refresh it triggers", async () => {
  const dashboard = await readFile("components/AdminDashboard.tsx", "utf8");

  // The result is not the row's own any more: it lives in AdminDashboard, above
  // the render gate, so no reload can destroy it before it paints.
  assert.match(dashboard, /const \[resultMessage, setResultMessage\] = useState\(""\);/);
  assert.match(dashboard, /<AccountsPanel[^>]*onResult=\{setResultMessage\}/);
  const notice = dashboard.indexOf('{resultMessage && <p className="admin-notice" role="status">{resultMessage}</p>}');
  const gate = dashboard.indexOf('{!error && !loading && (tab === "accounts" || tab === "suspicious")');
  assert.ok(notice !== -1 && gate !== -1 && notice < gate, "the result message must render above the !loading gate");
  // The suspicious tab splits pending/confirmed by confirmedBan, so confirming
  // or restoring a ban moves the row into the other <AccountList> and React
  // remounts AccountRow/ModerationForm. Nothing message-shaped may be left in
  // that subtree for the regroup to throw away.
  const form = dashboard.slice(dashboard.indexOf("function ModerationForm("), dashboard.indexOf("function healthPercent("));
  assert.doesNotMatch(form, /const \[message, setMessage\] = useState/);
  assert.doesNotMatch(form, /\{message &&/);
  assert.match(form, /onResult: \(message: string\) => void/);
  // The success and the save-error paths stay distinguishable, the success path
  // still triggers the silent reload, and each mutation clears the last result.
  assert.match(form, /onResult\(""\);/);
  assert.match(form, /onResult\(t\("admin\.saved"\)\); await reload\(\{ silent: true \}\);/);
  assert.match(form, /catch \{ onResult\(t\("admin\.error\.save"\)\); \}/);
  // A silent load must not touch the two pieces of state the render gate reads.
  assert.match(dashboard, /const generation = \+\+loadGeneration\.current;/);
  assert.match(dashboard, /const stale = \(\) => !mounted\.current \|\| generation !== loadGeneration\.current;/);
  assert.match(dashboard, /setReloading\(true\);\s*if \(!options\?\.silent\) \{ setLoading\(true\); setError\(""\); \}/);
  // The newest load clears `loading` whether or not it set it, so a silent
  // reload cannot strand the panel behind a flag it never claimed.
  assert.match(dashboard, /finally \{ if \(!stale\(\)\) \{ setReloading\(false\); setLoading\(false\); \} \}/);
  // A failed silent reload still has to be reported, and `error` would unmount
  // the panel, so it lands in `refreshError`, announced as the error it is.
  assert.match(dashboard, /catch \{ if \(stale\(\)\) return; if \(options\?\.silent\) setRefreshError\(t\("admin\.error\.load"\)\); else setError\(t\("admin\.error\.load"\)\); \}/);
  assert.match(dashboard, /\{refreshError && <div className="admin-notice admin-notice--error" role="alert">\{refreshError\} <button type="button" onClick=\{\(\) => setRefreshKey\(\(key\) => key \+ 1\)\}>\{t\("admin\.retry"\)\}/);
  // Refresh cannot start a non-silent load while one is in flight, and the
  // initial/refresh/filter loads stay non-silent.
  assert.match(dashboard, /disabled=\{loading \|\| reloading\}/);
  assert.match(dashboard, /useEffect\(\(\) => \{ void load\(\); \}, \[load, refreshKey\]\);/);
  // Every reload consumer has to accept the option.
  for (const line of dashboard.split("\n").filter((text) => text.includes("reload: ("))) {
    assert.match(line, /reload: \(options\?: \{ silent\?: boolean \}\) => Promise<void>/);
  }
});

test("admin dashboard drops load and audit results after unmount", async () => {
  const dashboard = await readFile("components/AdminDashboard.tsx", "utf8");

  assert.match(dashboard, /const mounted = useRef\(true\);/);
  assert.match(dashboard, /useEffect\(\(\) => \{\s*mounted\.current = true;\s*return \(\) => \{ mounted\.current = false; \};\s*\}, \[\]\);/);
  // The load generation guard covers both a newer request and unmount; the
  // existing load test pins every response write to that guard.
  assert.match(dashboard, /const stale = \(\) => !mounted\.current \|\| generation !== loadGeneration\.current;/);
  assert.match(dashboard, /if \(mounted\.current\) setAudit\(body\);/);
  assert.match(dashboard, /if \(response\.status === 409 && mounted\.current\) setAuditError\(/);
  assert.match(dashboard, /catch \{ if \(mounted\.current\) setAuditError\(t\("admin\.error\.load"\)\); \}/);
  assert.match(dashboard, /finally \{ if \(mounted\.current\) setAuditBusy\(false\); \}/);
});

test("the suspicious queue reports missing report storage as unavailable", async () => {
  const [accountsRoute, reportsDb] = await Promise.all([
    readFile("app/api/admin/accounts/route.ts", "utf8"),
    readFile("lib/community-reports-db.ts", "utf8"),
  ]);
  // getCommunityReportsStore() resolves to null for a missing binding or an
  // unopenable SQLite file; it does not throw. reviews() is async in both store
  // implementations, so .catch only ever sees a throwing query and the store's
  // own null is the only "storage missing" signal. Coalescing that null into a
  // list before the availability check made the available:false branch
  // unreachable and showed the console an empty queue instead of the warning.
  assert.match(reportsDb, /return sqlite \? createSqliteCommunityReportsStore\(sqlite\) : null;/);
  // Pin the window between resolving the store and the empty-list fallback
  // rather than the exact lines in it: a rewrap, a different variable name, or
  // .then instead of await must not fail this test.
  const resolveIdx = accountsRoute.indexOf("getCommunityReportsStore()");
  const degradeIdx = accountsRoute.search(/\?\?\s*\[\]|\|\|\s*\[\]/);
  assert.ok(resolveIdx !== -1 && degradeIdx > resolveIdx, "reports must degrade to an empty list only after the storage check");
  const guard = accountsRoute.slice(resolveIdx, degradeIdx);
  assert.match(guard, /suspiciousOnly[\s\S]*?===\s*null/);
  assert.match(guard, /NextResponse\.json\(\{[\s\S]*?available: false/);
});
