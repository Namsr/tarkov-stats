"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import StatCard from "@/components/StatCard";
import { useI18n } from "@/lib/i18n/context";
import type { AdminDomain, AdminPeriod } from "@/lib/admin/types";
import type { AccountModeration } from "@/lib/admin/moderation-db";
import { appRouteMode, GAME_MODES, type GameMode } from "@/types/seasonal";

type Tab = "overview" | "traffic" | "accounts" | "suspicious" | "health" | "monitoring";
type MetricName = "visits" | "pageviews" | "accountRequests" | "newSuspicious" | "severeRisk" | "errors";
type Metrics = Record<MetricName, number>;
type SeriesPoint = { at: string; domains: Record<string, { pageviews: number; visits: number }> };
type HealthOperationVariant = { source: string | null; cache: string | null; force: boolean | null; requests: number; p50Ms: number | null; p95Ms: number | null; p99Ms: number | null };
type HealthOperation = { operation: string; mode: string | null; requests: number; success: number; serverErrors: number; rateLimited: number; p50Ms: number | null; p95Ms: number | null; p99Ms: number | null; lastSuccessAt: number | null; lastIssueAt: number | null; variants: HealthOperationVariant[] };
type HealthIssue = { operation: string; mode: string | null; stage: string; code: string; status: number; count: number; activeCount: number; firstSeenAt: number; lastSeenAt: number; maxLatencyMs: number; active: boolean; severity: "warning" | "critical" };
type HealthSeriesPoint = { at: number; requests: number; problems: number; p50Ms: number | null; p95Ms: number | null; p99Ms: number | null };
type Health = { requests: number; success: number; notFound: number; rateLimited: number; serverErrors: number; p50Ms: number | null; p95Ms: number | null; p99Ms: number | null; lastSuccessAt: number | null; cacheHits: number; cacheMisses: number; status: "healthy" | "degraded" | "incident"; statusSinceAt: number | null; activeIssueCount: number; recentIssueCount: number; operations: HealthOperation[]; issues: HealthIssue[]; series: HealthSeriesPoint[] };
type Summary = { generatedAt: number; period: AdminPeriod; domain: AdminDomain; metrics: Metrics; previous: Metrics; series: SeriesPoint[]; health: Health | null; freshness: { lastEventAt: number | null; lastProfileRequestAt: number | null } | null; auth?: { activeUsers: number; signIns: number }; storageAvailable: boolean; traffic: { available: boolean; reason?: string; sampled: boolean; from: string; to: string } };
type HealthSignal = { status: "healthy" | "degraded" | "incident"; activeIssueCount: number; firstSeenAt: number | null; lastSeenAt: number | null; storageAvailable?: boolean };
type AuditDataset = { mode: "regular" | "pve" | "arena" | "pvp-season"; dataset: "index" | "updated"; status: "ok" | "unavailable"; upstreamRecordCount: number | null; localMatchingCount: number | null; localCurrentCount: number | null; missingCount: number | null; staleCount: number | null; coveragePercent: number | null; lastCheckedAt: number | null; lastReceivedAt: number | null; lastLocalApplyAt: number | null; latestUpstreamUpdatedAt: number | null; error: string | null };
type DataAudit = { available: boolean; running: boolean; runId: string | null; startedAt: number | null; error: string | null; snapshot: { status: "success" | "partial" | "error"; finishedAt: number; datasets: AuditDataset[] } | null };
type Rank = { key: string; pageviews: number; visits: number };
type Traffic = { available: boolean; reason?: string; sampled: boolean; pageviews: number; visits: number; series: SeriesPoint[]; domains: Rank[]; pages: Rank[]; referrers: Rank[]; countries: Rank[]; devices: Rank[]; browsers: Rank[] };
type Account = { aid: number; nickname: string | null; modes: string[]; requestCount: number; snapshotCount: number; lastRequestedAt: number; reportedAt?: number; outcomes: Record<string, number>; refreshCount: number; sources: string[]; moderation?: AccountModeration; risk?: AccountModeration["risk"]; reportCount?: number; confirmedBan?: boolean; review?: AccountModeration["review"]; canRestoreManualBan?: boolean };
type Accounts = { available: boolean; accounts: Account[]; nextCursor: string | null };
type SystemMetricPoint = { at: number; cpuPercent: number | null; memoryUsedBytes: number; memoryPercent: number; swapUsedBytes: number; swapPercent: number | null; diskUsedBytes: number; diskPercent: number; diskReadBytesPerSecond: number | null; diskWriteBytesPerSecond: number | null; networkRxBytesPerSecond: number | null; networkTxBytesPerSecond: number | null; load1: number; load5: number; load15: number; uptimeSeconds: number };
type SystemMetricSnapshot = SystemMetricPoint & { memoryTotalBytes: number; swapTotalBytes: number; diskTotalBytes: number; diskAvailableBytes: number };
type SystemMetrics = { available: boolean; configured: boolean; reason?: string; latest: SystemMetricSnapshot | null; points: SystemMetricPoint[]; sampleCount?: number; from?: number; to?: number };

const tabs: Tab[] = ["overview", "traffic", "accounts", "suspicious", "health", "monitoring"];
const periods: AdminPeriod[] = ["24h", "7d", "30d", "90d"];
const domains: AdminDomain[] = ["all", "tarkovstats.ru", "tarkovstats.online"];
const EMPTY_METRICS: Metrics = { visits: 0, pageviews: 0, accountRequests: 0, newSuspicious: 0, severeRisk: 0, errors: 0 };

function isProfileMode(value: string): value is GameMode { return GAME_MODES.includes(value as GameMode); }
function profileHref(aid: number, mode: GameMode): string { return `/player/${appRouteMode(mode)}/${aid}`; }

function finite(value: unknown): number { return typeof value === "number" && Number.isFinite(value) ? value : 0; }
function formatNumber(value: number): string { return new Intl.NumberFormat().format(value); }
function metricDiff(current: number, previous: number): number | null { return previous > 0 ? (current - previous) / previous * 100 : null; }
function validTab(value: string | null): Tab { return tabs.includes(value as Tab) ? value as Tab : "overview"; }

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  if (!response.ok) throw new Error(String(response.status));
  return response.json() as Promise<T>;
}

