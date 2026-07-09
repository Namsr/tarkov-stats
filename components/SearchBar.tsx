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
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<PlayerSearchResult[]>([]);
  const router = useRouter();

  async function submit() {
    const clean = query.trim();
    const aid = parsePlayerId(clean);
    if (aid === null) {
      if (!NICKNAME_RE.test(clean)) {
        setError(t("search.error"));
        setResults([]);
        return;
      }

      setLoading(true);
      setError("");
      setResults([]);
      try {
        const res = await fetch(`/api/player/search?name=${encodeURIComponent(clean)}`);
        if (res.status === 503) throw new Error(t("search.indexUnavailable"));
        if (!res.ok) throw new Error(t("search.searchFailed"));

        const found = (await res.json()) as PlayerSearchResult[];
        if (found.length === 0) {
          setError(t("search.nickNotFound"));
          return;
        }

        const exact = found.find((p) => p.name.toLowerCase() === clean.toLowerCase());
        if (exact) {
          router.push(`/player/${exact.aid}`);
          return;
        }

        setResults(found);
      } catch (err) {
        setError(err instanceof Error ? err.message : t("search.searchFailed"));
      } finally {
        setLoading(false);
      }
      return;
    }
    setError("");
    setResults([]);
    router.push(`/player/${aid}`);
  }

  return (
    <div className="w-full max-w-lg">
      <div className="flex gap-2">
        <input
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            if (error) setError("");
            if (results.length) setResults([]);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
          }}
          placeholder={t("search.placeholder")}
          autoFocus={autoFocus}
          className="flex-1 px-4 py-3 bg-[var(--input-bg)] border border-[var(--card-border)] rounded-lg text-[var(--foreground)] placeholder:text-gray-500 focus:outline-none focus:border-[var(--accent)] transition-colors"
        />
        <button
          onClick={() => void submit()}
          disabled={loading}
          className="px-5 py-3 bg-[var(--accent)] text-[var(--background)] rounded-lg font-medium hover:bg-[var(--accent-dim)] transition-colors disabled:opacity-50"
        >
          {loading ? t("common.loading") : t("search.view")}
        </button>
      </div>

      {error && <p className="mt-2 text-sm text-[var(--danger)]">{error}</p>}

      {results.length > 0 && (
        <div className="mt-3 rounded-lg border border-[var(--card-border)] bg-[var(--card-bg)] p-2">
          <p className="px-2 pb-2 text-xs uppercase tracking-wider text-gray-500">
            {t("search.resultsHeading")}
          </p>
          <div className="space-y-1">
            {results.map((player) => (
              <button
                key={player.aid}
                type="button"
                onClick={() => router.push(`/player/${player.aid}`)}
                className="flex w-full items-center justify-between rounded px-2 py-2 text-left text-sm hover:bg-[var(--input-bg)] hover:text-[var(--accent)]"
              >
                <span>{player.name}</span>
                <span className="text-xs text-gray-500">#{player.aid}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <p className="mt-3 text-xs text-gray-600">
        {t("search.helpBefore")}{" "}
        <a
          href="https://tarkov.dev/players"
          target="_blank"
          rel="noopener noreferrer"
          className="text-[var(--accent)] hover:underline"
        >
          tarkov.dev/players
        </a>{" "}
        {t("search.helpAfter")}
      </p>
    </div>
  );
}
