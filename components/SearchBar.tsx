"use client";

import { useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { parsePlayerInput } from "@/lib/player-id";
import {
  filterRecentPlayers,
  getRecentPlayerHref,
  readRecentPlayers,
  removeRecentPlayer,
  type RecentPlayerEntry,
} from "@/lib/recent-players";
import { useI18n } from "@/lib/i18n/context";
import type { PlayerSearchResult } from "@/types/tarkov";
import { appRouteMode } from "@/types/seasonal";

const NICKNAME_RE = /^[a-zA-Z0-9_-]{1,15}$/;

export default function SearchBar({ autoFocus = false }: { autoFocus?: boolean }) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [notFound, setNotFound] = useState(false);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<PlayerSearchResult[]>([]);
  const [recentPlayers, setRecentPlayers] = useState<RecentPlayerEntry[]>([]);
  const [recentOpen, setRecentOpen] = useState(false);
  const skipInitialFocus = useRef(autoFocus);
  const suppressFocusOpen = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const recentListId = useId();
  const router = useRouter();

  function openRecentHistory() {
    setRecentPlayers(readRecentPlayers());
    setRecentOpen(true);
  }

  function closeRecentHistory() {
    setRecentOpen(false);
    if (document.activeElement !== inputRef.current) {
      suppressFocusOpen.current = true;
      inputRef.current?.focus();
    }
  }

  const recentMatches = filterRecentPlayers(recentPlayers, query);
  const showRecent = recentOpen && recentMatches.length > 0;

  async function submit() {
    const clean = query.trim();
    if (!clean) return;

    setRecentOpen(false);

    const player = parsePlayerInput(clean);
    if (player === null) {
      if (!NICKNAME_RE.test(clean)) {
        setError(t("search.error"));
        setNotFound(false);
        setResults([]);
        return;
      }

      setLoading(true);
      setError("");
      setNotFound(false);
      setResults([]);
      try {
        const response = await fetch(`/api/player/search?name=${encodeURIComponent(clean)}`);
        if (response.status === 503) throw new Error(t("search.indexUnavailable"));
        if (!response.ok) throw new Error(t("search.searchFailed"));

        const found = (await response.json()) as PlayerSearchResult[];
        if (found.length === 0) {
          setError(t("search.nickNotFound"));
          setNotFound(true);
          return;
        }

        setResults(found);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : t("search.searchFailed"));
        setNotFound(false);
      } finally {
        setLoading(false);
      }
      return;
    }

    setError("");
    setNotFound(false);
    setResults([]);
    router.push(`/player/${appRouteMode(player.mode)}/${player.aid}`);
  }

  return (
    <div className="search-unit">
      <div className="search-unit__form">
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setError("");
            setNotFound(false);
            setResults([]);
          }}
          onPointerDown={openRecentHistory}
          onFocus={() => {
            if (suppressFocusOpen.current) {
              suppressFocusOpen.current = false;
              return;
            }
            if (skipInitialFocus.current) {
              skipInitialFocus.current = false;
              return;
            }
            openRecentHistory();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") void submit();
            if (event.key === "Escape") closeRecentHistory();
          }}
          placeholder={t("search.placeholder")}
          autoFocus={autoFocus}
          className="search-unit__input"
          role="combobox"
          aria-autocomplete="none"
          aria-haspopup="dialog"
          aria-expanded={showRecent}
          aria-controls={showRecent ? recentListId : undefined}
        />
        <button
          type="button"
          onClick={() => void submit()}
          disabled={loading || !query.trim()}
          className="tactical-button shrink-0"
        >
          {loading ? t("common.loading") : t("search.view")}
        </button>
      </div>

      {error && !notFound && (
        <p className="mt-3 text-center text-sm text-[var(--danger)]">{error}</p>
      )}

      {notFound && (
        <p className="search-unit__not-found">
          {error} {t("search.nickNotFoundBefore")}{" "}
          <a href="https://tarkov.dev/players" target="_blank" rel="noopener noreferrer">
            tarkov.dev/players
          </a>{" "}
          {t("search.nickNotFoundAfter")}
        </p>
      )}

      {showRecent && (
        <div
          id={recentListId}
          className="search-unit__results"
          role="dialog"
          aria-label={t("search.recentlyViewed")}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              closeRecentHistory();
            }
          }}
        >
          <p className="px-2 pb-2 text-xs uppercase tracking-wider text-[var(--muted)]">
            {t("search.recentlyViewed")}
          </p>
          <div className="space-y-1">
            {recentMatches.map((entry) => (
              <div
                key={`${entry.aid}`}
                className="flex items-center rounded-lg hover:bg-[var(--input-bg)]"
              >
                <button
                  type="button"
                  onClick={() => {
                    setRecentOpen(false);
                    router.push(getRecentPlayerHref(entry));
                  }}
                  className="flex min-w-0 flex-1 items-center justify-between rounded-lg px-3 py-3 text-left text-sm hover:text-[var(--accent)]"
                >
                  <span className="truncate">{entry.nickname}</span>
                </button>
                <button
                  type="button"
                  aria-label={t("search.removeRecent", { nickname: entry.nickname })}
                  title={t("search.removeRecent", { nickname: entry.nickname })}
                  onClick={(event) => {
                    event.stopPropagation();
                    removeRecentPlayer(entry.aid);
                    setRecentPlayers((current) =>
                      current.filter((item) => item.aid !== entry.aid)
                    );
                  }}
                  className="mr-2 rounded-md px-2 py-1 text-lg leading-none text-[var(--muted)] hover:bg-[var(--card-border)] hover:text-[var(--foreground)]"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {results.length > 0 && (
        <div className="search-unit__results">
          <p className="px-2 pb-2 text-xs uppercase tracking-wider text-[var(--muted)]">
            {t("search.resultsHeading")}
          </p>
          <div className="space-y-1">
            {results.map((player) => (
              <button
                key={player.aid}
                type="button"
                onClick={() => router.push(`/player/regular/${player.aid}`)}
                className="flex w-full items-center justify-between rounded-lg px-3 py-3 text-left text-sm hover:bg-[var(--input-bg)] hover:text-[var(--accent)]"
              >
                <span>{player.name}</span>
                <span className="text-xs text-gray-500">#{player.aid}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <p className="search-unit__help">
        {t("search.helpBefore")}{" "}
        <a
          href="https://tarkov.dev/players"
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-[var(--accent)]"
        >
          tarkov.dev/players
        </a>{" "}
        {t("search.helpAfter")}
      </p>
    </div>
  );
}