export default function AdminDashboard() {
  const { t, lang } = useI18n();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [tab, setTab] = useState<Tab>(() => validTab(searchParams.get("tab")));
  const [period, setPeriod] = useState<AdminPeriod>(() => periods.includes(searchParams.get("period") as AdminPeriod) ? searchParams.get("period") as AdminPeriod : "7d");
  const [domain, setDomain] = useState<AdminDomain>(() => domains.includes(searchParams.get("domain") as AdminDomain) ? searchParams.get("domain") as AdminDomain : "all");
  const [search, setSearch] = useState("");
  const [mode, setMode] = useState("");
  const [sort, setSort] = useState<"last" | "requests" | "snapshots">("last");
  const [summary, setSummary] = useState<Summary | null>(null);
  const [traffic, setTraffic] = useState<Traffic | null>(null);
  const [accounts, setAccounts] = useState<Accounts | null>(null);
  const [systemMetrics, setSystemMetrics] = useState<SystemMetrics | null>(null);
  const [healthSignal, setHealthSignal] = useState<HealthSignal | null>(null);
  const [audit, setAudit] = useState<DataAudit | null>(null);
  const [auditBusy, setAuditBusy] = useState(false);
  const [auditError, setAuditError] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

  const updateUrl = useCallback((nextTab: Tab, nextPeriod = period, nextDomain = domain) => {
    const params = new URLSearchParams();
    if (nextTab !== "overview") params.set("tab", nextTab);
    if (nextPeriod !== "7d") params.set("period", nextPeriod);
    if (nextDomain !== "all") params.set("domain", nextDomain);
    router.replace(`${pathname}${params.size ? `?${params}` : ""}`, { scroll: false });
  }, [domain, pathname, period, router]);

  const load = useCallback(async () => {
    setLoading(true); setError("");
    const params = new URLSearchParams({ period, domain });
    try {
      if (tab === "overview" || tab === "health") {
        setSummary(await getJson<Summary>(`/api/admin/summary?${params}`));
        if (tab === "health") {
          setAuditError("");
          try { setAudit(await getJson<DataAudit>("/api/admin/data-audit")); }
          catch { setAuditError(t("admin.error.load")); }
        }
      } else if (tab === "traffic") {
        setTraffic(await getJson<Traffic>(`/api/admin/traffic?${params}`));
      } else if (tab === "monitoring") {
        setSystemMetrics(await getJson<SystemMetrics>(`/api/admin/system-metrics?${params}`));
      } else {
        if (mode) params.set("mode", mode);
        if (search.trim()) params.set("search", search.trim());
        params.set("sort", sort);
        if (tab === "suspicious") params.set("source", "suspicious");
        setAccounts(await getJson<Accounts>(`/api/admin/accounts?${params}`));
      }
    } catch { setError(t("admin.error.load")); }
    finally { setLoading(false); }
  }, [domain, mode, period, search, sort, tab, t]);

  const runAudit = useCallback(async () => {
    setAuditBusy(true); setAuditError("");
    try {
      const response = await fetch("/api/admin/data-audit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: "{}",
      });
      const body = await response.json() as DataAudit;
      if (!response.ok && response.status !== 409) throw new Error(String(response.status));
      setAudit(body);
      if (response.status === 409) setAuditError(t("admin.audit.running"));
    } catch { setAuditError(t("admin.error.load")); }
    finally { setAuditBusy(false); }
  }, [t]);

  useEffect(() => { void load(); }, [load, refreshKey]);
  useEffect(() => {
    let current = true;
    setHealthSignal(null);
    void getJson<HealthSignal>(`/api/admin/health-signal?domain=${encodeURIComponent(domain)}`)
      .then((value) => { if (current) setHealthSignal(value); })
      .catch(() => { if (current) setHealthSignal({ status: "degraded", activeIssueCount: 0, firstSeenAt: null, lastSeenAt: null, storageAvailable: false }); });
    return () => { current = false; };
  }, [domain, refreshKey]);

  function chooseTab(value: Tab) { setTab(value); updateUrl(value); }
  function choosePeriod(value: AdminPeriod) { setPeriod(value); updateUrl(tab, value, domain); }
  function chooseDomain(value: AdminDomain) { setDomain(value); updateUrl(tab, period, value); }

  return (
    <main className="page-frame admin-page">
      <div className="admin-heading">
        <div>
          <Link href="/profile" className="admin-back">{t("admin.back")}</Link>
          <p className="page-kicker">{t("admin.kicker")}</p>
          <h1 className="page-title">{t("admin.title")}</h1>
          <p className="admin-description">{t("admin.description")}</p>
        </div>
        <button type="button" className="tactical-button" disabled={loading} onClick={() => setRefreshKey((key) => key + 1)}>
          {loading ? t("common.loading") : t("admin.refresh")}
        </button>
      </div>

      <div className="admin-tabs" role="tablist" aria-label={t("admin.tabsLabel")}>
        {tabs.map((item) => <button key={item} type="button" role="tab" aria-selected={tab === item} className={tab === item ? "is-active" : ""} onClick={() => chooseTab(item)}><span>{t("admin.tab." + item)}</span>{item === "health" && healthSignal && (healthSignal.activeIssueCount > 0 || healthSignal.storageAvailable === false) && <span className={`admin-tab-alert admin-tab-alert--${healthSignal.status}`} aria-label={t("admin.health.tabAlert", { n: healthSignal.activeIssueCount })}>{healthSignal.activeIssueCount || "!"}</span>}</button>)}
      </div>

      <section className="admin-filters" aria-label={t("admin.filters") }>
        <label><span>{t("admin.period")}</span><select value={period} onChange={(event) => choosePeriod(event.target.value as AdminPeriod)}>{periods.map((item) => <option key={item} value={item}>{t("admin.period." + item)}</option>)}</select></label>
        {tab !== "monitoring" && <label><span>{t("admin.domain")}</span><select value={domain} onChange={(event) => chooseDomain(event.target.value as AdminDomain)}>{domains.map((item) => <option key={item} value={item}>{item === "all" ? t("admin.domain.all") : item}</option>)}</select></label>}
        {(tab === "accounts" || tab === "suspicious") && <>
          <label className="admin-filter-search"><span>{t("admin.search")}</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("admin.searchPlaceholder")} /></label>
          <label><span>{t("admin.mode")}</span><select value={mode} onChange={(event) => setMode(event.target.value)}><option value="">{t("admin.mode.all")}</option>{["regular", "pve", "arena", "seasonal"].map((item) => <option key={item} value={item}>{t("admin.mode." + item)}</option>)}</select></label>
          <label><span>{t("admin.sort")}</span><select value={sort} onChange={(event) => setSort(event.target.value as "last" | "requests" | "snapshots")}><option value="last">{t("admin.sort.last")}</option><option value="requests">{t("admin.sort.requests")}</option><option value="snapshots">{t("admin.sort.snapshots")}</option></select></label>
        </>}
      </section>

      {error && <div className="admin-notice admin-notice--error" role="alert">{error} <button type="button" onClick={() => setRefreshKey((key) => key + 1)}>{t("admin.retry")}</button></div>}
      {!error && loading && <AdminLoading />}
      {!error && !loading && tab === "overview" && <Overview summary={summary} lang={lang} t={t} />}
      {!error && !loading && tab === "traffic" && <TrafficPanel traffic={traffic} lang={lang} t={t} />}
      {!error && !loading && (tab === "accounts" || tab === "suspicious") && <AccountsPanel data={accounts} suspicious={tab === "suspicious"} lang={lang} t={t} reload={load} />}
      {!error && !loading && tab === "health" && <HealthPanel summary={summary} lang={lang} t={t} audit={audit} auditBusy={auditBusy} auditError={auditError} onRunAudit={runAudit} />}
      {!error && !loading && tab === "monitoring" && <SystemMonitoringPanel data={systemMetrics} lang={lang} t={t} />}
    </main>
  );
}

type T = (key: string, vars?: Record<string, string | number>) => string;

function AdminLoading() { return <div className="admin-metrics" aria-hidden>{Array.from({ length: 6 }, (_, index) => <div key={index} className="h-28 skeleton rounded-xl" />)}</div>; }

function Overview({ summary, lang, t }: { summary: Summary | null; lang: string; t: T }) {
  if (!summary) return <Empty t={t} />;
  const metrics = summary.metrics ?? EMPTY_METRICS;
  const previous = summary.previous ?? EMPTY_METRICS;
  return <div className="admin-stack">
    {(!summary.traffic?.available || !summary.storageAvailable) && <div className="admin-notice">{t(!summary.traffic?.available ? "admin.warning.traffic" : "admin.warning.storage")}</div>}
    {summary.traffic?.sampled && <div className="admin-notice">{t("admin.warning.sampled")}</div>}
    <div className="admin-metrics">{(["visits", "pageviews", "accountRequests", "newSuspicious", "severeRisk", "errors"] as MetricName[]).map((name) => <StatCard key={name} label={t("admin.metric." + name)} value={formatNumber(finite(metrics[name]))} benchmarkDiff={metricDiff(finite(metrics[name]), finite(previous[name]))} />)}</div>
    <TrendChart series={summary.series ?? []} lang={lang} t={t} />
    {summary.auth && <section className="data-panel admin-panel"><h2 className="section-heading">{t("admin.auth.heading")}</h2><div className="admin-metrics admin-metrics--small"><StatCard label={t("admin.auth.activeUsers")} value={formatNumber(summary.auth.activeUsers)} /><StatCard label={t("admin.auth.signIns")} value={formatNumber(summary.auth.signIns)} /></div></section>}
  </div>;
}

