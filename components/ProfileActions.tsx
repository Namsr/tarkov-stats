"use client";

import { useState } from "react";
import FavoriteButton from "@/components/FavoriteButton";
import CheaterReportButton from "@/components/CheaterReportButton";
import RefreshButton, { type RefreshCheckResult } from "@/components/RefreshButton";
import { useI18n } from "@/lib/i18n/context";
import { appRouteMode, type GameMode } from "@/types/seasonal";

export default function ProfileActions({ aid, mode, cycleId, nickname }: {
  aid: number; mode: GameMode; cycleId: string; nickname?: string;
}) {
  const { t } = useI18n();
  const [message, setMessage] = useState("");
  async function share() {
    const url = new URL(`/player/${appRouteMode(mode)}/${aid}`, window.location.origin);
    if (mode === "seasonal") url.searchParams.set("cycle", cycleId);
    try {
      await navigator.clipboard.writeText(url.href);
      setMessage(t("profile.shareCopied"));
    } catch { setMessage(t("profile.shareFailed")); }
  }
  return <div className="profile-actions">
    <CheaterReportButton aid={aid} mode={mode} cycle={cycleId} />
    <FavoriteButton aid={aid} nickname={nickname} identity={{ mode, cycleId }} iconOnly />
    <div className="profile-action">
      <button type="button" className="ghost-button profile-icon-button" aria-label={t("profile.share")} onClick={() => void share()}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M12 15V3m-4 4 4-4 4 4M5 12v8h14v-8" /></svg>
      </button>
      {message && <span className="profile-action__status" role="status">{message}</span>}
    </div>
  </div>;
}

export function ProfileActivity({ aid, mode, updatedAt, lastPlayedAt, onCheck }: {
  aid: number; mode: GameMode; updatedAt?: number | null; lastPlayedAt?: number | null;
  onCheck: () => Promise<RefreshCheckResult>;
}) {
  const { t, lang } = useI18n();
  const formatter = new Intl.DateTimeFormat(lang, { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Moscow" });
  return <div className="profile-activity">
    <div className="profile-activity__times">
      {[["player.profileUpdated", updatedAt], ["player.lastPlayed", lastPlayedAt]].map(([key, value]) =>
        typeof value === "number" && Number.isFinite(value) && value > 0
          ? <time key={key} dateTime={new Date(value).toISOString()}>{t(String(key), { date: formatter.format(value) })}</time> : null)}
    </div>
    <RefreshButton key={`${mode}:${aid}`} aid={aid} mode={mode} updatedAt={updatedAt} onCheck={onCheck} />
  </div>;
}
