"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import StatCard from "@/components/StatCard";
import { useI18n } from "@/lib/i18n/context";
import type { AdminDomain, AdminPeriod } from "@/lib/admin/types";
import type { AccountModeration } from "@/lib/admin/moderation-db";

type Tab = "overview" | "traffic" | "accounts" | "suspicious" | "health";
type MetricName = "visits" | "pageviews" | "accountRequests" | "newSuspicious" | "severeRisk" | "errors";
type Metrics = Record<MetricName, number>;
type SeriesPoint = { at: string; domains: Record<string, { pageviews: number; visits: number }> };
type Health = { requests: number; success: number; notFound: number; rateLimited: number; serverErrors: number; p50Ms: number | null; p95Ms: number | null; lastSuccessAt: number | null; cacheHits: number; cacheMisses: number };
type Summary = { metrics: Metrics; previous: Metrics; series: SeriesPoint[]; health: Health | null; freshness: { lastEventAt: number | null; lastProfileRequestAt: number | null } | null; auth?: { activeUsers: number; signIns: number }; storageAvailable: boolean; traffic: { available: boolean; reason?: string; sampled: boolean; from: string; to: string } };
type Rank = { key: string; pageviews: number; visits: number };
type Traffic = { available: boolean; reason?: string; sampled: boolean; pageviews: number; visits: number; series: SeriesPoint[]; domains: Rank[]; pages: Rank[]; referrers: Rank[]; countries: Rank[]; devices: Rank[]; browsers: Rank[] };
type Account = { aid: number; nickname: string | null; modes: string[]; requestCount: number; lastRequestedAt: number; outcomes: Record<string, number>; refreshCount: number; sources: string[]; moderation?: AccountModeration; risk?: AccountModeration["risk"]; reportCount?: number; confirmedBan?: boolean; review?: AccountModeration["review"]; canRestoreManualBan?: boolean };
type Accounts = { available: boolean; accounts: Account[]; nextCursor: string | null };

const tabs: Tab[] = ["overview", "traffic", "accounts", "suspicious", "health"];
const periods: AdminPeriod[] = ["24h", "7d", "30d", "90d"];
const domains: AdminDomain[] = ["all", "tarkovstats.ru", "tarkovstats.online"];
const EMPTY_METRICS: Metrics = { visits: 0, pageviews: 0, accountRequests: 0, newSuspicious: 0, severeRisk: 0, errors: 0 };

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
  const [sort, setSort] = useState<"last" | "requests">("last");
  const [summary, setSummary] = useState<Summary | null>(null);
  const [traffic, setTraffic] = useState<Traffic | null>(null);
  const [accounts, setAccounts] = useState<Accounts | null>(null);
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
      } else if (tab === "traffic") {
        setTraffic(await getJson<Traffic>(`/api/admin/traffic?${params}`));
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

  useEffect(() => { void load(); }, [load, refreshKey]);

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
        {tabs.map((item) => <button key={item} type="button" role="tab" aria-selected={tab === item} className={tab === item ? "is-active" : ""} onClick={() => chooseTab(item)}>{t("admin.tab." + item)}</button>)}
      </div>

      <section className="admin-filters" aria-label={t("admin.filters") }>
        <label><span>{t("admin.period")}</span><select value={period} onChange={(event) => choosePeriod(event.target.value as AdminPeriod)}>{periods.map((item) => <option key={item} value={item}>{t("admin.period." + item)}</option>)}</select></label>
        <label><span>{t("admin.domain")}</span><select value={domain} onChange={(event) => chooseDomain(event.target.value as AdminDomain)}>{domains.map((item) => <option key={item} value={item}>{item === "all" ? t("admin.domain.all") : item}</option>)}</select></label>
        {(tab === "accounts" || tab === "suspicious") && <>
          <label className="admin-filter-search"><span>{t("admin.search")}</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("admin.searchPlaceholder")} /></label>
          <label><span>{t("admin.mode")}</span><select value={mode} onChange={(event) => setMode(event.target.value)}><option value="">{t("admin.mode.all")}</option>{["regular", "pve", "arena", "seasonal"].map((item) => <option key={item} value={item}>{t("admin.mode." + item)}</option>)}</select></label>
          <label><span>{t("admin.sort")}</span><select value={sort} onChange={(event) => setSort(event.target.value as "last" | "requests")}><option value="last">{t("admin.sort.last")}</option><option value="requests">{t("admin.sort.requests")}</option></select></label>
        </>}
      </section>

      {error && <div className="admin-notice admin-notice--error" role="alert">{error} <button type="button" onClick={() => setRefreshKey((key) => key + 1)}>{t("admin.retry")}</button></div>}
      {!error && loading && <AdminLoading />}
      {!error && !loading && tab === "overview" && <Overview summary={summary} t={t} />}
      {!error && !loading && tab === "traffic" && <TrafficPanel traffic={traffic} t={t} />}
      {!error && !loading && (tab === "accounts" || tab === "suspicious") && <AccountsPanel data={accounts} suspicious={tab === "suspicious"} lang={lang} t={t} reload={load} />}
      {!error && !loading && tab === "health" && <HealthPanel summary={summary} lang={lang} t={t} />}
    </main>
  );
}

