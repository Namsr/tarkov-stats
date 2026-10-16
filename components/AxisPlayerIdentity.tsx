"use client";

import Image from "next/image";
import { useState } from "react";
import { LeaderboardPreviewLink, LeaderboardPreviewProvider } from "@/components/LeaderboardPreview";
import { useI18n } from "@/lib/i18n/context";
import { axisProfileHref, type AxisPlayer } from "@/lib/axis-league";

export function AxisAvatar({ name, url }: { name: string; url?: string | null }) {
  const { t } = useI18n();
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  return <span className="axis-avatar">
    {url && failedUrl !== url ? <Image src={url} width={40} height={40} unoptimized referrerPolicy="no-referrer"
      alt={t("axis.avatar", { name })} onError={() => setFailedUrl(url)} /> : <span aria-hidden="true">{Array.from(name.trim())[0]?.toLocaleUpperCase() ?? "?"}</span>}
  </span>;
}

export default function AxisPlayerIdentity({ player, mmr }: { player: Pick<AxisPlayer, "name" | "avatarUrl" | "profile"> & Partial<Pick<AxisPlayer, "position" | "games" | "wins" | "losses" | "winrate" | "peakMmr" | "streak" | "peakStreak">> & { kda?: { kills: number; deaths: number; assists: number } | null }; mmr: number | null }) {
  const { t, lang } = useI18n();
  const portrait = <AxisAvatar name={player.name} url={player.avatarUrl} />;
  return <LeaderboardPreviewProvider detailsLabel={t("axis.title")} meta={{ mode: "arena", cycleId: null, arenaMode: "blastGang", generation: 0 }}>
    <LeaderboardPreviewLink aid={player.profile?.aid ?? null} nickname={player.name}
      href={player.profile ? axisProfileHref(player.profile) : null} className="axis-player"
      portrait={portrait} details={<div className="axis-preview-rating"><span>{t("axis.title")}</span><strong>{mmr == null ? "—" : mmr.toLocaleString(lang)} <small>{t("axis.column.mmr")}</small></strong>
        {player.games != null && <dl className="axis-preview-metrics">
          <div><dt>{t("axis.column.games")}</dt><dd>{player.games.toLocaleString(lang)}</dd></div>
          <div><dt>{t("axis.column.wins")}</dt><dd>{player.wins?.toLocaleString(lang) ?? "—"}</dd></div>
          <div><dt>{t("axis.column.losses")}</dt><dd>{player.losses?.toLocaleString(lang) ?? "—"}</dd></div>
          <div><dt>{t("axis.column.winrate")}</dt><dd>{player.winrate == null ? "—" : player.winrate.toLocaleString(lang, { style: "percent", maximumFractionDigits: 1 })}</dd></div>
        </dl>}
        {(player.position != null || player.peakMmr != null || player.streak != null || player.peakStreak != null) && <dl className="axis-preview-metrics axis-preview-metrics--secondary">
          {(["position", "peakMmr", "streak", "peakStreak"] as const).map((key) => player[key] != null && <div key={key}>
            <dt>{t("axis.column." + key)}</dt><dd>{key === "position" ? `#${player[key].toLocaleString(lang)}` : player[key].toLocaleString(lang)}</dd>
          </div>)}
        </dl>}
        {player.kda && <dl className="axis-preview-metrics">
          <div><dt>{t("axis.kda.short")}</dt><dd>{player.kda.kills} / {player.kda.deaths} / {player.kda.assists}</dd></div>
        </dl>}
        {!player.profile && <p>{t("axis.admin.unlinked")}</p>}</div>}>
      {portrait}<span className="axis-player__name">{player.name}</span>
    </LeaderboardPreviewLink>
  </LeaderboardPreviewProvider>;
}