function TrendChart({ series, lang, t }: { series: SeriesPoint[]; lang: string; t: T }) {
  const points = useMemo(() => {
    const buckets = new Map<number, { at: string; time: number; pageviews: number; visits: number }>();
    for (const point of series) {
      const time = Date.parse(point.at);
      if (!Number.isFinite(time)) continue;
      const current = buckets.get(time) ?? { at: new Date(time).toISOString(), time, pageviews: 0, visits: 0 };
      for (const value of Object.values(point.domains ?? {})) {
        current.pageviews += finite(value.pageviews);
        current.visits += finite(value.visits);
      }
      buckets.set(time, current);
    }
    return [...buckets.values()].sort((a, b) => a.time - b.time);
  }, [series]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  useEffect(() => { setSelectedIndex(points.length ? points.length - 1 : 0); }, [points]);
  if (!points.length) return <Empty t={t} />;

  const left = 8;
  const right = 92;
  const top = 7;
  const bottom = 43;
  const chartHeight = 58;
  const firstTime = points[0].time;
  const lastTime = points.at(-1)!.time;
  const timeSpan = Math.max(1, lastTime - firstTime);
  const max = Math.max(1, ...points.flatMap((point) => [point.pageviews, point.visits]));
  const xFor = (time: number) => points.length === 1 ? 50 : left + (time - firstTime) / timeSpan * (right - left);
  const yFor = (value: number) => bottom - value / max * (bottom - top);
  const selected = points[Math.min(selectedIndex, points.length - 1)];
  const selectedX = xFor(selected.time);
  const date = formatChartDate(selected.time, lang);
  const pageviewsPath = points.map((point) => `${xFor(point.time)},${yFor(point.pageviews)}`).join(" ");
  const visitsPath = points.map((point) => `${xFor(point.time)},${yFor(point.visits)}`).join(" ");
  const tickIndexes = points.length < 3 ? points.map((_, index) => index) : [0, Math.floor((points.length - 1) / 2), points.length - 1];
  const anchorFor = (x: number) => x < 20 ? "start" : x > 80 ? "end" : "middle";
  const moveToPointer = (event: ReactPointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const targetX = Math.min(right, Math.max(left, (event.clientX - rect.left) / Math.max(1, rect.width) * 100));
    let nearest = 0;
    for (let index = 1; index < points.length; index += 1) {
      if (Math.abs(xFor(points[index].time) - targetX) < Math.abs(xFor(points[nearest].time) - targetX)) nearest = index;
    }
    setSelectedIndex(nearest);
  };
  const moveByKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    setSelectedIndex((index) => event.key === "Home" ? 0 : event.key === "End" ? points.length - 1 : Math.max(0, Math.min(points.length - 1, index + (event.key === "ArrowLeft" ? -1 : 1))));
  };
  const selectedPageviewsY = yFor(selected.pageviews);
  const selectedVisitsY = yFor(selected.visits);
  let pageviewsLabelY = Math.max(top + 3, Math.min(bottom - 2, selectedPageviewsY - 2));
  let visitsLabelY = Math.max(top + 3, Math.min(bottom - 2, selectedVisitsY + 4));
  if (Math.abs(pageviewsLabelY - visitsLabelY) < 4) {
    if (Math.max(pageviewsLabelY, visitsLabelY) < top + 9) {
      pageviewsLabelY = top + 3;
      visitsLabelY = top + 8;
    } else {
      pageviewsLabelY = bottom - 7;
      visitsLabelY = bottom - 2;
    }
  }
  const dateTransform = selectedX < 20 ? "translateX(0)" : selectedX > 80 ? "translateX(-100%)" : "translateX(-50%)";

  const labelTransform = anchorFor(selectedX) === "start" ? "translate(8px, -50%)" : anchorFor(selectedX) === "end" ? "translate(calc(-100% - 8px), -50%)" : "translate(-50%, -50%)";
  return <section className="data-panel admin-panel"><h2 className="section-heading">{t("admin.chart.heading")}</h2><p className="admin-chart-description">{t("admin.chart.description")}</p><div className="admin-chart-wrap" tabIndex={0} role="group" aria-label={t("admin.chart.aria")} aria-keyshortcuts="ArrowLeft ArrowRight Home End" onKeyDown={moveByKeyboard}>
    <div className="admin-chart-stage">
      <svg className="admin-chart" viewBox="0 0 100 58" preserveAspectRatio="none" aria-hidden="true" onPointerMove={moveToPointer} onPointerDown={moveToPointer}>
      <line className="admin-chart__grid" x1={left} x2={right} y1={top} y2={top} /><line className="admin-chart__grid" x1={left} x2={right} y1={bottom} y2={bottom} />
      <polyline className="admin-chart__line admin-chart__line--pageviews" points={pageviewsPath} /><polyline className="admin-chart__line admin-chart__line--visits" points={visitsPath} />
      <line className="admin-chart__crosshair" x1={selectedX} x2={selectedX} y1={top} y2={bottom} />
      <rect className="admin-chart__hit-area" x={left} y={top} width={right - left} height={bottom - top} fill="transparent" pointerEvents="all" />
      </svg>
      <div className="admin-chart-overlay" aria-hidden="true">
        <span className="admin-chart__axis admin-chart__axis--max" style={{ top: `${(top + 1) / chartHeight * 100}%` }}>{formatNumber(max)}</span><span className="admin-chart__axis admin-chart__axis--zero" style={{ top: `${(bottom + 1) / chartHeight * 100}%` }}>0</span>
        <span className="admin-chart__marker admin-chart__marker--pageviews" style={{ left: `${selectedX}%`, top: `${selectedPageviewsY / chartHeight * 100}%` }} />
        <span className="admin-chart__marker admin-chart__marker--visits" style={{ left: `${selectedX}%`, top: `${selectedVisitsY / chartHeight * 100}%` }} />
        <span className="admin-chart__value admin-chart__value--pageviews" style={{ left: `${selectedX}%`, top: `${pageviewsLabelY / chartHeight * 100}%`, transform: labelTransform }}>{formatNumber(selected.pageviews)}</span>
        <span className="admin-chart__value admin-chart__value--visits" style={{ left: `${selectedX}%`, top: `${visitsLabelY / chartHeight * 100}%`, transform: labelTransform }}>{formatNumber(selected.visits)}</span>
      </div>
    </div>
    <div className="admin-chart-axis" aria-hidden="true">{tickIndexes.map((index) => { const x = xFor(points[index].time); return <span key={points[index].time} style={{ left: `${x}%`, transform: `translateX(${anchorFor(x) === "start" ? "0" : anchorFor(x) === "end" ? "-100%" : "-50%"})` }}>{formatChartAxis(points[index].time, lang, timeSpan)}</span>; })}</div>
    <div className="admin-chart-date" style={{ left: `${selectedX}%`, transform: dateTransform }} aria-hidden="true">{date}</div>
  </div><div className="admin-chart-selection" aria-live="polite">{t("admin.chart.selection", { date, pageviews: formatNumber(selected.pageviews), visits: formatNumber(selected.visits) })}</div><div className="admin-chart-legend" aria-label={t("admin.chart.legend")}><span><i className="admin-chart-legend__swatch admin-chart-legend__swatch--pageviews" />{t("admin.metric.pageviews")}</span><span><i className="admin-chart-legend__swatch admin-chart-legend__swatch--visits" />{t("admin.metric.visits")}</span></div><p className="admin-chart-hint">{t("admin.chart.keyboard")}</p></section>;
}

function TrafficPanel({ traffic, lang, t }: { traffic: Traffic | null; lang: string; t: T }) {
  if (!traffic) return <Empty t={t} />;
  if (!traffic.available) return <div className="admin-notice">{t("admin.warning.traffic")}</div>;
  return <div className="admin-stack">{traffic.sampled && <div className="admin-notice">{t("admin.warning.sampled")}</div>}<div className="admin-metrics admin-metrics--small"><StatCard label={t("admin.metric.visits")} value={formatNumber(traffic.visits)} /><StatCard label={t("admin.metric.pageviews")} value={formatNumber(traffic.pageviews)} /></div><TrendChart series={traffic.series ?? []} lang={lang} t={t} /><div className="admin-ranks">{(["domains", "pages", "referrers", "countries", "devices", "browsers"] as const).map((name) => <RankList key={name} title={t("admin.rank." + name)} rows={traffic[name] ?? []} t={t} />)}</div></div>;
}

type SystemSeriesKey = keyof Pick<SystemMetricPoint,
  "cpuPercent" | "memoryPercent" | "swapPercent" | "diskPercent" |
  "diskReadBytesPerSecond" | "diskWriteBytesPerSecond" |
  "networkRxBytesPerSecond" | "networkTxBytesPerSecond" |
  "load1" | "load5" | "load15">;
type SystemChartSeries = { key: SystemSeriesKey; label: string; format: (value: number) => string };

