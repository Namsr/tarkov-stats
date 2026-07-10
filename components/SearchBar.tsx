"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { parsePlayerId } from "@/lib/player-id";
import { useI18n } from "@/lib/i18n/context";
import type { PlayerSearchResult } from "@/types/tarkov";

const NICKNAME_RE = /^[a-zA-Z0-9_-]{1,15}$/;

export default function SearchBar({ autoFocus = false }: { autoFocus?: boolean }) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [notFound, setNotFound] = useState(false);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<PlayerSearchResult[]>([]);
  const router = useRouter();

  async function submit() {
    const clean = query.trim();
    if (!clean) return;

    const aid = parsePlayerId(clean);
    if (aid === null) {
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
        if (!response.ok) throw new Error(t("search.searchFailed"));

        const found = (await response.json()) as PlayerSearchResult[];
        if (found.length === 0) {
          setError(t("search.nickNotFound"));
          setNotFound(true);
          return;
        }

        const exact = found.find((player) => player.name.toLowerCase() === clean.toLowerCase());
        if (exact) {
          router.push(`/player/${exact.aid}`);
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
    router.push(`/player/${aid}`);
  }

  return (
    <div className="search-unit">
      <div className="search-unit__form">
        <input
          type="text"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            if (error) setError("");
            if (notFound) setNotFound(false);
            if (results.length) setResults([]);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") void submit();
          }}
          placeholder={t("search.placeholder")}
          autoFocus={autoFocus}
          className="search-unit__input"
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
                onClick={() => router.push(`/player/${player.aid}`)}
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