type T = (key: string, vars?: Record<string, string | number>) => string;

function AdminLoading() { return <div className="admin-metrics" aria-hidden>{Array.from({ length: 6 }, (_, index) => <div key={index} className="h-28 skeleton rounded-xl" />)}</div>; }

function Overview({ summary, t }: { summary: Summary | null; t: T }) {
  if (!summary) return <Empty t={t} />;
  const metrics = summary.metrics ?? EMPTY_METRICS;
  const previous = summary.previous ?? EMPTY_METRICS;
  return <div className="admin-stack">
    {(!summary.traffic?.available || !summary.storageAvailable) && <div className="admin-notice">{t(!summary.traffic?.available ? "admin.warning.traffic" : "admin.warning.storage")}</div>}
    {summary.traffic?.sampled && <div className="admin-notice">{t("admin.warning.sampled")}</div>}
    <div className="admin-metrics">{(["visits", "pageviews", "accountRequests", "newSuspicious", "severeRisk", "errors"] as MetricName[]).map((name) => <StatCard key={name} label={t("admin.metric." + name)} value={formatNumber(finite(metrics[name]))} benchmarkDiff={metricDiff(finite(metrics[name]), finite(previous[name]))} />)}</div>
    <TrendChart series={summary.series ?? []} t={t} />
    {summary.auth && <section className="data-panel admin-panel"><h2 className="section-heading">{t("admin.auth.heading")}</h2><div className="admin-metrics admin-metrics--small"><StatCard label={t("admin.auth.activeUsers")} value={formatNumber(summary.auth.activeUsers)} /><StatCard label={t("admin.auth.signIns")} value={formatNumber(summary.auth.signIns)} /></div></section>}
  </div>;
}

function TrendChart({ series, t }: { series: SeriesPoint[]; t: T }) {
  const values = series.map((point) => Object.values(point.domains ?? {}).reduce((sum, value) => sum + finite(value.pageviews), 0));
  const max = Math.max(1, ...values);
  if (!series.length) return <Empty t={t} />;
  const points = values.map((value, index) => `${series.length === 1 ? 50 : index / (series.length - 1) * 100},${38 - value / max * 36}`).join(" ");
  return <section className="data-panel admin-panel"><h2 className="section-heading">{t("admin.chart.heading")}</h2><svg className="admin-chart" viewBox="0 0 100 40" role="img" aria-label={t("admin.chart.aria")} preserveAspectRatio="none"><polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" /></svg><div className="admin-chart-values"><span>{new Date(series[0].at).toLocaleDateString()}</span><strong>{t("admin.chart.peak", { n: formatNumber(max) })}</strong><span>{new Date(series.at(-1)!.at).toLocaleDateString()}</span></div></section>;
}

function TrafficPanel({ traffic, t }: { traffic: Traffic | null; t: T }) {
  if (!traffic) return <Empty t={t} />;
  if (!traffic.available) return <div className="admin-notice">{t("admin.warning.traffic")}</div>;
  return <div className="admin-stack">{traffic.sampled && <div className="admin-notice">{t("admin.warning.sampled")}</div>}<div className="admin-metrics admin-metrics--small"><StatCard label={t("admin.metric.visits")} value={formatNumber(traffic.visits)} /><StatCard label={t("admin.metric.pageviews")} value={formatNumber(traffic.pageviews)} /></div><TrendChart series={traffic.series ?? []} t={t} /><div className="admin-ranks">{(["domains", "pages", "referrers", "countries", "devices", "browsers"] as const).map((name) => <RankList key={name} title={t("admin.rank." + name)} rows={traffic[name] ?? []} t={t} />)}</div></div>;
}

function RankList({ title, rows, t }: { title: string; rows: Rank[]; t: T }) {
  const max = Math.max(1, ...rows.map((row) => row.pageviews));
  return <section className="data-panel admin-panel"><h2 className="section-heading">{title}</h2>{rows.length ? <ol className="admin-rank-list">{rows.slice(0, 10).map((row) => <li key={row.key}><div><span title={row.key}>{row.key}</span><strong>{formatNumber(row.pageviews)}</strong></div><div className="admin-rank-bar" aria-hidden><i style={{ width: `${row.pageviews / max * 100}%` }} /></div><small>{t("admin.rank.visits", { n: formatNumber(row.visits) })}</small></li>)}</ol> : <p className="admin-empty">{t("admin.empty")}</p>}</section>;
}

