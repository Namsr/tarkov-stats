"use client";

import { useState } from "react";
import Link from "next/link";
import { useI18n } from "@/lib/i18n/context";
import { useFavorites } from "@/lib/favorites/context";
import RefreshButton from "@/components/RefreshButton";
import type { Favorite, FavoriteIdentity } from "@/lib/db";
import { favoriteHref, favoriteKey } from "@/lib/favorites/identity";
import type { ArenaCardStats } from "@/components/arena-ui";
import { arenaMetricValue, formatArenaMetric, parsedStats, toArenaProfile } from "@/components/arena-ui";

interface Props {
  statsByFavorite: Map<string, ArenaCardStats>;
  /** True until the first /favorites/stats load resolves. */
  statsLoading: boolean;
}

export default function FavoritesList({ statsByFavorite, statsLoading }: Props) {
  const { t } = useI18n();
  const { favorites, remove, setNote, setMain } = useFavorites();

  return (
    <section className="space-y-3">
      <h2 className="section-heading">{t("profile.listHeading")}</h2>
      <ul className="space-y-3">
        {favorites.map((fav) => (
          <FavoriteRow
            key={favoriteKey(fav)}
            fav={fav}
            stats={statsByFavorite.get(favoriteKey(fav)) ?? null}
            statsLoading={statsLoading}
            onRemove={remove}
            onSetNote={setNote}
            onSetMain={setMain}
          />
        ))}
      </ul>
    </section>
  );
}

function FavoriteRow({
  fav,
  stats,
  statsLoading,
  onRemove,
  onSetNote,
  onSetMain,
}: {
  fav: Favorite;
  stats: ArenaCardStats;
  statsLoading: boolean;
  onRemove: (aid: number, identity?: FavoriteIdentity) => void;
  onSetNote: (aid: number, note: string | null, identity?: FavoriteIdentity) => void;
  onSetMain: (aid: number, identity?: FavoriteIdentity) => void;
}) {
  const { t } = useI18n();
  const [note, setNoteLocal] = useState(fav.note ?? "");
  const identity = { mode: fav.mode, cycleId: fav.cycleId };
  const modeLabel = fav.mode === "regular"
    ? t("fav.mode.regular")
    : fav.mode === "pve"
      ? t("fav.mode.pve")
      : fav.mode === "arena"
        ? t("fav.mode.arena")
        : t("fav.mode.seasonal");

  function saveNote() {
    const next = note.trim();
    if (next === (fav.note ?? "")) return; // unchanged
    onSetNote(fav.aid, next || null, identity);
  }

  const legacy = parsedStats(stats);
  const arena = fav.mode === "arena" ? toArenaProfile(stats, fav.aid) : null;
  const arenaIsLegacy = arena?.parserVersion === 0;
  const arenaKdRatio = arena ? arenaMetricValue(arena.overall, "kd_ratio") : null;
  const arenaKdLabel = arenaIsLegacy && (arenaKdRatio == null || arenaKdRatio <= 0)
    ? t("common.notAvailable")
    : formatArenaMetric(arenaKdRatio, "kd_ratio");
  const quick = arena
    ? `${arenaIsLegacy ? `${t("arena.profile.legacyIncomplete")} · ` : ""}${t("arena.metric.kd_ratio")} ${arenaKdLabel} · ${arena.overall.counters.matches == null ? t("common.notAvailable") : arena.overall.counters.matches.toLocaleString()} ${t("arena.counter.matches")} · ${arena.overall.hours == null ? t("common.notAvailable") : Math.round(arena.overall.hours).toLocaleString()} ${t("unit.h")}`
    : fav.mode === "arena"
      ? statsLoading
        ? t("common.loading")
        : t("profile.statsUnavailable")
      : legacy
      ? `${t("compare.kdRatio")} ${legacy.kdRatio.toFixed(2)} · ${Math.round(legacy.hoursPlayed).toLocaleString()} ${t("unit.h")} · ${legacy.survivalRate}%`
      : statsLoading
        ? t("common.loading")
        : t("profile.statsUnavailable");

  return (
    <li className="data-panel p-4 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <Link
            href={favoriteHref(fav)}
            className="font-[var(--heading-font)] font-bold tracking-wide text-[var(--foreground)] hover:text-[var(--accent)] truncate"
          >
            {fav.nickname || `#${fav.aid}`}
          </Link>
          {fav.isMain && (
            <span className="text-[10px] uppercase tracking-wider bg-[var(--accent)]/15 text-[var(--accent)] px-2 py-1 rounded-full">
              {t("profile.main")}
            </span>
          )}
        </div>
        <div className="text-xs text-[var(--muted)] mt-1">
          #{fav.aid} · {t("fav.identity", {
            mode: modeLabel,
            cycle: fav.cycleId,
          })} · {quick}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 shrink-0">
        {(fav.mode === "regular" || fav.mode === "arena") && <RefreshButton aid={fav.aid} mode={fav.mode} />}
        <input
          value={note}
          onChange={(e) => setNoteLocal(e.target.value)}
          onBlur={saveNote}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          placeholder={t("profile.notePlaceholder")}
          maxLength={120}
          aria-label={t("profile.note")}
          className="w-40 sm:w-48 min-h-10 px-3 text-xs bg-[var(--input-bg)] border border-[var(--card-border)] rounded-lg focus:outline-none focus:border-[var(--accent)]"
        />
        {!fav.isMain && (
          <button
            onClick={() => onSetMain(fav.aid, identity)}
            title={t("profile.setMain")}
            className="ghost-button !min-h-10 !px-3 !py-2 text-[10px] whitespace-nowrap"
          >
            {t("profile.setMain")}
          </button>
        )}
        <button
          onClick={() => onRemove(fav.aid, identity)}
          title={t("fav.remove")}
          aria-label={t("fav.remove")}
          className="grid h-10 w-10 place-items-center rounded-full border border-[var(--card-border)] text-[var(--muted)] hover:border-[var(--danger)] hover:text-[var(--danger)] text-lg leading-none"
        >
          ✕
        </button>
      </div>
    </li>
  );
}
