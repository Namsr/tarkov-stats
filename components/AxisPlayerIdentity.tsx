"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState, type CSSProperties } from "react";
import { LeaderboardPreviewLink, LeaderboardPreviewProvider } from "@/components/LeaderboardPreview";
import { useI18n } from "@/lib/i18n/context";
import { axisKdaRatio, axisMatchHref, type AxisPlayer } from "@/lib/axis-league";

import { axisPlayerHref } from "@/lib/axis-player-profile";

type PreviewPlayer = Pick<AxisPlayer, "name" | "avatarUrl" | "profile"> & Partial<Omit<AxisPlayer, "mmr">>;

export function AxisAvatar({ name, url }: { name: string; url?: string | null }) {
  const { t } = useI18n();
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  return <span className="axis-avatar">
    {url && failedUrl !== url ? <Image src={url} width={40} height={40} unoptimized referrerPolicy="no-referrer"
      alt={t("axis.avatar", { name })} onError={() => setFailedUrl(url)} /> : <span aria-hidden="true">{Array.from(name.trim())[0]?.toLocaleUpperCase() ?? "?"}</span>}
  </span>;
}

function AxisLeagueStats({ player, averageKda }: { player: PreviewPlayer; averageKda: number | null }) {
  const { t, lang } = useI18n();
  const number = (value: number | null | undefined, digits = 0) => value == null ? "—" : value.toLocaleString(lang, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const matches = player.recentMatches ?? [];
  const stats = player.combatStats;
  const kda = stats ? axisKdaRatio(stats) : null;
  const winrate = player.winrate == null ? null : player.winrate * 100;
  const ratios = matches.map(axisKdaRatio);
  // Keep the mean at the midpoint when values fit; expand honestly for exceptional matches.
  const maximum = Math.max(1, (averageKda ?? 0) * 2, ...ratios);
  const reference = averageKda == null ? null : averageKda / maximum * 100;
  return <div className="axis-form">
    <div className="axis-form__summary">
      <div className="axis-form__ring" data-unknown={winrate == null} role="img" aria-label={t("axis.preview.winrateValue", { n: number(winrate) })}
        style={{ "--axis-winrate": `${winrate ?? 0}%`, "--axis-ring-color": winrate == null ? "var(--axis-form-track)" : "var(--success)" } as CSSProperties}>
        <div><strong>{number(winrate)}{winrate == null ? "" : "%"}</strong><span>{t("arena.metric.win_rate")}</span></div>
      </div>
      <div><p className="axis-form__season">{t("axis.season.current")}</p>
        <div className="axis-form__kda">{number(kda, 2)} <small>{t("axis.preview.kda")}</small></div>
        <p className="axis-form__record">{t("axis.column.wins")}: {number(player.wins)} <span aria-hidden="true">·</span> {t("axis.column.losses")}: {number(player.losses)}</p>
      </div>
    </div>
    {matches.length ? <>
      <div className="axis-form__legend" aria-hidden="true">
        <span><i className="axis-form__dot" />{t("axis.preview.win")}</span>
        <span><i className="axis-form__dot axis-form__dot--loss" />{t("axis.preview.loss")}</span>
        {reference != null && <span><i className="axis-form__rule" />{t("axis.preview.average")}</span>}
      </div>
      <section className="axis-form__chart" aria-label={t("axis.preview.recentKda")}>
        <div className="axis-form__heading"><h3>{t("axis.preview.recentKda")}</h3>
          {averageKda != null && <span>{t("axis.preview.average")} {number(averageKda, 2)}</span>}
        </div>
        <div className="axis-form__bars" style={{ "--axis-match-count": matches.length, "--axis-mean": `${reference ?? 0}%` } as CSSProperties}>
          {reference != null && <span className="axis-form__mean" aria-hidden="true" />}
          {matches.map((match, index) => {
            const result = t(match.won == null ? "axis.history.draw" : match.won ? "axis.preview.win" : "axis.preview.loss");
            const label = t("axis.preview.match", { n: match.number, result, kills: match.kills, deaths: match.deaths, assists: match.assists, kda: number(ratios[index], 2) });
            return <Link key={match.number} href={axisMatchHref(match.number)} prefetch={false}
              className="axis-form__bar-link" data-result={match.won == null ? "draw" : match.won ? "win" : "loss"}
              aria-label={label} title={label} style={{ "--axis-bar-height": `${ratios[index] / maximum * 100}%` } as CSSProperties}
              onKeyDown={(event) => {
                if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                event.preventDefault();
                const links = [...event.currentTarget.parentElement!.querySelectorAll<HTMLAnchorElement>(".axis-form__bar-link")];
                links[(index + (event.key === "ArrowRight" ? 1 : links.length - 1)) % links.length].focus();
              }}>
              <span className="axis-form__bar" aria-hidden="true" />
              <span className="axis-form__value" aria-hidden="true">{number(ratios[index], 2)}</span>
              <span className="axis-form__result" aria-hidden="true">{t(match.won == null ? "axis.preview.drawMark" : match.won ? "axis.preview.winMark" : "axis.preview.lossMark")}</span>
            </Link>;
          })}
        </div>
      </section>
    </> : <p className="leaderboard-preview__status" role="status">{t("axis.kda.empty")}</p>}
  </div>;
}

function ArenaNickname({ aid }: { aid: number }) {
  const { t } = useI18n();
  const [nickname, setNickname] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ aid: String(aid), mode: "arena", arenaMode: "blastGang" });
    void fetch(`/api/leaderboard/preview?${params}`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) })
      .then(async (response) => {
        if (!response.ok) throw new Error("Arena nickname unavailable");
        const body = await response.json();
        if (body.aid !== aid || body.mode !== "arena" || typeof body.nickname !== "string" || !body.nickname.trim()) throw new Error("Invalid Arena nickname");
        if (!controller.signal.aborted) setNickname(body.nickname);
      }).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [aid]);
  return <span className="axis-player__arena-name" title={nickname ?? undefined}>
    {t("axis.player.arenaNickname", { name: nickname ?? t(failed ? "axis.player.arenaUnavailable" : "common.loading") })}
  </span>;
}