function AccountsPanel({ data, suspicious, lang, t, reload }: { data: Accounts | null; suspicious: boolean; lang: string; t: T; reload: () => Promise<void> }) {
  if (!data?.available) return <div className="admin-notice">{t("admin.warning.storage")}</div>;
  if (!data.accounts?.length) return <Empty t={t} />;
  return <section className="data-panel admin-accounts"><div className="admin-account-head"><span>{t("admin.account.account")}</span><span>{t("admin.account.requests")}</span><span>{t("admin.account.last")}</span><span>{t("admin.account.signals")}</span></div>{data.accounts.map((account) => <AccountRow key={account.aid} account={account} suspicious={suspicious} lang={lang} t={t} reload={reload} />)}</section>;
}

function AccountRow({ account, suspicious, lang, t, reload }: { account: Account; suspicious: boolean; lang: string; t: T; reload: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const moderation = moderationFor(account);
  return <details className="admin-account" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}><summary><span><strong>{account.nickname || `#${account.aid}`}</strong><small>AID {account.aid} · {account.modes?.map((mode) => t("admin.mode." + mode)).join(", ") || t("common.notAvailable")}</small></span><span data-label={t("admin.account.requests")}>{formatNumber(account.requestCount)}</span><span data-label={t("admin.account.last")}>{new Date(account.lastRequestedAt).toLocaleString(lang === "ru" ? "ru-RU" : "en-US", { timeZone: "Europe/Moscow" })}</span><span className="admin-signals" data-label={t("admin.account.signals")}><Signals moderation={moderation} sources={account.sources} t={t} /></span></summary><div className="admin-account-details"><dl><div><dt>{t("admin.account.refreshes")}</dt><dd>{formatNumber(account.refreshCount)}</dd></div>{Object.entries(account.outcomes ?? {}).map(([key, value]) => <div key={key}><dt>{outcomeLabel(key, t)}</dt><dd>{formatNumber(value)}</dd></div>)}{moderation?.risk && <div><dt>{t("admin.account.risk")}</dt><dd>{moderation.risk.score} · {t("admin.risk." + moderation.risk.tier)}</dd></div>}</dl>{(suspicious || moderation) && <ModerationForm account={account} moderation={moderation} t={t} reload={reload} />}</div></details>;
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
  if (moderation?.sources.communityReports) labels.push(t("admin.source.reports", { n: moderation.sources.communityReports }));
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

function HealthPanel({ summary, lang, t }: { summary: Summary | null; lang: string; t: T }) {
  const health = summary?.health;
  if (!health) return <Empty t={t} />;
  const values: Array<[string, string]> = [["requests", formatNumber(health.requests)], ["success", formatNumber(health.success)], ["notFound", formatNumber(health.notFound)], ["rateLimited", formatNumber(health.rateLimited)], ["serverErrors", formatNumber(health.serverErrors)], ["p50", health.p50Ms == null ? t("common.notAvailable") : `${health.p50Ms} ms`], ["p95", health.p95Ms == null ? t("common.notAvailable") : `${health.p95Ms} ms`], ["cacheHits", formatNumber(health.cacheHits)], ["cacheMisses", formatNumber(health.cacheMisses)]];
  return <div className="admin-stack"><div className="admin-metrics">{values.map(([key, value]) => <StatCard key={key} label={t("admin.health." + key)} value={value} />)}</div><section className="data-panel admin-panel"><h2 className="section-heading">{t("admin.health.freshness")}</h2><dl className="admin-health-dates"><div><dt>{t("admin.health.lastSuccess")}</dt><dd>{formatDate(health.lastSuccessAt, lang, t)}</dd></div><div><dt>{t("admin.health.lastEvent")}</dt><dd>{formatDate(summary?.freshness?.lastEventAt ?? null, lang, t)}</dd></div><div><dt>{t("admin.health.lastProfile")}</dt><dd>{formatDate(summary?.freshness?.lastProfileRequestAt ?? null, lang, t)}</dd></div></dl></section></div>;
}
function formatDate(value: number | null, lang: string, t: T) { return value ? new Date(value).toLocaleString(lang === "ru" ? "ru-RU" : "en-US", { timeZone: "Europe/Moscow" }) : t("common.notAvailable"); }
function Empty({ t }: { t: T }) { return <div className="surface admin-empty">{t("admin.empty")}</div>; }
