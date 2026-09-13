"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import type { LeaderboardMode, LeaderboardPageResponse } from "@/types/leaderboard";

export default function HomeLeaderboard() {
  const { t, lang } = useI18n();
  const [mode, setMode] = useState<LeaderboardMode>("regular");
  const [visible, setVisible] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ mode: LeaderboardMode; data: LeaderboardPageResponse | null } | null>(null);
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new IntersectionObserver(([entry]) => { if (entry.isIntersecting) { setVisible(true); observer.disconnect(); } }, { rootMargin: "400px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    const params = new URLSearchParams({ mode, sort: "primary", dir: "desc", limit: "5" });
    if (mode === "arena") params.set("arenaMode", "blastGang");
    fetch(`/api/leaderboard?${params}`, { signal: controller.signal }).then(async (response) => {
      const data = response.ok ? await response.json() as LeaderboardPageResponse : null;
      if (!controller.signal.aborted) setResult({ mode, data });
    }).catch(() => { if (!controller.signal.aborted) setResult({ mode, data: null }); });
    return () => controller.abort();
  }, [mode, visible, attempt]);

  // Stale-while-revalidate: keep the previous mode's table on screen while the
  // next mode loads. Wiping to the loading panel collapses the section and
  // shifts the whole page on every switch. The stale snapshot keeps its own
  // mode for headers, values and links so rows never mix with the new mode.
  const current = result && result.mode === mode ? result : null;
  const data = current ? current.data : result?.data ?? undefined;
  const switching = current == null && data != null;
  const displayMode: LeaderboardMode = current == null && result?.data ? result.mode : mode;
  const n = (value: number | null, digits = 0) => value == null ? "—" : value.toLocaleString(lang, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const leaderboardHref = `/leaderboard?mode=${mode}${mode === "arena" ? "&arenaMode=blastGang" : ""}`;
  return <section id="leaderboard" ref={ref} className="home-section home-wrap home-leaderboard-section">
    <div className="home-section-head"><h2>{t("leaderboard.title")}</h2><Link className="home-text-link" prefetch={false} href={leaderboardHref}>{t("home.fullLeaderboard")}<span aria-hidden="true">↗</span></Link></div>
    <div className="home-segments home-leader-modes" role="group" aria-label={t("leaderboard.mode")}>
      {(["regular", "pve", "arena", "pvp-season"] as const).map((key) => <button key={key} type="button" aria-pressed={key === mode} onClick={() => setMode(key)}>{t("fav.mode." + (key === "pvp-season" ? "seasonal" : key))}</button>)}
    </div>
    {data?.top.length ? <div className={switching ? "home-leaderboard-switching" : undefined} aria-busy={switching || undefined}>
      {data.meta.publicationStatus !== "ready" && <p className="home-board-status" role="status">{t("leaderboard.publication." + data.meta.publicationStatus)}</p>}
      <table className="home-leaderboard"><thead><tr>
        <th scope="col">{t("leaderboard.column.rank")}</th><th scope="col">{t("leaderboard.column.player")}</th><th scope="col">{t(displayMode === "arena" ? "leaderboard.column.arp" : "leaderboard.column.score")}</th><th scope="col" className="home-leader-kd">{t(displayMode === "arena" ? "leaderboard.column.kd" : "metric.pmc_kd_ratio")}</th><th scope="col" className="home-leader-hours">{t("metric.hours")}</th><th scope="col"><span className="sr-only">{t("home.openProfile")}</span></th>
      </tr></thead><tbody>{data.top.slice(0, 5).map((row) => {
        const href = `/player/${displayMode}/${row.aid}${displayMode === "pvp-season" && data.meta.cycleId ? `?cycle=${encodeURIComponent(data.meta.cycleId)}` : ""}`;
        return <tr key={row.aid}><td>{row.primaryRank == null ? row.groupStart == null ? "—" : `${n(row.groupStart)}+` : n(row.primaryRank)}</td><td><Link prefetch={false} href={href}>{row.nickname}</Link></td><td>{n(displayMode === "arena" ? row.stats.arp : row.score, displayMode === "arena" ? 0 : 2)}</td><td className="home-leader-kd" title={row.stats.deathless ? t("leaderboard.deathless") : undefined}>{n(row.stats.kd ?? (row.stats.deathless ? row.stats.kills : null), 2)}</td><td className="home-leader-hours">{n(row.stats.hours)}</td><td><Link prefetch={false} href={href} aria-label={t("search.openProfile", { mode: t("fav.mode." + (displayMode === "pvp-season" ? "seasonal" : displayMode)), nickname: row.nickname })}>↗</Link></td></tr>;
      })}</tbody></table>
    </div> : <div className="home-loading-panel" role="status"><p>{t(data === undefined ? "common.loading" : "leaderboard.error")}</p>{data !== undefined && <button className="home-text-link" type="button" onClick={() => setAttempt((value) => value + 1)}>{t("leaderboard.retry")}</button>}</div>}
  </section>;
}
