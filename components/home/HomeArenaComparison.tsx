"use client";

import { useEffect, useId, useState } from "react";
import ArenaOverallComparison from "@/components/ArenaOverallComparison";
import { toArenaProfile } from "@/components/arena-ui";
import { loadPlayerProfileResponse } from "@/lib/client-profile-request";
import { useFavorites } from "@/lib/favorites/context";
import { useI18n } from "@/lib/i18n/context";
import type { ArenaProfile, ArenaStatistic, ArenaStoredMode } from "@/types/arena";

export default function HomeArenaComparison({ profile, scope, statistic, onStatisticChange }: {
  profile: ArenaProfile; scope: ArenaStoredMode; statistic: ArenaStatistic;
  onStatisticChange: (statistic: ArenaStatistic) => void;
}) {
  const { t } = useI18n();
  const { favorites, authStatus, loading } = useFavorites();
  const [showFavorite, setShowFavorite] = useState(false);
  const [selectedAid, setSelectedAid] = useState<number | null>(null);
  const [favoriteResult, setFavoriteResult] = useState<{ aid: number; profile: ArenaProfile | null } | null>(null);
  const hintId = useId();
  const eligible = favorites.filter((favorite) => favorite.aid !== profile.aid);
  const defaultAid = eligible.find((favorite) => favorite.isMain)?.aid ?? eligible[0]?.aid ?? null;
  const favoriteAid = eligible.some((favorite) => favorite.aid === selectedAid) ? selectedAid : defaultAid;
  const favoriteEntry = eligible.find((favorite) => favorite.aid === favoriteAid);
  const canCompare = authStatus === "authenticated" && !loading && favoriteAid != null;
  const comparingFavorite = showFavorite && canCompare;
  const current = favoriteResult?.aid === favoriteAid ? favoriteResult : null;
  const favorite = comparingFavorite ? current?.profile : null;
  const unavailableHint = loading ? "common.loading" : authStatus === "error" ? "home.comparisonUnavailable"
    : authStatus === "authenticated" ? "arena.favorite.empty" : "arena.favorite.authRequired";

  useEffect(() => {
    if (!comparingFavorite || favoriteAid == null) return;
    const aid = favoriteAid;
    const controller = new AbortController();
    const params = new URLSearchParams({ aid: String(aid), mode: "arena" });
    let active = true;
    setFavoriteResult(null);
    void loadPlayerProfileResponse<{ identity?: { aid: number; mode: string } }>(`/api/player/profile?${params}`, { force: true, signal: controller.signal })
      .then(({ ok, body }) => {
        const next = ok && body.identity?.aid === aid && body.identity.mode === "arena" ? toArenaProfile(body, aid) : null;
        if (active) setFavoriteResult({ aid, profile: next?.aid === aid ? next : null });
      })
      .catch(() => { if (active) setFavoriteResult({ aid, profile: null }); });
    return () => { active = false; controller.abort(); };
  }, [comparingFavorite, favoriteAid]);

  const player = scope === "overall" ? profile.overall : profile.modes[scope];
  const favoriteStats = scope === "overall" ? favorite?.overall : favorite?.modes[scope];
  return <>
    <div className="profile-comparison-controls">
      <div className="profile-segments" role="group" aria-label={t("home.compareWith")}>
        <button type="button" aria-pressed={!comparingFavorite} onClick={() => setShowFavorite(false)}>{t(scope === "overall" ? "home.averagePlayer" : "arena.combat.similar")}</button>
        <span className={canCompare ? undefined : "disabled-control-hint"} tabIndex={canCompare ? undefined : 0} role={canCompare ? undefined : "group"} aria-label={canCompare ? undefined : t("arena.combat.favorite")} aria-describedby={canCompare ? undefined : hintId}>
          <button type="button" aria-pressed={comparingFavorite} disabled={!canCompare} aria-describedby={canCompare ? undefined : hintId} onClick={() => setShowFavorite(true)}>{t("arena.combat.favorite")}</button>
          {!canCompare && <span id={hintId} role="tooltip" className="disabled-control-tooltip">{t(unavailableHint)}</span>}
        </span>
      </div>
      {comparingFavorite && <label className="profile-select"><span className="sr-only">{t("arena.favorite.label")}</span><select value={favoriteAid ?? ""} onChange={(event) => setSelectedAid(Number(event.target.value))}>
        {eligible.map((entry) => <option key={entry.aid} value={entry.aid}>{entry.nickname || `#${entry.aid}`}</option>)}
      </select></label>}
    </div>
    <div className="profile-comparison-method">
      <label className="profile-select"><span className="sr-only">{t("arena.statistic.label")}</span><select value={statistic} onChange={(event) => onStatisticChange(event.target.value === "median" ? "median" : "trimmed_mean")}>
        <option value="trimmed_mean">{t("arena.statistic.trimmedMean")}</option><option value="median">{t("arena.statistic.median")}</option>
      </select></label>
      <span className="profile-scope-name">{t(scope === "overall" ? "profile.allModes" : "arena.mode." + scope)}</span>
    </div>
    {comparingFavorite && (!current || !current.profile) && <p className="profile-chart-notice" role="status">{t(current ? "arena.favorite.error" : "arena.favorite.loading")}</p>}
    <ArenaOverallComparison aid={profile.aid} player={player} playerName={profile.nickname} mode={scope} statistic={statistic}
      favorite={favoriteStats} favoriteName={favorite?.nickname || favoriteEntry?.nickname} compareFavorite={comparingFavorite} />
  </>;
}
