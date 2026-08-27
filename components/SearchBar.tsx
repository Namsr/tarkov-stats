"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import { parsePlayerInput } from "@/lib/player-id";
import {
  filterRecentPlayers,
  getRecentPlayerHref,
  readRecentPlayers,
  removeRecentPlayer,
  type RecentPlayerEntry,
} from "@/lib/recent-players";
import { selectPlayerSearchProfile } from "@/lib/player-search";
import { useI18n } from "@/lib/i18n/context";
import type { PlayerSearchProfileResult, PlayerSearchResult } from "@/types/tarkov";
import { appRouteMode, GAME_MODES, type GameMode } from "@/types/seasonal";
import { warmPlayerProfileResponse } from "@/lib/client-profile-request";

const NICKNAME_RE = /^[a-zA-Z0-9_-]{1,15}$/;
type SearchMode = GameMode | "all";

export default function SearchBar({ autoFocus = false }: { autoFocus?: boolean }) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [notFound, setNotFound] = useState(false);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<PlayerSearchResult[]>([]);
  const [resultsOpen, setResultsOpen] = useState(false);
  const [searchMode, setSearchMode] = useState<SearchMode>("all");
  const [searchedNickname, setSearchedNickname] = useState("");
  const [recentPlayers, setRecentPlayers] = useState<RecentPlayerEntry[]>([]);
  const [recentOpen, setRecentOpen] = useState(false);
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const skipInitialFocus = useRef(autoFocus);
  const searchFormRef = useRef<HTMLDivElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const modeTriggerRef = useRef<HTMLButtonElement>(null);
  const modeOptionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const searchRequestRef = useRef<AbortController | null>(null);
  const suppressNextInputPanelRef = useRef(false);
  const suppressPointerInputPanelRef = useRef(false);
  const resultsOpenFrameRef = useRef<number | null>(null);
  const pendingResultsOpenRef = useRef(false);
  const recentListId = useId();
  const resultListId = useId();
  const modeMenuId = useId();
  const router = useRouter();

  function modeLabel(mode: GameMode): string {
    if (mode === "regular") return t("fav.mode.regular");
    if (mode === "pve") return t("fav.mode.pve");
    if (mode === "arena") return t("fav.mode.arena");
    return t("fav.mode.seasonal");
  }

  function searchModeLabel(mode: SearchMode): string {
    return mode === "all" ? t("search.modeAll") : modeLabel(mode);
  }

  function recentModeLabel(mode: RecentPlayerEntry["mode"]): string {
    return modeLabel(mode === "pvp-season" ? "seasonal" : mode);
  }

  function profileHref(aid: number, profile: PlayerSearchProfileResult): string {
    const base = `/player/${appRouteMode(profile.mode)}/${aid}`;
    return profile.mode === "seasonal"
      ? `${base}?cycle=${encodeURIComponent(profile.cycleId)}`
      : base;
  }

  function openProfile(aid: number, profile: PlayerSearchProfileResult) {
    const params = new URLSearchParams({ aid: String(aid), mode: profile.mode });
    if (profile.mode === "seasonal") params.set("cycle", profile.cycleId);
    warmPlayerProfileResponse(`/api/player/profile?${params}`);
    if (profile.mode === "regular" || profile.mode === "pve") {
      const timeline = new URLSearchParams({
        mode: profile.mode,
        cycle: "persistent",
        aid: String(aid),
      });
      void fetch(`/api/progression/timeline?${timeline}`, { cache: "default" }).catch(() => {});
    }
    router.push(profileHref(aid, profile));
  }

  async function searchNickname(clean: string, mode: SearchMode) {
    searchRequestRef.current?.abort();
    cancelPendingResultsOpen();
    const controller = new AbortController();
    searchRequestRef.current = controller;
    setLoading(true);
    setError("");
    setNotFound(false);
    setResults([]);
    setResultsOpen(false);
    setSearchedNickname(clean);
    try {
      const params = new URLSearchParams({ name: clean, mode });
      const response = await fetch(`/api/player/search?${params}`, { signal: controller.signal });
      if (response.status === 503) throw new Error(t("search.indexUnavailable"));
      if (!response.ok) throw new Error(t("search.searchFailed"));

      const found = (await response.json()) as PlayerSearchResult[];
      if (searchRequestRef.current !== controller) return;
      if (found.length === 0) {
        setError(t("search.nickNotFound"));
        setNotFound(true);
        return;
      }
      setResults(found);
      setResultsOpen(false);
      setRecentOpen(false);
      pendingResultsOpenRef.current = true;
    } catch (caught) {
      if (caught instanceof Error && caught.name === "AbortError") return;
      setError(caught instanceof Error ? caught.message : t("search.searchFailed"));
      setNotFound(false);
    } finally {
      if (searchRequestRef.current === controller) {
        searchRequestRef.current = null;
        setLoading(false);
      }
    }
  }

  function selectSearchMode(mode: SearchMode) {
    setModeMenuOpen(false);
    modeTriggerRef.current?.focus();
    if (mode === searchMode) return;
    setSearchMode(mode);
    if (searchedNickname) void searchNickname(searchedNickname, mode);
  }

  function openInputPanel() {
    cancelPendingResultsOpen();
    setModeMenuOpen(false);
    if (results.length > 0 && searchedNickname === query.trim()) {
      setRecentOpen(false);
      setResultsOpen(true);
      return;
    }
    setRecentPlayers(readRecentPlayers());
    setResultsOpen(false);
    setRecentOpen(true);
  }

  function cancelPendingResultsOpen() {
    pendingResultsOpenRef.current = false;
    if (resultsOpenFrameRef.current !== null) {
      cancelAnimationFrame(resultsOpenFrameRef.current);
      resultsOpenFrameRef.current = null;
    }
  }

  function handleInputPointerDown() {
    suppressPointerInputPanelRef.current = true;
  }

  function handleInputPointerUp() {
    suppressPointerInputPanelRef.current = false;
  }

  function handleInputClick() {
    suppressPointerInputPanelRef.current = false;
    openInputPanel();
  }

  function handleInputPointerCancel() {
    suppressPointerInputPanelRef.current = false;
  }

  function closeSearchPanels() {
    cancelPendingResultsOpen();
    setRecentOpen(false);
    setResultsOpen(false);
    setModeMenuOpen(false);
  }

  function closePanelsAndFocusInput() {
    suppressNextInputPanelRef.current = true;
    closeSearchPanels();
    inputRef.current?.focus();
  }

  function focusModeOption(index: number) {
    requestAnimationFrame(() => modeOptionRefs.current[index]?.focus());
  }

  function handleModeOptionKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const optionCount = GAME_MODES.length + 1;
    if (event.key === "Escape") {
      event.preventDefault();
      setModeMenuOpen(false);
      modeTriggerRef.current?.focus();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    if (event.key === "Home") focusModeOption(0);
    else if (event.key === "End") focusModeOption(optionCount - 1);
    else if (event.key === "ArrowDown") focusModeOption((index + 1) % optionCount);
    else focusModeOption((index - 1 + optionCount) % optionCount);
  }

  useEffect(() => {
    setRecentPlayers(readRecentPlayers());
  }, []);

  useEffect(() => {
    if (!pendingResultsOpenRef.current || results.length === 0 || searchedNickname !== query.trim()) return;

    const frame = requestAnimationFrame(() => {
      resultsOpenFrameRef.current = null;
      if (!pendingResultsOpenRef.current || searchedNickname !== query.trim()) return;
      pendingResultsOpenRef.current = false;
      setResultsOpen(true);
    });
    resultsOpenFrameRef.current = frame;

    return () => {
      cancelAnimationFrame(frame);
      if (resultsOpenFrameRef.current === frame) resultsOpenFrameRef.current = null;
    };
  }, [query, results.length, searchedNickname]);

  useEffect(() => {
    if (!recentOpen && !modeMenuOpen && !resultsOpen && !pendingResultsOpenRef.current) return;

    function isSearchTarget(target: EventTarget | null) {
      return target instanceof Node && (
        searchFormRef.current?.contains(target) || resultsRef.current?.contains(target)
      );
    }

    function closePanels() {
      pendingResultsOpenRef.current = false;
      if (resultsOpenFrameRef.current !== null) {
        cancelAnimationFrame(resultsOpenFrameRef.current);
        resultsOpenFrameRef.current = null;
      }
      setRecentOpen(false);
      setResultsOpen(false);
      setModeMenuOpen(false);
    }

    function closeOutside(event: PointerEvent | FocusEvent) {
      if (!isSearchTarget(event.target)) closePanels();
    }

    function closeOnFocusOut(event: FocusEvent) {
      if (!isSearchTarget(event.relatedTarget)) closePanels();
    }

    document.addEventListener("pointerdown", closeOutside, true);
    document.addEventListener("focusin", closeOutside, true);
    document.addEventListener("focusout", closeOnFocusOut, true);
    window.addEventListener("blur", closePanels);
    return () => {
      document.removeEventListener("pointerdown", closeOutside, true);
      document.removeEventListener("focusin", closeOutside, true);
      document.removeEventListener("focusout", closeOnFocusOut, true);
      window.removeEventListener("blur", closePanels);
    };
  }, [modeMenuOpen, recentOpen, results.length, resultsOpen]);

  const recentMatches = filterRecentPlayers(recentPlayers, query);
  const showResults = resultsOpen && results.length > 0 && searchedNickname === query.trim();
  const showRecent = !showResults && recentOpen && recentMatches.length > 0;

  async function submit() {
    const clean = query.trim();
    if (!clean) return;

    cancelPendingResultsOpen();
    setRecentOpen(false);
    setResultsOpen(false);

    const player = parsePlayerInput(clean);
    if (player === null) {
      if (!NICKNAME_RE.test(clean)) {
        setError(t("search.error"));
        setNotFound(false);
        setResults([]);
        setResultsOpen(false);
        return;
      }

      await searchNickname(clean, searchMode);
      return;
    }

    setError("");
    setNotFound(false);
    setResults([]);
    setResultsOpen(false);
    const selectedMode = /^\d{1,15}$/.test(clean) && searchMode !== "all"
      ? searchMode
      : player.mode;
    const href = `/player/${appRouteMode(selectedMode)}/${player.aid}`;
    // Start the profile request before the route transition. Normal profile
    // responses are browser-cacheable, so the hydrated page can reuse this
    // request instead of opening a second waterfall after navigation.
    if (selectedMode !== "seasonal") {
      const profileParams = new URLSearchParams({ aid: String(player.aid), mode: selectedMode });
      warmPlayerProfileResponse(`/api/player/profile?${profileParams}`);
    }
    if (selectedMode === "regular" || selectedMode === "pve") {
      const timelineParams = new URLSearchParams({ mode: selectedMode, cycle: "persistent", aid: String(player.aid) });
      void fetch(`/api/progression/timeline?${timelineParams}`, { cache: "default" }).catch(() => {
        // The mounted progression panel retries and owns its visible error state.
      });
    }
    router.push(href);
  }

  return (
    <div className="search-unit">
      <div ref={searchFormRef} className="search-unit__form">
        <div className="search-unit__field-wrap">
          <div className="search-unit__field">
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(event) => {
                cancelPendingResultsOpen();
                setQuery(event.target.value);
                setError("");
                setNotFound(false);
                setResults([]);
                setSearchedNickname("");
                searchRequestRef.current?.abort();
              }}
              onPointerDown={handleInputPointerDown}
              onPointerUp={handleInputPointerUp}
              onPointerCancel={handleInputPointerCancel}
              onClick={handleInputClick}
              onFocus={() => {
                if (suppressNextInputPanelRef.current) {
                  suppressNextInputPanelRef.current = false;
                  return;
                }
                if (suppressPointerInputPanelRef.current) return;
                if (skipInitialFocus.current) {
                  skipInitialFocus.current = false;
                  return;
                }
                openInputPanel();
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") void submit();
                if (event.key === "Escape") {
                  closeSearchPanels();
                }
              }}
              placeholder={t("search.placeholder")}
              aria-label={t("search.placeholder")}
              autoFocus={autoFocus}
              className="search-unit__input"
              role="combobox"
              aria-autocomplete="none"
              aria-haspopup="dialog"
              aria-expanded={showRecent || showResults}
              aria-controls={showRecent ? recentListId : showResults ? resultListId : undefined}
            />
            <div className="search-unit__mode-picker">
              <button
                ref={modeTriggerRef}
                type="button"
                className="search-unit__mode-trigger"
                aria-label={t("search.modeFilterAria")}
                aria-haspopup="listbox"
                aria-expanded={modeMenuOpen}
                aria-controls={modeMenuId}
                onClick={() => {
                  setRecentOpen(false);
                  setModeMenuOpen((open) => !open);
                }}
                onKeyDown={(event) => {
                  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
                  event.preventDefault();
                  setRecentOpen(false);
                  setModeMenuOpen(true);
                  focusModeOption(event.key === "ArrowDown" ? 0 : GAME_MODES.length);
                }}
              >
                <span>{searchModeLabel(searchMode)}</span>
                <svg viewBox="0 0 12 8" aria-hidden="true" className="search-unit__mode-chevron">
                  <path d="M1 1.25 6 6.25l5-5" fill="none" stroke="currentColor" strokeWidth="1.5" />
                </svg>
              </button>
              <div
                id={modeMenuId}
                className="search-unit__mode-menu"
                data-open={modeMenuOpen}
                role="listbox"
                aria-label={t("search.modeFilterAria")}
                aria-hidden={!modeMenuOpen}
                inert={!modeMenuOpen}
              >
                {(["all", ...GAME_MODES] as const).map((mode, index) => (
                  <button
                    key={mode}
                    ref={(node) => { modeOptionRefs.current[index] = node; }}
                    type="button"
                    role="option"
                    aria-selected={searchMode === mode}
                    className="search-unit__mode-option"
                    onClick={() => selectSearchMode(mode)}
                    onKeyDown={(event) => handleModeOptionKeyDown(event, index)}
                  >
                    {searchModeLabel(mode)}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {recentMatches.length > 0 && (
            <div
              id={recentListId}
              className="search-unit__history"
              data-open={showRecent}
              role="dialog"
              aria-label={t("search.recentlyViewed")}
              aria-hidden={!showRecent}
              inert={!showRecent}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  closePanelsAndFocusInput();
                }
              }}
            >
              <p className="px-2 pb-2 text-xs uppercase tracking-wider text-[var(--muted)]">
                {t("search.recentlyViewed")}
              </p>
              <div className="search-unit__recent-list space-y-1">
                {recentMatches.map((entry) => (
                  <div key={entry.aid} className="search-unit__recent-row">
                    <button
                      type="button"
                      onClick={() => {
                        setRecentOpen(false);
                        router.push(getRecentPlayerHref(entry));
                      }}
                      className="search-unit__recent-link"
                    >
                      <span className="min-w-0 truncate">{entry.nickname}</span>
                      <span className="search-unit__result-meta">
                        <span className="search-unit__result-mode">{recentModeLabel(entry.mode)}</span>
                        <span className="search-unit__result-id">#{entry.aid}</span>
                      </span>
                    </button>
                    <button
                      type="button"
                      aria-label={t("search.removeRecent", { nickname: entry.nickname })}
                      title={t("search.removeRecent", { nickname: entry.nickname })}
                      onClick={(event) => {
                        event.stopPropagation();
                        removeRecentPlayer(entry.aid);
                        setRecentPlayers((current) => current.filter((item) => item.aid !== entry.aid));
                      }}
                      className="search-unit__recent-remove"
                    >
                      <span aria-hidden="true">×</span>
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
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
        <p className="mt-3 text-center text-sm text-[var(--danger)]" role="status">{error}</p>
      )}

      {notFound && (
        <p className="search-unit__not-found" role="status">
          {error} {t("search.nickNotFoundBefore")}{" "}
          <a href="https://tarkov.dev/players" target="_blank" rel="noopener noreferrer">
            tarkov.dev/players
          </a>{" "}
          {t("search.nickNotFoundAfter")}
        </p>
      )}

      {results.length > 0 && (
        <div
          ref={resultsRef}
          id={resultListId}
          className="search-unit__results"
          data-open={showResults}
          aria-hidden={!showResults}
          inert={!showResults}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            closePanelsAndFocusInput();
          }}
        >
          <div className="search-unit__results-inner">
            <p className="px-2 pb-2 text-xs uppercase tracking-wider text-[var(--muted)]">
              {t("search.resultsHeading")}
            </p>
            <div className="search-unit__results-list space-y-1">
              {results.map((player) => {
                const selectedProfile = selectPlayerSearchProfile(
                  player.aid,
                  player.profiles,
                  searchedNickname,
                  recentPlayers,
                );
                if (!selectedProfile) return null;
                const selectedKey = `${selectedProfile.mode}:${selectedProfile.cycleId}`;
                const openSelectedProfile = () => openProfile(player.aid, selectedProfile);
                return (
                  <div
                    key={player.aid}
                    className="search-unit__result-row"
                  >
                    <button
                      type="button"
                      aria-label={t("search.openProfile", {
                        mode: modeLabel(selectedProfile.mode),
                        nickname: selectedProfile.name,
                      })}
                      className="search-unit__result-hitarea"
                      onClick={openSelectedProfile}
                    />
                    <span className="search-unit__result-name min-w-0 flex-1 truncate">{player.name}</span>
                    <span className="search-unit__result-meta">
                      {player.profiles.map((profile) => {
                        const isSelected = selectedKey === `${profile.mode}:${profile.cycleId}`;
                        const label = t(isSelected ? "search.openModeDefault" : "search.openMode", {
                          mode: modeLabel(profile.mode),
                          nickname: profile.name,
                        });
                        return (
                          <button
                            key={`${profile.mode}:${profile.cycleId}`}
                            type="button"
                            aria-current={isSelected ? "page" : undefined}
                            aria-label={label}
                            title={label}
                            onClick={() => openProfile(player.aid, profile)}
                            className={`search-unit__result-mode${isSelected ? " search-unit__result-mode--selected" : ""}`}
                          >
                            {modeLabel(profile.mode)}
                          </button>
                        );
                      })}
                      <span className="search-unit__result-id">#{player.aid}</span>
                    </span>
                  </div>
                );
              })}
            </div>
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
