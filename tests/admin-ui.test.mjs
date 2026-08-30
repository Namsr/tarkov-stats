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
  const [dashboard, profile, dictionary, styles] = await Promise.all([
    readFile("components/AdminDashboard.tsx", "utf8"),
    readFile("app/profile/page.tsx", "utf8"),
    readFile("lib/i18n/dictionary.ts", "utf8"),
    readFile("app/globals.css", "utf8"),
  ]);
  for (const tab of ["overview", "traffic", "accounts", "suspicious", "health", "monitoring"]) assert.match(dashboard, new RegExp(`"${tab}"`));
  assert.doesNotMatch(dashboard, /setInterval|autoRefresh/);
  assert.match(dashboard, /setRefreshKey\(\(key\) => key \+ 1\)/);
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
  assert.match(profile, /isAdmin && <Link href="\/admin"/);
  assert.match(dictionary, /"profile\.admin": "Admin console"/);
  assert.match(dictionary, /"admin\.account\.openProfile": "Open \{mode\} profile"/);
  assert.match(dictionary, /"admin\.account\.profileUpdated": "Profile updated \(MSK\)"/);
  assert.match(dictionary, /"admin\.source\.reported": "Marked suspicious: \{n\}"/);
  assert.match(dictionary, /"admin\.suspicious\.heading": "Accounts marked suspicious by users"/);
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
  assert.match(dictionary, /"admin\.suspicious\.heading": "Аккаунты, отмеченные пользователями как подозрительные"/);
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