function SystemMonitoringPanel({ data, lang, t }: { data: SystemMetrics | null; lang: string; t: T }) {
  if (!data?.available) return <div className="admin-notice">{t("admin.monitoring.storageUnavailable")}</div>;
  const latest = data.latest;
  if (!latest) return <div className="admin-stack">{!data.configured && <div className="admin-notice">{t("admin.monitoring.notConfigured")}</div>}<Empty t={t} /></div>;
  const locale = lang === "ru" ? "ru-RU" : "en-US";
  const percentValue = (value: number | null) => value == null ? t("common.notAvailable") : formatPercent(value, locale);
  const byteValue = (value: number) => formatBytes(value, locale, t);
  const rateValue = (value: number | null) => value == null ? t("common.notAvailable") : t("admin.monitoring.perSecond", { value: byteValue(value) });
  const points = data.points ?? [];
  const stale = (data.to ?? latest.at) - latest.at > 3 * 60_000;
  const memoryValue = t("admin.monitoring.usedOf", { used: byteValue(latest.memoryUsedBytes), total: byteValue(latest.memoryTotalBytes) });
  const diskValue = t("admin.monitoring.usedOf", { used: byteValue(latest.diskUsedBytes), total: byteValue(latest.diskTotalBytes) });
  const percentage = (key: SystemSeriesKey) => ({ key, label: t("admin.monitoring.series." + key), format: (value: number) => formatPercent(value, locale) });
  const throughput = (key: SystemSeriesKey) => ({ key, label: t("admin.monitoring.series." + key), format: (value: number) => t("admin.monitoring.perSecond", { value: byteValue(value) }) });
  const load = (key: SystemSeriesKey) => ({ key, label: t("admin.monitoring.series." + key), format: (value: number) => new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value) });

  return <div className="admin-stack">
    {!data.configured && <div className="admin-notice">{t("admin.monitoring.notConfigured")}</div>}
    <div className={`admin-monitoring-status ${stale ? "is-stale" : "is-current"}`} role="status">
      <span>{t(stale ? "admin.monitoring.stale" : "admin.monitoring.current")}</span>
      <time dateTime={new Date(latest.at).toISOString()}>{formatDate(latest.at, lang, t)}</time>
    </div>
    <div className="admin-metrics">
      <StatCard className="admin-monitoring-metric" label={t("admin.monitoring.cpu")} value={percentValue(latest.cpuPercent)} />
      <StatCard className="admin-monitoring-metric" label={t("admin.monitoring.memory")} value={memoryValue} />
      <StatCard className="admin-monitoring-metric" label={t("admin.monitoring.disk")} value={diskValue} />
      <StatCard className="admin-monitoring-metric admin-monitoring-metric--rate" label={t("admin.monitoring.networkIn")} value={rateValue(latest.networkRxBytesPerSecond)} />
      <StatCard className="admin-monitoring-metric admin-monitoring-metric--rate" label={t("admin.monitoring.networkOut")} value={rateValue(latest.networkTxBytesPerSecond)} />
      <StatCard className="admin-monitoring-metric" label={t("admin.monitoring.uptime")} value={formatUptime(latest.uptimeSeconds, t)} />
    </div>
    <div className="admin-monitoring-grid">
      <SystemMetricChart title={t("admin.monitoring.chart.cpu")} points={points} series={[percentage("cpuPercent")]} fixedMax={100} lang={lang} t={t} />
      <SystemMetricChart title={t("admin.monitoring.chart.memory")} points={points} series={[percentage("memoryPercent"), percentage("swapPercent")]} fixedMax={100} lang={lang} t={t} />
      <SystemMetricChart title={t("admin.monitoring.chart.diskIo")} points={points} series={[throughput("diskReadBytesPerSecond"), throughput("diskWriteBytesPerSecond")]} lang={lang} t={t} />
      <SystemMetricChart title={t("admin.monitoring.chart.network")} points={points} series={[throughput("networkRxBytesPerSecond"), throughput("networkTxBytesPerSecond")]} lang={lang} t={t} />
      <SystemMetricChart title={t("admin.monitoring.chart.diskUsage")} points={points} series={[percentage("diskPercent")]} fixedMax={100} lang={lang} t={t} />
      <SystemMetricChart title={t("admin.monitoring.chart.load")} points={points} series={[load("load1"), load("load5"), load("load15")]} lang={lang} t={t} />
    </div>
    <SystemMetricsTable points={points} lang={lang} t={t} />
  </div>;
}

function SystemMetricChart({ title, points, series, fixedMax, lang, t }: { title: string; points: SystemMetricPoint[]; series: SystemChartSeries[]; fixedMax?: number; lang: string; t: T }) {
  const visibleSeries = series.filter((item) => points.some((point) => typeof point[item.key] === "number"));
  const [selectedIndex, setSelectedIndex] = useState(0);
  useEffect(() => { setSelectedIndex(points.length ? points.length - 1 : 0); }, [points]);
  if (!points.length || !visibleSeries.length) return <section className="data-panel admin-panel admin-monitoring-chart"><h2 className="section-heading">{title}</h2><p className="admin-empty">{t("admin.empty")}</p></section>;

  const left = 17;
  const right = 96;
  const top = 6;
  const bottom = 43;
  const chartHeight = 58;
  const firstTime = points[0].at;
  const lastTime = points.at(-1)!.at;
  const timeSpan = Math.max(1, lastTime - firstTime);
  const values = points.flatMap((point) => visibleSeries.map((item) => point[item.key]).filter((value): value is number => typeof value === "number"));
  const rawMax = Math.max(1, ...values);
  const max = fixedMax ?? rawMax * 1.08;
  const xFor = (time: number) => points.length === 1 ? 50 : left + (time - firstTime) / timeSpan * (right - left);
  const yFor = (value: number) => bottom - Math.min(max, Math.max(0, value)) / max * (bottom - top);
  const pathFor = (key: SystemSeriesKey) => {
    let drawing = false;
    return points.map((point) => {
      const value = point[key];
      if (typeof value !== "number") { drawing = false; return ""; }
      const command = drawing ? "L" : "M";
      drawing = true;
      return `${command}${xFor(point.at).toFixed(2)},${yFor(value).toFixed(2)}`;
    }).filter(Boolean).join(" ");
  };
  const selected = points[Math.min(selectedIndex, points.length - 1)];
  const selectedX = xFor(selected.at);
  const selectedText = visibleSeries.map((item) => {
    const value = selected[item.key];
    return `${item.label}: ${typeof value === "number" ? item.format(value) : t("common.notAvailable")}`;
  }).join(" · ");
  const moveToPointer = (event: ReactPointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const targetX = Math.min(right, Math.max(left, (event.clientX - rect.left) / Math.max(1, rect.width) * 100));
    let nearest = 0;
    for (let index = 1; index < points.length; index += 1) if (Math.abs(xFor(points[index].at) - targetX) < Math.abs(xFor(points[nearest].at) - targetX)) nearest = index;
    setSelectedIndex(nearest);
  };
  const moveByKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    setSelectedIndex((index) => event.key === "Home" ? 0 : event.key === "End" ? points.length - 1 : Math.max(0, Math.min(points.length - 1, index + (event.key === "ArrowLeft" ? -1 : 1))));
  };
  const tickIndexes = points.length < 3 ? points.map((_, index) => index) : [0, Math.floor((points.length - 1) / 2), points.length - 1];
  const anchorFor = (x: number) => x < 20 ? "start" : x > 80 ? "end" : "middle";
  const dateTransform = selectedX < 20 ? "translateX(0)" : selectedX > 80 ? "translateX(-100%)" : "translateX(-50%)";

  return <section className="data-panel admin-panel admin-monitoring-chart">
    <h2 className="section-heading">{title}</h2>
    <div className="admin-chart-wrap admin-monitoring-chart__wrap" tabIndex={0} role="group" aria-label={t("admin.monitoring.chartAria", { title })} aria-keyshortcuts="ArrowLeft ArrowRight Home End" onKeyDown={moveByKeyboard}>
      <div className="admin-chart-stage admin-monitoring-chart__stage">
        <svg className="admin-chart" viewBox="0 0 100 58" preserveAspectRatio="none" aria-hidden="true" onPointerMove={moveToPointer} onPointerDown={moveToPointer}>
          {[top, (top + bottom) / 2, bottom].map((y) => <line key={y} className="admin-chart__grid" x1={left} x2={right} y1={y} y2={y} />)}
          {visibleSeries.map((item, index) => <path key={item.key} className={`admin-chart__line admin-monitoring-chart__line admin-monitoring-chart__line--${index + 1}`} d={pathFor(item.key)} />)}
          <line className="admin-chart__crosshair" x1={selectedX} x2={selectedX} y1={top} y2={bottom} />
          <rect className="admin-chart__hit-area" x={left} y={top} width={right - left} height={bottom - top} fill="transparent" pointerEvents="all" />
        </svg>
        <div className="admin-chart-overlay" aria-hidden="true">
          <span className="admin-chart__axis admin-chart__axis--max" style={{ top: `${top / chartHeight * 100}%` }}>{visibleSeries[0].format(max)}</span>
          <span className="admin-chart__axis admin-chart__axis--zero" style={{ top: `${bottom / chartHeight * 100}%` }}>{visibleSeries[0].format(0)}</span>
          {visibleSeries.map((item, index) => {
            const value = selected[item.key];
            return typeof value === "number" ? <span key={item.key} className={`admin-chart__marker admin-monitoring-chart__marker admin-monitoring-chart__marker--${index + 1}`} style={{ left: `${selectedX}%`, top: `${yFor(value) / chartHeight * 100}%` }} /> : null;
          })}
        </div>
      </div>
      <div className="admin-chart-axis" aria-hidden="true">{tickIndexes.map((index) => { const x = xFor(points[index].at); return <span key={points[index].at} style={{ left: `${x}%`, transform: `translateX(${anchorFor(x) === "start" ? "0" : anchorFor(x) === "end" ? "-100%" : "-50%"})` }}>{formatChartAxis(points[index].at, lang, timeSpan)}</span>; })}</div>
      <div className="admin-chart-date" style={{ left: `${selectedX}%`, transform: dateTransform }} aria-hidden="true">{formatChartDate(selected.at, lang)}</div>
    </div>
    <div className="admin-chart-selection" aria-live="polite">{formatChartDate(selected.at, lang)} · {selectedText}</div>
    <div className="admin-chart-legend" aria-label={t("admin.monitoring.legend")}>{visibleSeries.map((item, index) => <span key={item.key}><i className={`admin-chart-legend__swatch admin-monitoring-chart__swatch--${index + 1}`} />{item.label}</span>)}</div>
    <p className="admin-chart-hint">{t("admin.chart.keyboard")}</p>
  </section>;
}

