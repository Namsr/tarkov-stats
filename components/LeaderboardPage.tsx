"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import LeaderboardTable from "@/components/LeaderboardTable";
import { useI18n } from "@/lib/i18n/context";
import { ARENA_MODE_KEYS, type ArenaModeKey } from "@/types/arena";
import type {
  LeaderboardErrorResponse,
  LeaderboardMode,
  LeaderboardPageResponse,
  LeaderboardSort,
} from "@/types/leaderboard";

const MODES: LeaderboardMode[] = ["regular", "pve", "arena", "pvp-season"];
const SORTS: LeaderboardSort[] = ["primary", "kd", "killsPerMatch", "hours"];

function positiveAid(value: string | null): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const aid = Number(value);
  return Number.isSafeInteger(aid) && aid > 0 ? aid : null;
}

function queryMode(value: string | null): LeaderboardMode {
  return MODES.find((mode) => mode === value) ?? "regular";
}

function queryArenaMode(value: string | null): ArenaModeKey {
  return ARENA_MODE_KEYS.find((mode) => mode === value) ?? "blastGang";
}

function querySort(value: string | null): LeaderboardSort {
  return SORTS.find((sort) => sort === value) ?? "primary";
}

function queryCycle(value: string | null): string | null {
  const cycle = value?.trim();
  return cycle || null;
}

