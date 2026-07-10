"use client";

import { useState } from "react";
import Link from "next/link";
import { useI18n } from "@/lib/i18n/context";
import { useFavorites } from "@/lib/favorites/context";
import RefreshButton from "@/components/RefreshButton";
import type { Favorite } from "@/lib/db";
import type { ParsedPlayerStats } from "@/types/tarkov";

interface Props {
  statsByAid: Map<number, ParsedPlayerStats | null>;
  /** True until the first /favorites/stats load resolves. */
  statsLoading: boolean;
}

export default function FavoritesList({ statsByAid, statsLoading }: Props) {
  const { t } = useI18n();
  const { favorites, remove, setNote, setMain } = useFavorites();

  return (
    <section className="space-y-3">
      <h2 className="section-heading">{t("profile.listHeading")}</h2>
      <ul className="space-y-3">
        {favorites.map((fav) => (
          <FavoriteRow
            key={fav.aid}
            fav={fav}
            stats={statsByAid.get(fav.aid) ?? null}
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
  stats: ParsedPlayerStats | null;
  statsLoading: boolean;
  onRemove: (aid: number) => void;
  onSetNote: (aid: number, note: string | null) => void;
  onSetMain: (aid: number) => void;
}) {
  const { t } = useI18n();
  const [note, setNoteLocal] = useState(fav.note ?? "");

  function saveNote() {
    const next = note.trim();
    if (next === (fav.note ?? "")) return; // unchanged
    onSetNote(fav.aid, next || null);
  }

  const quick = stats
    ? `${t("compare.kdRatio")} ${stats.kdRatio.toFixed(2)} · ${Math.round(stats.hoursPlayed).toLocaleString()} ${t("unit.h")} · ${stats.survivalRate}%`
    : statsLoading
    ? t("common.loading")
    : t("profile.statsUnavailable");

  return (
    <li className="data-panel p-4 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <Link
            href={`/player/${fav.aid}`}
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
          #{fav.aid} · {quick}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 shrink-0">
        <RefreshButton aid={fav.aid} />
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
            onClick={() => onSetMain(fav.aid)}
            title={t("profile.setMain")}
            className="ghost-button !min-h-10 !px-3 !py-2 text-[10px] whitespace-nowrap"
          >
            {t("profile.setMain")}
          </button>
        )}
        <button
          onClick={() => onRemove(fav.aid)}
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
