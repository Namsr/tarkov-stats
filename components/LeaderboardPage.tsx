"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Fragment, useEffect, useMemo, useState } from "react";
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
const SORTS: LeaderboardSort[] = ["primary", "score", "kd", "killsPerMatch", "kills", "hours"];

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

function queryDir(value: string | null): "desc" | "asc" {
  return value === "asc" ? "asc" : "desc";
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
  const hasAlternatePrimary = mode === "arena" && (arenaMode === "blastGang" || arenaMode === "lastHero");
  const requestedSort = querySort(searchParams.get("sort"));
  const sort = requestedSort === "score" && !hasAlternatePrimary ? "primary" : requestedSort;
  const direction = queryDir(searchParams.get("dir"));
  const cycle = queryCycle(searchParams.get("cycle"));
  const aid = positiveAid(searchParams.get("aid"));
  const [result, setResult] = useState<{
    key: string;
    data: LeaderboardPageResponse | null;
    error: string;
  } | null>(null);
  const [mobileList, setMobileList] = useState<"top" | "around">("top");
  // Edge-jump toggle: one button, both arrows inside. The lit arrow is the
  // last jump target (starts at top); press jumps to the other end.
  const [jumpDir, setJumpDir] = useState<"top" | "end">("top");

  const requestUrl = useMemo(() => {
    const params = new URLSearchParams({ mode, sort, dir: direction });
    if (mode === "arena") params.set("arenaMode", arenaMode);
    if (mode === "pvp-season" && cycle) params.set("cycle", cycle);
    if (aid != null) params.set("aid", String(aid));
    return `/api/leaderboard?${params}`;
  }, [aid, arenaMode, cycle, mode, sort, direction]);
  const data = result?.key === requestUrl ? result.data : null;
  const error = result?.key === requestUrl ? result.error : "";
  const loading = result?.key !== requestUrl;
  const visible = data ?? (loading ? result?.data : null);
  const switching = loading && visible != null;

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
    dir?: "desc" | "asc";
    aid?: number | null;
    cycle?: string | null;
  }) {
    const nextMode = next.mode ?? mode;
    const params = new URLSearchParams();
    params.set("mode", nextMode);
    const nextSort = next.sort ?? sort;
    if (nextMode === "arena") params.set("arenaMode", next.arenaMode ?? arenaMode);
    const nextCycle = next.cycle === undefined ? visible?.meta.cycleId ?? cycle : next.cycle;
    if (nextMode === "pvp-season" && nextCycle) params.set("cycle", nextCycle);
    if (nextSort !== "primary") params.set("sort", nextSort);
    const nextDir = next.dir ?? direction;
    if (nextDir === "asc") params.set("dir", "asc");
    const nextAid = next.aid === undefined ? aid : next.aid;
    if (nextAid != null) params.set("aid", String(nextAid));
    const url = `/leaderboard?${params}`;
    window.history.pushState(null, "", url);
  }

  function changeMode(nextMode: LeaderboardMode) {
    updateQuery({
      mode: nextMode,
      arenaMode: nextMode === "arena" ? "blastGang" : undefined,
      sort: sort === "hours" || sort === "kills" ? sort : "primary",
    });
  }

  function changeArenaMode(nextMode: ArenaModeKey) {
    updateQuery({ arenaMode: nextMode, sort: sort === "hours" || sort === "kills" ? sort : "primary" });
  }

  function handleSortClick(key: LeaderboardSort) {
    if (key === sort) {
      updateQuery({ dir: direction === "desc" ? "asc" : "desc" });
    } else {
      updateQuery({ sort: key, dir: "desc" });
    }
  }

  const orderedTop = visible?.top ?? [];
  const orderedAround = visible?.around;

  function jumpEdge(target: "top" | "end") {
    setJumpDir(target);
    jump(target);
  }

  function scrollToPlayer(retries: number): void {
    const around = [
      ...Array.from(document.querySelectorAll<HTMLElement>("#leaderboard-around [data-leaderboard-selected='true']")),
      ...Array.from(document.querySelectorAll<HTMLElement>("#leaderboard-around[data-leaderboard-selected='true']")),
    ];
    // The marker exists twice: on the table row (hidden on mobile) and on the
    // card (the visible copy). Scroll the visible one.
    const visible = around.find((item) => item.getClientRects().length > 0);
    if (visible) {
      visible.scrollIntoView({ block: "center" });
      visible.focus({ preventScroll: true });
      return;
    }
    if (around.length > 0 && retries < 10) {
      // Around-list exists but is still hidden (mobile list flip pending) — wait for it.
      window.requestAnimationFrame(() => scrollToPlayer(retries + 1));
      return;
    }
    if (around.length === 0) {
      const top = Array.from(document.querySelectorAll<HTMLElement>("#leaderboard-top [data-leaderboard-selected='true']")).find((item) => item.getClientRects().length > 0);
      top?.scrollIntoView({ block: "center" });
      top?.focus({ preventScroll: true });
    }
  }

  function scrollEdge(listId: "leaderboard-top" | "leaderboard-around", block: "start" | "end", retries: number): void {
    const element = document.getElementById(listId);
    if (element && element.getClientRects().length > 0) {
      element.scrollIntoView({ block });
      element.focus({ preventScroll: true });
      return;
    }
    // The target list can still be hidden right after a mobile list switch — wait for it.
    if (retries < 10) {
      window.requestAnimationFrame(() => scrollEdge(listId, block, retries + 1));
      return;
    }
    element?.scrollIntoView({ block });
  }

  function jump(target: "top" | "end" | "player") {
    if (target === "player") {
      setMobileList(visible?.around ? "around" : "top");
      window.requestAnimationFrame(() => scrollToPlayer(0));
      return;
    }
    if (target === "top") {
      // Top always means the main list, even when the around list is the active mobile list.
      setMobileList("top");
      window.requestAnimationFrame(() => scrollEdge("leaderboard-top", "start", 0));
      return;
    }
    window.requestAnimationFrame(() => {
      const mobile = window.matchMedia("(max-width: 767px)").matches;
      // Desktop shows both lists side by side: end means the end of the main
      // list. On mobile only the active list is visible, so end follows it.
      if (mobile && mobileList === "around" && visible?.around) {
        scrollEdge("leaderboard-around", "end", 0);
      } else {
        scrollEdge("leaderboard-top", "end", 0);
      }
    });
  }

  const locale = lang === "ru" ? "ru-RU" : "en-US";
  const focused = aid != null;
  const isBlastGang = mode === "arena" && arenaMode === "blastGang";
  function pillLabel(key: LeaderboardSort): string {
    if (key === "score") return t("leaderboard.pills.score");
    if (key === "primary") return isBlastGang ? t("leaderboard.column.bestArp") : mode === "arena" && arenaMode === "lastHero" ? t("leaderboard.pills.perMatch") : t("leaderboard.pills.score");
    if (key === "kd") return t("leaderboard.pills.kd");
    if (key === "killsPerMatch") return mode === "arena" ? t("leaderboard.pills.perMatch") : t("leaderboard.pills.perRaid");
    if (key === "kills") return t("leaderboard.pills.kills");
    return t("leaderboard.pills.hours");
  }
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
  const publicationKey = visible && visible.meta.publicationStatus !== "ready"
    ? `leaderboard.publication.${visible.meta.publicationStatus}`
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

        {mode === "arena" && visible?.meta.arenaTabs && (
          <div className="leaderboard-arena-tabs" role="group" aria-label={t("leaderboard.arenaModes") }>
            {visible.meta.arenaTabs.map((tab) => (
              <button key={tab.mode} type="button" aria-pressed={arenaMode === tab.mode} onClick={() => changeArenaMode(tab.mode)}>
                <span>{arenaModeLabels[tab.mode]}</span>
                <small>{t("leaderboard.knownProfiles", { n: tab.knownMatchProfiles.toLocaleString(locale) })}</small>
              </button>
            ))}
          </div>
        )}

      </section>

      {publicationKey && <p className="leaderboard-publication" role="status">{t(publicationKey)}</p>}

      {loading && !visible && <LeaderboardLoading />}
      {error && (
        <div className="data-panel leaderboard-state" role="alert">
          <p>{error}</p>
          <button type="button" className="ghost-button" onClick={() => window.location.reload()}>{t("leaderboard.retry")}</button>
        </div>
      )}

      {visible && (
        <div className={switching ? "leaderboard-switching" : undefined} aria-busy={switching || undefined}>
          <div className="leaderboard-sticky">
            <div className="leaderboard-sort-pills" role="group" aria-label={t("leaderboard.sort.label")}>
              <button
                type="button"
                className="leaderboard-jump-toggle"
                disabled={loading}
                aria-label={jumpDir === "top" ? t("leaderboard.jump.end") : t("leaderboard.jump.start")}
                onClick={() => jumpEdge(jumpDir === "top" ? "end" : "top")}
              >
                <span aria-hidden="true" className={`leaderboard-jump-toggle__arrow${jumpDir === "top" ? "" : " is-dim"}`}>↑</span>
                <span aria-hidden="true" className={`leaderboard-jump-toggle__arrow${jumpDir === "end" ? "" : " is-dim"}`}>↓</span>
              </button>
              {SORTS.filter((key) => key !== "score" || hasAlternatePrimary).map((key) => (
                <Fragment key={key}>
                  {key === "kills" && <span aria-hidden="true" className="leaderboard-sort-pills__break" />}
                  <button type="button" className="leaderboard-sort-pill" aria-label={`${pillLabel(key)}: ${t(sort === key && direction === "desc" ? "leaderboard.sort.ascending" : "leaderboard.sort.descending")}`} aria-pressed={sort === key} onClick={() => handleSortClick(key)}>
                    {pillLabel(key)}
                    {sort === key && (
                      <span aria-hidden="true" className="leaderboard-sort-pills__arrow">{direction === "desc" ? "↓" : "↑"}</span>
                    )}
                  </button>
                </Fragment>
              ))}
              {focused && (
                <button type="button" className="leaderboard-jump-player" disabled={loading || !visible.subject} onClick={() => jump("player")}>{t("leaderboard.jump.player")}</button>
              )}
            </div>
          </div>

          {focused && visible.around && (
            <div className="leaderboard-mobile-lists" role="group" aria-label={t("leaderboard.mobileLists") }>
              <button type="button" aria-pressed={mobileList === "top"} onClick={() => setMobileList("top")}>{t(direction === "asc" ? "leaderboard.ascendingList" : "leaderboard.top100")}</button>
              <button type="button" aria-pressed={mobileList === "around"} onClick={() => setMobileList("around")}>{t("leaderboard.aroundPlayer")}</button>
            </div>
          )}

          {/* No key here on purpose: rows keep their DOM nodes across sorts,
              so updates swap instantly instead of flashing. The entrance
              cascade (lb-rise) plays once on first mount. */}
          <div className={`leaderboard-lists${focused ? " leaderboard-lists--focused" : ""}${visible.around ? " leaderboard-lists--has-around" : ""}`} data-mobile-list={mobileList}>
            <LeaderboardTable
              id="leaderboard-top"
              title={t(direction === "asc" ? "leaderboard.ascendingList" : focused ? "leaderboard.top100" : "leaderboard.top500")}
              rows={orderedTop}
              meta={visible.meta}
              direction={direction}
            />
            {focused && visible.around && orderedAround && (
              <LeaderboardTable id="leaderboard-around" title={t("leaderboard.aroundPlayer")} rows={orderedAround} meta={visible.meta} direction={direction} />
            )}
            {focused && !visible.around && visible.subject && (
              <section id="leaderboard-around" tabIndex={-1} data-leaderboard-selected="true" className="leaderboard-insufficient data-panel">
                <h2 className="section-heading">{t("leaderboard.insufficient.title")}</h2>
                <p>{subjectMessages[visible.subject.status]}</p>
                <dl>
                  <div><dt>{t("leaderboard.column.player")}</dt><dd>{visible.subject.nickname}</dd></div>
                  <div><dt>{t("leaderboard.column.kd")}</dt><dd>{visible.subject.stats.deathless ? (visible.subject.stats.kills?.toLocaleString(locale) ?? "—") : visible.subject.stats.kd?.toLocaleString(locale, { maximumFractionDigits: 2 }) ?? "—"}</dd></div>
                  <div><dt>{mode === "arena" ? t("leaderboard.column.matches") : t("leaderboard.column.raids")}</dt><dd>{visible.subject.stats.raidsOrMatches?.toLocaleString(locale) ?? "—"}</dd></div>
                </dl>
              </section>
            )}
          </div>
        </div>
      )}
    </main>
  );
}

export function LeaderboardLoading() {
  const { t } = useI18n();
  return (
    <div className="leaderboard-loading" role="status" aria-live="polite">
      <span className="sr-only">{t("common.loading")}</span>
      <div className="h-16 skeleton rounded-xl" aria-hidden="true" />
      {Array.from({ length: 8 }).map((_, index) => <div key={index} className="h-12 skeleton rounded-lg" aria-hidden="true" />)}
    </div>
  );
}