function SystemMetricsTable({ points, lang, t }: { points: SystemMetricPoint[]; lang: string; t: T }) {
  const locale = lang === "ru" ? "ru-RU" : "en-US";
  const percentage = (value: number | null) => value == null ? t("common.notAvailable") : formatPercent(value, locale);
  const rate = (value: number | null) => value == null ? t("common.notAvailable") : t("admin.monitoring.perSecond", { value: formatBytes(value, locale, t) });
  return <details className="data-panel admin-monitoring-table"><summary>{t("admin.monitoring.table.show")}</summary><div className="admin-monitoring-table__scroll"><table><thead><tr>
    <th scope="col">{t("admin.monitoring.table.time")}</th><th scope="col">{t("admin.monitoring.cpu")}</th><th scope="col">{t("admin.monitoring.memory")}</th><th scope="col">{t("admin.monitoring.table.swap")}</th><th scope="col">{t("admin.monitoring.disk")}</th><th scope="col">{t("admin.monitoring.table.read")}</th><th scope="col">{t("admin.monitoring.table.write")}</th><th scope="col">{t("admin.monitoring.networkIn")}</th><th scope="col">{t("admin.monitoring.networkOut")}</th><th scope="col">{t("admin.monitoring.table.load")}</th>
  </tr></thead><tbody>{points.map((point) => <tr key={point.at}><th scope="row">{formatChartDate(point.at, lang)}</th><td>{percentage(point.cpuPercent)}</td><td>{percentage(point.memoryPercent)}</td><td>{percentage(point.swapPercent)}</td><td>{percentage(point.diskPercent)}</td><td>{rate(point.diskReadBytesPerSecond)}</td><td>{rate(point.diskWriteBytesPerSecond)}</td><td>{rate(point.networkRxBytesPerSecond)}</td><td>{rate(point.networkTxBytesPerSecond)}</td><td>{new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(point.load1)}</td></tr>)}</tbody></table></div></details>;
}

function formatPercent(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value) + "%";
}

function formatBytes(value: number, locale: string, t: T): string {
  const units = ["b", "kb", "mb", "gb", "tb"] as const;
  let amount = Math.max(0, value);
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit += 1; }
  const digits = unit === 0 || amount >= 100 ? 0 : amount >= 10 ? 1 : 2;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(amount)} ${t("admin.monitoring.unit." + units[unit])}`;
}

function formatUptime(seconds: number, t: T): string {
  const totalHours = Math.floor(Math.max(0, seconds) / 3600);
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return days > 0 ? t("admin.monitoring.uptimeDays", { days, hours }) : t("admin.monitoring.uptimeHours", { hours });
}

function RankList({ title, rows, t }: { title: string; rows: Rank[]; t: T }) {
  const max = Math.max(1, ...rows.map((row) => row.pageviews));
  return <section className="data-panel admin-panel"><h2 className="section-heading">{title}</h2>{rows.length ? <ol className="admin-rank-list">{rows.slice(0, 10).map((row) => <li key={row.key}><div><span title={row.key}>{row.key}</span><strong>{formatNumber(row.pageviews)}</strong></div><div className="admin-rank-bar" aria-hidden><i style={{ width: `${row.pageviews / max * 100}%` }} /></div><small>{t("admin.rank.visits", { n: formatNumber(row.visits) })}</small></li>)}</ol> : <p className="admin-empty">{t("admin.empty")}</p>}</section>;
}

function AccountsPanel({ data, suspicious, lang, t, reload }: { data: Accounts | null; suspicious: boolean; lang: string; t: T; reload: () => Promise<void> }) {
  if (!data?.available) return <div className="admin-notice">{t("admin.warning.storage")}</div>;
  if (!data.accounts?.length) return <Empty t={t} />;
  return <section className="data-panel admin-accounts">{suspicious && <h2 className="section-heading admin-accounts__heading">{t("admin.suspicious.heading")}</h2>}<div className="admin-account-head"><span>{t("admin.account.account")}</span><span>{t("admin.account.requests")}</span><span>{t("admin.account.snapshots")}</span><span>{t("admin.account.last")}</span><span>{t("admin.account.signals")}</span></div>{data.accounts.map((account) => <AccountRow key={account.aid} account={account} suspicious={suspicious} reportOnly={suspicious} lang={lang} t={t} reload={reload} />)}</section>;
}

function AccountRow({ account, suspicious, reportOnly = false, lang, t, reload }: { account: Account; suspicious: boolean; reportOnly?: boolean; lang: string; t: T; reload: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const moderation = moderationFor(account);
  const accountModes = Array.from(new Set((account.modes ?? []).filter(isProfileMode)));
  const riskMode = moderation?.risk?.mode;
  const profileModes = Array.from(new Set([...accountModes, ...(riskMode ? [riskMode] : [])]));
  const defaultMode: GameMode = riskMode && profileModes.includes(riskMode) ? riskMode : profileModes.includes("regular") ? "regular" : profileModes[0] ?? "regular";
  const availableProfileModes = profileModes.length ? profileModes : [defaultMode];
  const profileLabel = (mode: GameMode) => t("admin.account.openProfile", { mode: t("admin.mode." + mode) });
  const lastLabel = reportOnly ? t("admin.account.lastReported") : t("admin.account.last");
  const lastAt = reportOnly ? account.reportedAt ?? account.lastRequestedAt : account.lastRequestedAt;
  return <details className="admin-account" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}><summary><span><strong><Link className="admin-account__profile-link" href={profileHref(account.aid, defaultMode)} prefetch={false} aria-label={profileLabel(defaultMode)} onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>{account.nickname || `#${account.aid}`}</Link></strong><small><span>AID {account.aid}</span><span aria-hidden="true"> / </span><span className="admin-account__mode-links" aria-label={t("admin.account.profileModes")}>{availableProfileModes.map((mode) => <Link className="admin-account__mode-link" key={mode} href={profileHref(account.aid, mode)} prefetch={false} aria-label={profileLabel(mode)} onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>{t("admin.mode." + mode)}</Link>)}</span></small></span><span data-label={t("admin.account.requests")}>{formatNumber(account.requestCount)}</span><span data-label={t("admin.account.snapshots")}>{formatNumber(account.snapshotCount)}</span><span data-label={lastLabel}>{new Date(lastAt).toLocaleString(lang === "ru" ? "ru-RU" : "en-US", { timeZone: "Europe/Moscow" })}</span><span className="admin-signals" data-label={t("admin.account.signals")}><Signals moderation={moderation} sources={account.sources} t={t} /></span></summary><div className="admin-account-details"><dl><div><dt>{t("admin.account.snapshots")}</dt><dd>{formatNumber(account.snapshotCount)}</dd></div><div><dt>{t("admin.account.refreshes")}</dt><dd>{formatNumber(account.refreshCount)}</dd></div>{Object.entries(account.outcomes ?? {}).map(([key, value]) => <div key={key}><dt>{outcomeLabel(key, t)}</dt><dd>{formatNumber(value)}</dd></div>)}{reportOnly && <div><dt>{t("admin.account.reportedAt")}</dt><dd>{formatDate(account.reportedAt ?? null, lang, t)}</dd></div>}<div><dt>{t("admin.account.profileUpdated")}</dt><dd>{formatDate(moderation?.risk?.profileUpdatedAt ?? null, lang, t)}</dd></div>{moderation?.risk && <div><dt>{t("admin.account.risk")}</dt><dd>{moderation.risk.score} / {t("admin.risk." + moderation.risk.tier)} / {t("admin.mode." + moderation.risk.mode)}</dd></div>}</dl>{(suspicious || moderation) && <ModerationForm account={account} moderation={moderation} t={t} reload={reload} />}</div></details>;
}

