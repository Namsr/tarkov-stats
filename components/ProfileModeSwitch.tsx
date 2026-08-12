"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import { handleActiveLinkClick } from "@/lib/active-link";
import { appRouteMode, GAME_MODES, type GameMode } from "@/types/seasonal";

const PENDING_TIMEOUT_MS = 10_000;

export default function ProfileModeSwitch({
  current,
  page,
  aid,
  onBeforeNavigate,
}: {
  current: GameMode;
  page: "average" | "player";
  aid?: number;
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
      // The active cycle is validated by the server. Preserve it for a deep
      // link, but never let a regular URL accidentally carry a seasonal cycle.
    } else {
      params.delete("cycle");
    }
    const query = params.toString();
    return `${base}${query ? `?${query}` : ""}${currentHash}`;
  }

  return (
    <nav className="mode-switch" aria-label={t("mode.selectorAria")}>
      {GAME_MODES.map((mode) => {
        const href = profileHref(mode);
        const canNavigateImmediately = page === "average" || page === "player";
        const pending = pendingNavigation?.mode === mode &&
          pendingNavigation.fromMode === current &&
          pendingNavigation.pathname === pathname &&
          mode !== current;
        return (
          <Link
            key={mode}
            href={href}
            aria-current={mode === current ? "page" : undefined}
            aria-busy={pending || undefined}
            className={`mode-switch__item${pending ? " mode-switch__item--pending" : ""}`}
            onClick={(event) => {
              if (canNavigateImmediately && mode !== current && event.button === 0 &&
                !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
                event.preventDefault();
                setPendingNavigation({ mode, fromMode: current, pathname });
                onBeforeNavigate?.(mode);
                window.dispatchEvent(new Event("profile-mode-navigate"));
                const hash = window.location.hash;
                const target = hash && !href.endsWith(hash) ? `${href.split("#")[0]}${hash}` : href;
                router.push(target, { scroll: false });
                return;
              }
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