export default function AxisPlayerIdentity({ player, mmr, averageKda = null, showArenaNickname = false }: { player: PreviewPlayer; mmr: number | null; averageKda?: number | null; showArenaNickname?: boolean }) {
  const { t, lang } = useI18n();
  const number = (value: number | null | undefined) => value == null ? "—" : value.toLocaleString(lang);
  const portrait = <AxisAvatar name={player.name} url={player.avatarUrl} />;
  return <LeaderboardPreviewProvider detailsLabel={t("axis.title")} meta={{ mode: "arena", cycleId: null, arenaMode: "blastGang", generation: 0 }}
    detailsHeader={(nameId) => <>
      <div className="axis-form__identity"><div className="axis-form__rank"><span>{t("axis.column.position")}</span><strong>{player.position == null ? "—" : `#${number(player.position)}`}</strong></div>
        {portrait}<div className="axis-form__name"><h2 id={nameId} title={player.name}>{player.name}</h2><span>{t("axis.season.current")}</span></div>
      </div>
      <div className="axis-form__ratings"><span>{t("axis.column.mmr")} <strong>{number(mmr)}</strong></span><span>{t("axis.column.peakMmr")} <strong>{number(player.peakMmr)}</strong></span></div>
    </>}>
    <LeaderboardPreviewLink aid={player.profile?.aid ?? null} nickname={player.name}
      href={player.profile ? axisPlayerHref(player.profile) : null} className={`axis-player${showArenaNickname ? " axis-player--editing" : ""}`}
      portrait={portrait} details={<AxisLeagueStats player={player} averageKda={averageKda} />}>
      {portrait}<span className="axis-player__name">{player.name}{showArenaNickname && player.profile && <ArenaNickname key={player.profile.aid} aid={player.profile.aid} />}</span>
    </LeaderboardPreviewLink>
  </LeaderboardPreviewProvider>;
}