function moderationFor(account: Account): AccountModeration | undefined {
  if (account.moderation) return account.moderation;
  if (account.risk === undefined && account.review === undefined && account.reportCount === undefined && account.confirmedBan === undefined) return undefined;
  return {
    aid: account.aid,
    risk: account.risk ?? null,
    review: account.review ?? { status: "new", note: null, updatedAt: null },
    sources: { automaticRisk: finite(account.risk?.score) >= 20, communityReports: finite(account.reportCount), confirmedBan: account.confirmedBan === true },
    banSource: null,
    canRestoreManualBan: account.canRestoreManualBan === true,
  };
}

function outcomeLabel(key: string, t: T): string {
  return ["success", "not_found", "error", "rate_limited", "unavailable", "invalid"].includes(key) ? t("admin.outcome." + key) : t("common.notAvailable");
}

function Signals({ moderation, sources, t }: { moderation?: AccountModeration; sources: string[]; t: T }) {
  const labels = sources?.length ? [t("admin.source.other")] : [];
  if (moderation?.sources.automaticRisk) labels.push(t("admin.source.risk"));
  if (moderation?.sources.communityReports) labels.push(t("admin.source.reported", { n: moderation.sources.communityReports }));
  if (moderation?.sources.confirmedBan) labels.push(t("admin.source.ban"));
  return labels.length ? <>{labels.map((label) => <span className="admin-badge" key={label}>{label}</span>)}</> : <span>{t("common.notAvailable")}</span>;
}

function ModerationForm({ account, moderation, t, reload }: { account: Account; moderation?: AccountModeration; t: T; reload: () => Promise<void> }) {
  const [status, setStatus] = useState<"reviewed" | "false_positive">(moderation?.review.status === "false_positive" ? "false_positive" : "reviewed");
  const [note, setNote] = useState(moderation?.review.note ?? "");
  const [confirmAid, setConfirmAid] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function mutate(url: string, method: "PATCH" | "POST", body: object) { setBusy(true); setMessage(""); try { await getJson(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); setMessage(t("admin.saved")); await reload(); } catch { setMessage(t("admin.error.save")); } finally { setBusy(false); } }
  const confirmedBan = moderation?.sources.confirmedBan === true;
  const lockedUpstreamBan = confirmedBan && !moderation?.canRestoreManualBan;
  return <div className="admin-moderation">
    {!confirmedBan && <><label><span>{t("admin.review.status")}</span><select value={status} onChange={(event) => setStatus(event.target.value as "reviewed" | "false_positive")}>{["reviewed", "false_positive"].map((item) => <option key={item} value={item}>{t("admin.review." + item)}</option>)}</select></label><label className="admin-note"><span>{t("admin.review.note")}</span><textarea maxLength={2000} value={note} onChange={(event) => setNote(event.target.value)} placeholder={t("admin.review.notePlaceholder")} /></label><button className="ghost-button" disabled={busy} type="button" onClick={() => mutate("/api/admin/reviews", "PATCH", { aid: account.aid, status, note })}>{t("admin.review.save")}</button></>}
    {lockedUpstreamBan ? <p className="admin-form-message">{t("admin.ban.upstreamLocked")}</p> : <div className="admin-ban"><label><span>{t("admin.ban.confirmAid")}</span><input inputMode="numeric" value={confirmAid} onChange={(event) => setConfirmAid(event.target.value)} placeholder={String(account.aid)} /></label>{!moderation?.canRestoreManualBan && <label><span>{t("admin.ban.reason")}</span><input maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} /></label>}<button type="button" className="ghost-button admin-danger" disabled={busy || Number(confirmAid) !== account.aid || (!moderation?.canRestoreManualBan && !reason.trim())} onClick={() => moderation?.canRestoreManualBan ? mutate("/api/admin/bans/restore", "POST", { aid: account.aid, confirmAid: Number(confirmAid) }) : mutate("/api/admin/bans", "POST", { aid: account.aid, confirmAid: Number(confirmAid), reason })}>{t(moderation?.canRestoreManualBan ? "admin.ban.restore" : "admin.ban.confirm")}</button></div>}
    {message && <p className="admin-form-message" role="status">{message}</p>}
  </div>;
}

function healthPercent(value: number, total: number, lang: string): string {
  return new Intl.NumberFormat(lang === "ru" ? "ru-RU" : "en-US", { maximumFractionDigits: 2 }).format(total > 0 ? value / total * 100 : 0) + "%";
}

function healthLatency(value: number | null, t: T): string {
  return value == null ? t("common.notAvailable") : t("admin.health.milliseconds", { n: formatNumber(value) });
}

function healthOperationLabel(operation: string, t: T): string {
  const known = ["player_profile", "player_search", "average", "average_cohort", "baseline", "average_achievements"];
  return known.includes(operation) ? t("admin.health.operation." + operation) : t("admin.health.operation.other");
}

function healthModeLabel(mode: string | null, t: T): string {
  return mode && ["regular", "pve", "arena", "seasonal"].includes(mode) ? t("admin.mode." + mode) : t("admin.health.allModes");
}

function healthVariantLabel(variant: HealthOperationVariant, t: T): string {
  const source = variant.source && ["stored", "upstream", "cache", "index"].includes(variant.source)
    ? t("admin.health.source." + variant.source) : t("common.notAvailable");
  const cache = variant.cache && ["hit", "miss", "bypass"].includes(variant.cache)
    ? t("admin.health.cache." + variant.cache) : t("common.notAvailable");
  const force = variant.force === null ? t("common.notAvailable")
    : t(variant.force ? "admin.health.force.manual" : "admin.health.force.normal");
  return t("admin.health.variant", {
    source, cache, force, n: variant.requests,
    p50: healthLatency(variant.p50Ms, t), p95: healthLatency(variant.p95Ms, t),
  });
}

function healthStageLabel(stage: string, t: T): string {
  return ["request", "rate_limit", "upstream", "dependency", "storage", "application"].includes(stage)
    ? t("admin.health.stage." + stage) : t("admin.health.stage.unknown");
}

function healthReport(summary: Summary): string {
  const health = summary.health;
  return JSON.stringify({
    schema: "tarkovstats_health_v1",
    generatedAt: new Date(summary.generatedAt).toISOString(),
    period: summary.period,
    domain: summary.domain,
    storageAvailable: summary.storageAvailable,
    health: health && {
      status: health.status,
      activeIssueCount: health.activeIssueCount,
      recentIssueCount: health.recentIssueCount,
      requests: health.requests,
      success: health.success,
      notFound: health.notFound,
      rateLimited: health.rateLimited,
      serverErrors: health.serverErrors,
      latencyMs: { p50: health.p50Ms, p95: health.p95Ms, p99: health.p99Ms },
      cache: { hits: health.cacheHits, misses: health.cacheMisses },
      operations: health.operations,
      issues: health.issues,
    },
    freshness: summary.freshness,
  }, null, 2);
}

