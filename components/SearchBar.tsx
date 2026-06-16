"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { PlayerSearchResult } from "@/types/tarkov";
import { searchPlayerDirect } from "@/lib/player-api-client";
import TurnstileWidget from "./TurnstileWidget";

export default function SearchBar({ autoFocus = false }: { autoFocus?: boolean }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PlayerSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [turnstileToken, setTurnstileToken] = useState("");
  const router = useRouter();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const tokenRef = useRef("");

  useEffect(() => {
    tokenRef.current = turnstileToken;
  }, [turnstileToken]);

  const search = useCallback(async (name: string) => {
    if (name.length < 2) {
      setResults([]);
      setOpen(false);
      setError("");
      return;
    }
    if (!tokenRef.current) {
      setError("Completing verification...");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const data = await searchPlayerDirect(name, tokenRef.current);
      setResults(data);
      setOpen(data.length > 0);
      if (data.length === 0) setError("No players found");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed");
      setResults([]);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (query.length >= 2) {
      debounceRef.current = setTimeout(() => search(query), 400);
    } else {
      setResults([]);
      setOpen(false);
      setError("");
    }
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, search]);

  // Re-trigger search when token arrives and there's a pending query
  useEffect(() => {
    if (turnstileToken && query.length >= 2 && results.length === 0 && !loading) {
      search(query);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turnstileToken]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  function handleSelect(player: PlayerSearchResult) {
    setOpen(false);
    setQuery(player.name);
    router.push(`/player/${player.aid}`);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") {
      if (results.length === 1) {
        handleSelect(results[0]);
      } else if (query.length >= 2) {
        search(query);
      }
    }
  }

  return (
    <div ref={wrapperRef} className="relative w-full max-w-lg">
      {!turnstileToken && (
        <div className="mb-4">
          <TurnstileWidget onToken={setTurnstileToken} />
        </div>
      )}

      <div className="relative">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => results.length > 0 && setOpen(true)}
          placeholder={turnstileToken ? "Enter player nickname..." : "Complete verification above to search..."}
          autoFocus={autoFocus && !!turnstileToken}
          disabled={!turnstileToken}
          className={`w-full px-4 py-3 bg-[var(--input-bg)] border border-[var(--card-border)] rounded-lg text-[var(--foreground)] placeholder:text-gray-500 focus:outline-none focus:border-[var(--accent)] transition-colors ${!turnstileToken ? "opacity-50 cursor-not-allowed" : ""}`}
        />
        {loading && (
          <div className="absolute right-3 top-1/2 -translate-y-1/2">
            <div className="w-5 h-5 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
          </div>
        )}
      </div>

      {error && !loading && (
        <p className="mt-2 text-sm text-[var(--danger)]">{error}</p>
      )}

      {open && results.length > 0 && (
        <ul className="absolute z-50 mt-1 w-full bg-[var(--card-bg)] border border-[var(--card-border)] rounded-lg shadow-xl max-h-60 overflow-y-auto">
          {results.map((player) => (
            <li key={player.aid}>
              <button
                onClick={() => handleSelect(player)}
                className="w-full px-4 py-3 text-left hover:bg-[var(--accent)]/10 transition-colors flex justify-between items-center"
              >
                <span className="text-[var(--foreground)]">{player.name}</span>
                <span className="text-xs text-gray-500">#{player.aid}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
