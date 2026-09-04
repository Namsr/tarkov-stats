"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import { handleActiveLinkClick } from "@/lib/active-link";
import { warmPlayerProfileResponse } from "@/lib/client-profile-request";
import {
  appRouteMode,
  GAME_MODES,
  seasonalCycleForNavigation,
  type GameMode,
} from "@/types/seasonal";

const PENDING_TIMEOUT_MS = 10_000;
let latestSeasonalCycleId: string | null = null;

export default function ProfileModeSwitch({
  current,
  page,
  aid,
  seasonalCycleId,
  onBeforeNavigate,
}: {
  current: GameMode;
  page: "average" | "player";
  aid?: number;
  seasonalCycleId?: string;
  onBeforeNavigate?: (mode: GameMode) => void;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [currentHash, setCurrentHash] = useState("");
  const [pendingNavigation, setPendingNavigation] = useState<{
    mode: GameMode;
    fromMode: GameMode;
    pathname: string;
  } | null>(null);
  const activeSeasonalCycleId = seasonalCycleForNavigation(current, seasonalCycleId, null, null);
  // Per-instance warm controllers: aborting here never touches another mounted
  // switch (e.g. average header vs player header) and is cleaned up on unmount.
  const warmProfileRef = useRef<AbortController | null>(null);
  const warmTimelineRef = useRef<AbortController | null>(null);

  useEffect(() => () => {
    warmProfileRef.current?.abort();
    warmProfileRef.current = null;
    warmTimelineRef.current?.abort();
    warmTimelineRef.current = null;
  }, []);

  useEffect(() => {
    if (activeSeasonalCycleId) latestSeasonalCycleId = activeSeasonalCycleId;
  }, [activeSeasonalCycleId]);

  useEffect(() => {
    const syncHash = () => setCurrentHash(window.location.hash);
    syncHash();
    window.addEventListener("hashchange", syncHash);
    return () => window.removeEventListener("hashchange", syncHash);
  }, []);

  useEffect(() => {
    if (!pendingNavigation) return;
    const timeout = window.setTimeout(() => setPendingNavigation(null), PENDING_TIMEOUT_MS);
    return () => window.clearTimeout(timeout);
  }, [pendingNavigation]);

  function profileHref(mode: GameMode): string {
    const routeMode = appRouteMode(mode);
    const base = page === "average" ? `/average/${routeMode}` : `/player/${routeMode}/${aid}`;
    if (page !== "player" || (mode !== "regular" && mode !== "seasonal")) return base;

    const params = new URLSearchParams(searchParams.toString());
    if (mode === "seasonal") {
      params.delete("cycle");
      const cycleId = seasonalCycleForNavigation(
        current,
        seasonalCycleId,
        latestSeasonalCycleId,
        searchParams.get("cycle"),
      );
      if (cycleId) params.set("cycle", cycleId);
    } else {
      params.delete("cycle");
    }
    const query = params.toString();
    return `${base}${query ? `?${query}` : ""}${currentHash}`;
  }

  function warmProfile(mode: GameMode): void {
    if (page !== "player" || aid == null) return;
    const params = new URLSearchParams({ aid: String(aid), mode });
    if (mode === "seasonal") {
      const cycleId = seasonalCycleForNavigation(
        current,
        seasonalCycleId,
        latestSeasonalCycleId,
        searchParams.get("cycle"),
      );
      if (!cycleId) return;
      params.set("cycle", cycleId);
    }
    warmProfileRef.current?.abort();
    const controller = new AbortController();
    warmProfileRef.current = controller;
    warmPlayerProfileResponse(`/api/player/profile?${params}`, controller.signal);
  }

  function warmTimeline(mode: GameMode): void {
    if (
      page !== "player" ||
      aid == null ||
      (mode !== "regular" && mode !== "pve" && mode !== "seasonal")
    ) return;
    const params = new URLSearchParams({
      aid: String(aid),
      mode,
      cycle: mode === "seasonal" ? activeSeasonalCycleId ?? "" : "persistent",
    });
    if (mode === "seasonal" && !activeSeasonalCycleId) return;
    warmTimelineRef.current?.abort();
    const controller = new AbortController();
    warmTimelineRef.current = controller;
    void fetch(`/api/progression/timeline?${params}`, { cache: "default", signal: controller.signal }).catch(() => {
      // The destination profile owns the visible progression error state.
    }).finally(() => {
      if (warmTimelineRef.current === controller) warmTimelineRef.current = null;
    });
  }

  return (
    <nav className="mode-switch" aria-label={t("mode.selectorAria")}>
      {GAME_MODES.map((mode) => {
        const href = profileHref(mode);
        const pending = pendingNavigation?.mode === mode &&
          pendingNavigation.fromMode === current &&
          pendingNavigation.pathname === pathname &&
          mode !== current;
        return (
          <Link
            key={mode}
            href={href}
            prefetch
            scroll={false}
            aria-current={mode === current ? "page" : undefined}
            aria-busy={pending || undefined}
            className={`mode-switch__item${pending ? " mode-switch__item--pending" : ""}`}
            onNavigate={() => {
              if (mode !== current) {
                warmProfile(mode);
                warmTimeline(mode);
                setPendingNavigation({ mode, fromMode: current, pathname });
                onBeforeNavigate?.(mode);
                window.dispatchEvent(new Event("profile-mode-navigate"));
              }
            }}
            onClick={(event) => {
              handleActiveLinkClick(event, mode === current, router);
            }}
          >
            {t("fav.mode." + mode)}
          </Link>
        );
      })}
    </nav>
  );
}