function HealthSeriesCharts({ points, lang, t }: { points: HealthSeriesPoint[]; lang: string; t: T }) {
  if (!points.length) return <Empty t={t} />;
  const left = 7;
  const right = 97;
  const top = 4;
  const bottom = 38;
  const firstAt = points[0].at;
  const lastAt = points.at(-1)!.at;
  const span = Math.max(1, lastAt - firstAt);
  const xFor = (at: number) => points.length === 1 ? 52 : left + (at - firstAt) / span * (right - left);
  const latencyMax = Math.max(1, ...points.flatMap((point) => [point.p50Ms ?? 0, point.p95Ms ?? 0, point.p99Ms ?? 0]));
  const volumeMax = Math.max(1, ...points.flatMap((point) => [point.requests, point.problems]));
  const line = (key: "p50Ms" | "p95Ms" | "p99Ms", max: number) => points
    .filter((point) => point[key] != null)
    .map((point) => `${xFor(point.at)},${bottom - Number(point[key]) / max * (bottom - top)}`)
    .join(" ");
  const volumeLine = (key: "requests" | "problems") => points
    .map((point) => `${xFor(point.at)},${bottom - point[key] / volumeMax * (bottom - top)}`)
    .join(" ");
  const axis = <div className="admin-health-chart-axis" aria-hidden="true"><span>{formatChartAxis(firstAt, lang, span)}</span><span>{formatChartAxis(lastAt, lang, span)}</span></div>;
  return <div className="admin-health-chart-grid">
    <section className="data-panel admin-panel admin-health-chart"><h2 className="section-heading">{t("admin.health.latencyChart")}</h2><p className="admin-chart-description">{t("admin.health.latencyChartDescription")}</p><div className="admin-health-chart-stage"><svg viewBox="0 0 100 42" preserveAspectRatio="none" aria-hidden="true">{[top, bottom].map((y) => <line key={y} className="admin-chart__grid" x1={left} x2={right} y1={y} y2={y} />)}<polyline className="admin-health-chart__line admin-health-chart__line--p50" points={line("p50Ms", latencyMax)} /><polyline className="admin-health-chart__line admin-health-chart__line--p95" points={line("p95Ms", latencyMax)} /><polyline className="admin-health-chart__line admin-health-chart__line--p99" points={line("p99Ms", latencyMax)} /></svg><span className="admin-health-chart-max">{healthLatency(latencyMax, t)}</span></div>{axis}<div className="admin-chart-legend"><span><i className="admin-chart-legend__swatch admin-health-chart__swatch--p50" />{t("admin.health.p50Short")}</span><span><i className="admin-chart-legend__swatch admin-health-chart__swatch--p95" />{t("admin.health.p95Short")}</span><span><i className="admin-chart-legend__swatch admin-health-chart__swatch--p99" />{t("admin.health.p99Short")}</span></div></section>
    <section className="data-panel admin-panel admin-health-chart"><h2 className="section-heading">{t("admin.health.volumeChart")}</h2><p className="admin-chart-description">{t("admin.health.volumeChartDescription")}</p><div className="admin-health-chart-stage"><svg viewBox="0 0 100 42" preserveAspectRatio="none" aria-hidden="true">{[top, bottom].map((y) => <line key={y} className="admin-chart__grid" x1={left} x2={right} y1={y} y2={y} />)}<polyline className="admin-health-chart__line admin-health-chart__line--requests" points={volumeLine("requests")} /><polyline className="admin-health-chart__line admin-health-chart__line--problems" points={volumeLine("problems")} /></svg><span className="admin-health-chart-max">{formatNumber(volumeMax)}</span></div>{axis}<div className="admin-chart-legend"><span><i className="admin-chart-legend__swatch admin-health-chart__swatch--requests" />{t("admin.health.requests")}</span><span><i className="admin-chart-legend__swatch admin-health-chart__swatch--problems" />{t("admin.health.problems")}</span></div></section>
  </div>;
}

function HealthPanel({ summary, lang, t, audit, auditBusy, auditError, onRunAudit }: { summary: Summary | null; lang: string; t: T; audit: DataAudit | null; auditBusy: boolean; auditError: string; onRunAudit: () => Promise<void> }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const health = summary?.health;
  if (!health || !summary) return <div className="admin-stack"><div className="admin-notice admin-notice--error" role="alert">{t("admin.warning.storage")}</div><DataAuditPanel audit={audit} auditBusy={auditBusy} auditError={auditError} onRunAudit={onRunAudit} lang={lang} t={t} /></div>;
  const cached = health.cacheHits + health.cacheMisses;
  const values: Array<[string, string]> = [
    ["requests", formatNumber(health.requests)],
    ["successRate", healthPercent(health.success, health.requests, lang)],
    ["serverErrorRate", healthPercent(health.serverErrors, health.requests, lang)],
    ["p50", healthLatency(health.p50Ms, t)],
    ["p95", healthLatency(health.p95Ms, t)],
    ["p99", healthLatency(health.p99Ms, t)],
    ["cacheHitRate", healthPercent(health.cacheHits, cached, lang)],
    ["rateLimited", formatNumber(health.rateLimited)],
  ];
  const copyReport = async () => {
    try { await navigator.clipboard.writeText(healthReport(summary)); setCopyState("copied"); }
    catch { setCopyState("error"); }
  };
  const statusDescription = health.status === "healthy" && health.recentIssueCount > 0
    ? t("admin.health.status.recovered", { n: health.recentIssueCount })
    : t("admin.health.status." + health.status + "Description", { active: health.activeIssueCount, recent: health.recentIssueCount });
  return <div className="admin-stack">
    <section className={`admin-health-status admin-health-status--${health.status}`} aria-live="polite"><div><p className="admin-health-status__eyebrow">{t("admin.health.currentStatus")}</p><h2>{t("admin.health.status." + health.status)}</h2><p>{statusDescription}</p>{health.statusSinceAt && <small>{t("admin.health.status.since", { date: formatDate(health.statusSinceAt, lang, t) })}</small>}</div><div className="admin-health-report"><button type="button" className="ghost-button" onClick={() => { void copyReport(); }}>{t("admin.health.copyReport")}</button><span role="status">{copyState === "copied" ? t("admin.health.reportCopied") : copyState === "error" ? t("admin.health.reportError") : t("admin.health.reportSafe")}</span></div></section>
    <p className="admin-notice">{t("admin.health.scope")}</p>
    <div className="admin-metrics admin-health-metrics">{values.map(([key, value]) => <StatCard key={key} label={t("admin.health." + key)} value={value} />)}</div>
    {health.requests > 0 && health.requests < 100 && <p className="admin-notice">{t("admin.health.p99LowConfidence", { n: health.requests })}</p>}
    <HealthSeriesCharts points={health.series ?? []} lang={lang} t={t} />
    <section className="data-panel admin-panel"><h2 className="section-heading">{t("admin.health.operationsHeading")}</h2><p className="admin-chart-description">{t("admin.health.operationsDescription")}</p><div className="admin-health-table-wrap"><table className="admin-health-table"><thead><tr><th scope="col">{t("admin.health.table.operation")}</th><th scope="col">{t("admin.health.table.mode")}</th><th scope="col">{t("admin.health.table.requests")}</th><th scope="col">{t("admin.health.table.success")}</th><th scope="col">{t("admin.health.table.server5xx")}</th><th scope="col">{t("admin.health.p50Short")}</th><th scope="col">{t("admin.health.p95Short")}</th><th scope="col">{t("admin.health.p99Short")}</th><th scope="col">{t("admin.health.table.lastSuccess")}</th><th scope="col">{t("admin.health.table.lastIssue")}</th></tr></thead><tbody>{health.operations.map((operation) => <tr key={`${operation.operation}-${operation.mode ?? "all"}`}><th scope="row">{healthOperationLabel(operation.operation, t)}{operation.variants.map((variant, index) => <small key={`${variant.source}-${variant.cache}-${String(variant.force)}-${index}`}>{healthVariantLabel(variant, t)}</small>)}</th><td>{healthModeLabel(operation.mode, t)}</td><td>{formatNumber(operation.requests)}</td><td>{healthPercent(operation.success, operation.requests, lang)}</td><td>{formatNumber(operation.serverErrors)}</td><td>{healthLatency(operation.p50Ms, t)}</td><td>{healthLatency(operation.p95Ms, t)}</td><td>{healthLatency(operation.p99Ms, t)}{operation.requests < 100 && <span className="admin-health-confidence" title={t("admin.health.lowConfidence")}>*</span>}</td><td>{formatDate(operation.lastSuccessAt, lang, t)}</td><td>{formatDate(operation.lastIssueAt, lang, t)}</td></tr>)}</tbody></table></div></section>
    <section className="data-panel admin-panel"><h2 className="section-heading">{t("admin.health.issuesHeading")}</h2><p className="admin-chart-description">{t("admin.health.issuesDescription")}</p>{health.issues.length ? <div className="admin-health-table-wrap"><table className="admin-health-table admin-health-issues"><thead><tr><th scope="col">{t("admin.health.table.state")}</th><th scope="col">{t("admin.health.table.operation")}</th><th scope="col">{t("admin.health.table.stage")}</th><th scope="col">{t("admin.health.table.code")}</th><th scope="col">{t("admin.health.table.http")}</th><th scope="col">{t("admin.health.table.count")}</th><th scope="col">{t("admin.health.table.firstSeen")}</th><th scope="col">{t("admin.health.table.lastSeen")}</th><th scope="col">{t("admin.health.table.maxLatency")}</th></tr></thead><tbody>{health.issues.map((issue) => <tr key={`${issue.operation}-${issue.mode}-${issue.stage}-${issue.code}-${issue.status}`}><td><span className={`admin-health-issue-badge admin-health-issue-badge--${issue.active ? issue.severity : "resolved"}`}>{t(issue.active ? "admin.health.issue.active" : "admin.health.issue.resolved")}</span></td><th scope="row">{healthOperationLabel(issue.operation, t)}<small>{healthModeLabel(issue.mode, t)}</small></th><td>{healthStageLabel(issue.stage, t)}</td><td><code>{issue.code}</code></td><td>{issue.status}</td><td>{formatNumber(issue.count)}{issue.activeCount > 0 && <small>{t("admin.health.issue.activeCount", { n: issue.activeCount })}</small>}</td><td>{formatDate(issue.firstSeenAt, lang, t)}</td><td>{formatDate(issue.lastSeenAt, lang, t)}</td><td>{healthLatency(issue.maxLatencyMs, t)}</td></tr>)}</tbody></table></div> : <p className="admin-empty">{t("admin.health.noIssues")}</p>}</section>
    <details className="data-panel admin-monitoring-table"><summary>{t("admin.health.seriesTable")}</summary><div className="admin-monitoring-table__scroll"><table><thead><tr><th scope="col">{t("admin.monitoring.table.time")}</th><th scope="col">{t("admin.health.requests")}</th><th scope="col">{t("admin.health.problems")}</th><th scope="col">{t("admin.health.p50Short")}</th><th scope="col">{t("admin.health.p95Short")}</th><th scope="col">{t("admin.health.p99Short")}</th></tr></thead><tbody>{health.series.map((point) => <tr key={point.at}><th scope="row">{formatChartDate(point.at, lang)}</th><td>{formatNumber(point.requests)}</td><td>{formatNumber(point.problems)}</td><td>{healthLatency(point.p50Ms, t)}</td><td>{healthLatency(point.p95Ms, t)}</td><td>{healthLatency(point.p99Ms, t)}</td></tr>)}</tbody></table></div></details>
    <section className="data-panel admin-panel"><h2 className="section-heading">{t("admin.health.freshness")}</h2><dl className="admin-health-dates"><div><dt>{t("admin.health.lastSuccess")}</dt><dd>{formatDate(health.lastSuccessAt, lang, t)}</dd></div><div><dt>{t("admin.health.lastEvent")}</dt><dd>{formatDate(summary.freshness?.lastEventAt ?? null, lang, t)}</dd></div><div><dt>{t("admin.health.lastProfile")}</dt><dd>{formatDate(summary.freshness?.lastProfileRequestAt ?? null, lang, t)}</dd></div></dl></section>
    <DataAuditPanel audit={audit} auditBusy={auditBusy} auditError={auditError} onRunAudit={onRunAudit} lang={lang} t={t} />
  </div>;
}