export default function LeaderboardPage() {
  const { lang, t } = useI18n();
  const searchParams = useSearchParams();
  const mode = queryMode(searchParams.get("mode"));
  const arenaMode = queryArenaMode(searchParams.get("arenaMode"));
  const sort = querySort(searchParams.get("sort"));
  const cycle = queryCycle(searchParams.get("cycle"));
  const aid = positiveAid(searchParams.get("aid"));
  const [result, setResult] = useState<{
    key: string;
    data: LeaderboardPageResponse | null;
    error: string;
  } | null>(null);
  const [mobileList, setMobileList] = useState<"top" | "around">("top");

  const requestUrl = useMemo(() => {
    const params = new URLSearchParams({ mode, sort });
    if (mode === "arena") params.set("arenaMode", arenaMode);
    if (mode === "pvp-season" && cycle) params.set("cycle", cycle);
    if (aid != null) params.set("aid", String(aid));
    return `/api/leaderboard?${params}`;
  }, [aid, arenaMode, cycle, mode, sort]);
  const data = result?.key === requestUrl ? result.data : null;
  const error = result?.key === requestUrl ? result.error : "";
  const loading = result?.key !== requestUrl;

  useEffect(() => {
    const controller = new AbortController();
    fetch(requestUrl, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        const body = await response.json() as LeaderboardPageResponse | LeaderboardErrorResponse;
        if (!response.ok || !("meta" in body)) throw new Error(t("leaderboard.error"));
        return body;
      })
      .then((response) => {
        if (!controller.signal.aborted) setResult({ key: requestUrl, data: response, error: "" });
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setResult({ key: requestUrl, data: null, error: t("leaderboard.error") });
        }
      });
    return () => controller.abort();
  }, [requestUrl, t]);

  function updateQuery(next: {
    mode?: LeaderboardMode;
    arenaMode?: ArenaModeKey;
    sort?: LeaderboardSort;
    aid?: number | null;
    cycle?: string | null;
  }) {
    const nextMode = next.mode ?? mode;
    const params = new URLSearchParams();
    params.set("mode", nextMode);
    const nextSort = next.sort ?? sort;
    if (nextMode === "arena") params.set("arenaMode", next.arenaMode ?? arenaMode);
    const nextCycle = next.cycle === undefined ? data?.meta.cycleId ?? cycle : next.cycle;
    if (nextMode === "pvp-season" && nextCycle) params.set("cycle", nextCycle);
    if (nextSort !== "primary") params.set("sort", nextSort);
    const nextAid = next.aid === undefined ? aid : next.aid;
    if (nextAid != null) params.set("aid", String(nextAid));
    window.history.pushState(null, "", `/leaderboard?${params}`);
  }

  function changeMode(nextMode: LeaderboardMode) {
    updateQuery({
      mode: nextMode,
      arenaMode: nextMode === "arena" ? "blastGang" : undefined,
      sort: sort === "hours" ? "hours" : "primary",
    });
  }

  function changeArenaMode(nextMode: ArenaModeKey) {
    updateQuery({ arenaMode: nextMode, sort: sort === "hours" ? "hours" : "primary" });
  }

  function jump(target: "top" | "end" | "player") {
    if (target === "player") setMobileList("around");
    window.requestAnimationFrame(() => {
      const mobile = window.matchMedia("(max-width: 767px)").matches;
      const visibleListId = mobile && mobileList === "top"
        ? "leaderboard-top"
        : data?.around
          ? "leaderboard-around"
          : "leaderboard-top";
      const element = target === "player"
        ? document.querySelector<HTMLElement>("#leaderboard-around [data-leaderboard-selected='true']")
          ?? document.querySelector<HTMLElement>("#leaderboard-around[data-leaderboard-selected='true']")
          ?? document.querySelector<HTMLElement>("#leaderboard-top [data-leaderboard-selected='true']")
        : document.getElementById(target === "top" && !mobile ? "leaderboard-top" : visibleListId);
      element?.scrollIntoView({ block: target === "top" ? "start" : target === "end" ? "end" : "center" });
      element?.focus({ preventScroll: true });
    });
  }

  const locale = lang === "ru" ? "ru-RU" : "en-US";
  const focused = aid != null;
  const modeLabels: Record<LeaderboardMode, string> = {
    regular: t("fav.mode.regular"),
    pve: t("fav.mode.pve"),
    arena: t("fav.mode.arena"),
    "pvp-season": t("fav.mode.seasonal"),
  };
  const arenaModeLabels: Record<ArenaModeKey, string> = {
    teamFight: t("arena.mode.teamFight"),
    lastHero: t("arena.mode.lastHero"),
    checkpoint: t("arena.mode.checkpoint"),
    blastGang: t("arena.mode.blastGang"),
    shootOutDuo: t("arena.mode.shootOutDuo"),
  };
  const subjectMessages = {
    ranked: t("leaderboard.subject.ranked"),
    insufficient_sample: t("leaderboard.subject.insufficient_sample"),
    missing_metrics: t("leaderboard.subject.missing_metrics"),
    inactive: t("leaderboard.subject.inactive"),
    season_unverified: t("leaderboard.subject.season_unverified"),
    reference_unavailable: t("leaderboard.subject.reference_unavailable"),
    excluded: t("leaderboard.subject.excluded"),
  };
  const primaryMetric = data?.meta.primaryMetric ?? (mode === "arena"
    ? arenaMode === "blastGang"
      ? "arp"
      : arenaMode === "lastHero"
        ? "killsPerMatch"
        : "performance"
    : "performance");
  // BlastGang sorts by Best ARP (no current ARP upstream) — label the primary sort accordingly.
  const primaryLabel = primaryMetric === "arp"
    ? t("leaderboard.column.bestArp")
    : primaryMetric === "killsPerMatch"
      ? t("leaderboard.sort.killsPerMatch")
      : t("leaderboard.sort.performance");
  const publicationKey = data && data.meta.publicationStatus !== "ready"
    ? `leaderboard.publication.${data.meta.publicationStatus}`
    : null;

  return (
    <main className={`page-frame leaderboard-page${focused ? " leaderboard-page--focused" : ""}`}>
      <Link href="/" className="inline-block text-sm text-[var(--muted)] transition-colors hover:text-[var(--foreground)]">
        {t("common.back")}
      </Link>
      <p className="page-kicker mt-7">{t("leaderboard.kicker")}</p>
      <h1 className="page-title">{t("leaderboard.title")}</h1>

      <section className="leaderboard-controls data-panel" aria-label={t("leaderboard.settings") }>
        <div className="leaderboard-mode-switch" role="group" aria-label={t("leaderboard.mode") }>
          {MODES.map((item) => (
            <button key={item} type="button" aria-pressed={mode === item} onClick={() => changeMode(item)}>
              {modeLabels[item]}
            </button>
          ))}
        </div>

        {mode === "arena" && data?.meta.arenaTabs && (
          <div className="leaderboard-arena-tabs" role="group" aria-label={t("leaderboard.arenaModes") }>
            {data.meta.arenaTabs.map((tab) => (
              <button key={tab.mode} type="button" aria-pressed={arenaMode === tab.mode} onClick={() => changeArenaMode(tab.mode)}>
                <span>{arenaModeLabels[tab.mode]}</span>
                <small>{t("leaderboard.knownProfiles", { n: tab.knownMatchProfiles.toLocaleString(locale) })}</small>
              </button>
            ))}
          </div>
        )}

        <label className="native-select leaderboard-sort">
          <span>{t("leaderboard.sort.label")}</span>
          <select
            value={sort}
            onChange={(event) => {
              if (event.target.value === "arp") {
                updateQuery({ arenaMode: "blastGang", sort: "primary" });
                return;
              }
              updateQuery({ sort: querySort(event.target.value) });
            }}
          >
            <option value="primary">{primaryLabel}</option>
            {mode === "arena" && arenaMode !== "blastGang" && <option value="arp">{t("leaderboard.column.bestArp")}</option>}
            <option value="kd">{t("leaderboard.sort.kd")}</option>
            <option value="killsPerMatch">{t(mode === "arena" ? "leaderboard.sort.killsPerMatch" : "leaderboard.sort.killsPerRaid")}</option>
            <option value="hours">{t(mode === "arena" ? "leaderboard.sort.arenaHours" : "leaderboard.sort.hours")}</option>
          </select>
        </label>
      </section>

      {publicationKey && <p className="leaderboard-publication" role="status">{t(publicationKey)}</p>}
      {data && (
        <p className="leaderboard-meta">
          {t("leaderboard.generated", { date: new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(data.meta.generatedAt) })}
          {" · "}{t("leaderboard.ranked", { n: data.meta.rankedCount.toLocaleString(locale) })}
        </p>
      )}

      {loading && <LeaderboardLoading />}
      {!loading && error && (
        <div className="data-panel leaderboard-state" role="alert">
          <p>{error}</p>
          <button type="button" className="ghost-button" onClick={() => window.location.reload()}>{t("leaderboard.retry")}</button>
        </div>
      )}

      {!loading && data && (
        <>
          {focused && (
            <div className="leaderboard-jumps" aria-label={t("leaderboard.jumps") }>
              <button type="button" onClick={() => jump("top")}>{t("leaderboard.jump.start")}</button>
              <button type="button" onClick={() => jump("end")}>{t("leaderboard.jump.end")}</button>
              <button type="button" disabled={!data.subject} onClick={() => jump("player")}>{t("leaderboard.jump.player")}</button>
            </div>
          )}

          {focused && data.around && (
            <div className="leaderboard-mobile-lists" role="group" aria-label={t("leaderboard.mobileLists") }>
              <button type="button" aria-pressed={mobileList === "top"} onClick={() => setMobileList("top")}>{t("leaderboard.top100")}</button>
              <button type="button" aria-pressed={mobileList === "around"} onClick={() => setMobileList("around")}>{t("leaderboard.aroundPlayer")}</button>
            </div>
          )}

          <div className={`leaderboard-lists${focused ? " leaderboard-lists--focused" : ""}${data.around ? " leaderboard-lists--has-around" : ""}`} data-mobile-list={mobileList}>
            <LeaderboardTable
              id="leaderboard-top"
              title={focused ? t("leaderboard.top100") : t("leaderboard.top500")}
              rows={data.top}
              meta={data.meta}
            />
            {focused && data.around && (
              <LeaderboardTable id="leaderboard-around" title={t("leaderboard.aroundPlayer")} rows={data.around} meta={data.meta} />
            )}
            {focused && !data.around && data.subject && (
              <section id="leaderboard-around" tabIndex={-1} data-leaderboard-selected="true" className="leaderboard-insufficient data-panel">
                <h2 className="section-heading">{t("leaderboard.insufficient.title")}</h2>
                <p>{subjectMessages[data.subject.status]}</p>
                <dl>
                  <div><dt>{t("leaderboard.column.player")}</dt><dd>{data.subject.nickname}</dd></div>
                  <div><dt>{t("leaderboard.column.kd")}</dt><dd>{data.subject.stats.deathless ? t("leaderboard.deathless") : data.subject.stats.kd?.toLocaleString(locale, { maximumFractionDigits: 2 }) ?? "—"}</dd></div>
                  <div><dt>{mode === "arena" ? t("leaderboard.column.matches") : t("leaderboard.column.raids")}</dt><dd>{data.subject.stats.raidsOrMatches?.toLocaleString(locale) ?? "—"}</dd></div>
                </dl>
              </section>
            )}
          </div>
        </>
      )}
    </main>
  );
}

export function LeaderboardLoading() {
  return (
    <div className="leaderboard-loading" aria-hidden="true">
      <div className="h-16 skeleton rounded-xl" />
      {Array.from({ length: 8 }).map((_, index) => <div key={index} className="h-12 skeleton rounded-lg" />)}
    </div>
  );
}
