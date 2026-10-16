"use client";

import Image from "next/image";
import { useState } from "react";
import { LeaderboardPreviewLink, LeaderboardPreviewProvider } from "@/components/LeaderboardPreview";
import { useI18n } from "@/lib/i18n/context";
import { axisProfileHref, type AxisProfile } from "@/lib/axis-league";

export function AxisAvatar({ name, url }: { name: string; url?: string | null }) {
  const { t } = useI18n();
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  return <span className="axis-avatar">
    {url && failedUrl !== url ? <Image src={url} width={40} height={40} unoptimized referrerPolicy="no-referrer"
      alt={t("axis.avatar", { name })} onError={() => setFailedUrl(url)} /> : <span aria-hidden="true">{Array.from(name.trim())[0]?.toLocaleUpperCase() ?? "?"}</span>}
  </span>;
}

export default function AxisPlayerIdentity({ player, mmr }: { player: { name: string; avatarUrl?: string | null; profile: AxisProfile | null; games?: number; wins?: number; losses?: number; winrate?: number }; mmr: number | null }) {
  const { t, lang } = useI18n();
  const mode = player.profile?.mode === "seasonal" ? "pvp-season" : player.profile?.mode ?? "arena";
  const portrait = <AxisAvatar name={player.name} url={player.avatarUrl} />;
  return <LeaderboardPreviewProvider meta={{ mode, cycleId: null, arenaMode: mode === "arena" ? "blastGang" : null, generation: 0 }}>
    <LeaderboardPreviewLink aid={player.profile?.aid ?? null} nickname={player.name}
      href={player.profile ? axisProfileHref(player.profile) : null} className="axis-player"
      portrait={portrait} details={<div className="axis-preview-rating"><span>{t("axis.title")}</span><strong>{mmr == null ? "—" : mmr.toLocaleString(lang)} <small>{t("axis.column.mmr")}</small></strong>
        {player.games != null && <dl className="axis-preview-metrics">
          <div><dt>{t("axis.column.games")}</dt><dd>{player.games.toLocaleString(lang)}</dd></div>
          <div><dt>{t("axis.column.wins")}</dt><dd>{player.wins?.toLocaleString(lang) ?? "—"}</dd></div>
          <div><dt>{t("axis.column.losses")}</dt><dd>{player.losses?.toLocaleString(lang) ?? "—"}</dd></div>
          <div><dt>{t("axis.column.winrate")}</dt><dd>{player.winrate == null ? "—" : player.winrate.toLocaleString(lang, { style: "percent", maximumFractionDigits: 1 })}</dd></div>
        </dl>}
        {!player.profile && <p>{t("axis.admin.unlinked")}</p>}</div>}>
      {portrait}<span className="axis-player__name">{player.name}</span>
    </LeaderboardPreviewLink>
  </LeaderboardPreviewProvider>;
}