const auditModes = ["regular", "pve", "arena", "pvp-season"] as const;
const auditDatasets = ["index", "updated"] as const;

function auditValue(value: number | null, t: T): string { return value == null ? t("common.notAvailable") : formatNumber(value); }
function auditPercent(value: number | null, lang: string, t: T): string {
  if (value == null) return t("common.notAvailable");
  return t("admin.audit.percent", { n: new Intl.NumberFormat(lang === "ru" ? "ru-RU" : "en-US", { maximumFractionDigits: 2 }).format(value) });
}

function DataAuditPanel({ audit, auditBusy, auditError, onRunAudit, lang, t }: { audit: DataAudit | null; auditBusy: boolean; auditError: string; onRunAudit: () => Promise<void>; lang: string; t: T }) {
  const datasets = audit?.snapshot?.datasets ?? [];
  const resultFor = (mode: AuditDataset["mode"], dataset: AuditDataset["dataset"]) => datasets.find((row) => row.mode === mode && row.dataset === dataset) ?? null;
  return <section className="data-panel admin-panel admin-audit-panel"><div className="admin-audit-heading"><div><h2 className="section-heading">{t("admin.audit.heading")}</h2><p className="admin-chart-description">{t("admin.audit.description")}</p></div><button type="button" className="tactical-button" disabled={auditBusy || audit?.running === true} onClick={() => { void onRunAudit(); }}>{auditBusy || audit?.running ? t("common.loading") : t("admin.audit.button")}</button></div>{auditError && <div className="admin-notice admin-notice--error" role="alert">{auditError}</div>}{audit?.running && <div className="admin-notice">{t("admin.audit.running")}</div>}{!audit?.snapshot && !audit?.running && <p className="admin-empty">{t("admin.audit.notRun")}</p>}{audit?.snapshot && <div className="admin-audit-table-wrap"><table className="admin-audit-table"><thead><tr><th scope="col">{t("admin.audit.mode")}</th><th scope="col">{t("admin.audit.dataset")}</th><th scope="col">{t("admin.audit.upstream")}</th><th scope="col">{t("admin.audit.local")}</th><th scope="col">{t("admin.audit.missingStale")}</th><th scope="col">{t("admin.audit.coverage")}</th><th scope="col">{t("admin.audit.lastChecked")}</th><th scope="col">{t("admin.audit.lastReceived")}</th><th scope="col">{t("admin.audit.lastLocalApply")}</th><th scope="col">{t("admin.audit.latestUpdated")}</th></tr></thead><tbody>{auditModes.flatMap((mode) => auditDatasets.map((dataset) => { const row = resultFor(mode, dataset); const status = row?.status ?? "unavailable"; return <tr key={`${mode}-${dataset}`}><th scope="row">{t("admin.audit.mode." + mode)}</th><td><span>{t("admin.audit.dataset." + dataset)}</span><small className={`admin-audit-status admin-audit-status--${status}`}>{t("admin.audit.status." + status)}</small></td><td>{auditValue(row?.upstreamRecordCount ?? null, t)}</td><td>{row ? <>{auditValue(row.localMatchingCount, t)} / {auditValue(row.localCurrentCount, t)}</> : t("common.notAvailable")}</td><td>{row ? <>{auditValue(row.missingCount, t)} / {auditValue(row.staleCount, t)}</> : t("common.notAvailable")}</td><td>{auditPercent(row?.coveragePercent ?? null, lang, t)}</td><td>{formatDate(row?.lastCheckedAt ?? null, lang, t)}</td><td>{formatDate(row?.lastReceivedAt ?? null, lang, t)}</td><td>{formatDate(row?.lastLocalApplyAt ?? null, lang, t)}</td><td>{formatDate(row?.latestUpstreamUpdatedAt ?? null, lang, t)}</td></tr>; }))}</tbody></table><p className="admin-audit-note">{t("admin.audit.localLegend")}</p></div>}</section>;
}
function formatDate(value: number | null, lang: string, t: T) { return value ? new Date(value).toLocaleString(lang === "ru" ? "ru-RU" : "en-US", { timeZone: "Europe/Moscow" }) : t("common.notAvailable"); }
function formatChartAxis(value: number, lang: string, span: number) { return new Date(value).toLocaleString(lang === "ru" ? "ru-RU" : "en-US", span <= 2 * 86_400_000 ? { timeZone: "Europe/Moscow", day: "2-digit", month: "short", hour: "2-digit" } : { timeZone: "Europe/Moscow", day: "2-digit", month: "short" }); }
function formatChartDate(value: number, lang: string) { return new Date(value).toLocaleString(lang === "ru" ? "ru-RU" : "en-US", { timeZone: "Europe/Moscow", dateStyle: "medium", timeStyle: "short" }); }
function Empty({ t }: { t: T }) { return <div className="surface admin-empty">{t("admin.empty")}</div>; }
