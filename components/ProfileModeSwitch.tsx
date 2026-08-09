"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useI18n } from "@/lib/i18n/context";
import { handleActiveLinkClick } from "@/lib/active-link";
import { appRouteMode, GAME_MODES, type GameMode } from "@/types/seasonal";

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
  const searchParams = useSearchParams();
  const [currentHash, setCurrentHash] = useState("");

  useEffect(() => {
    const syncHash = () => setCurrentHash(window.location.hash);
    syncHash();
    window.addEventListener("hashchange", syncHash);
    return () => window.removeEventListener("hashchange", syncHash);
  }, []);

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
        const isProfileModeSwitch = page === "player" &&
          (current === "regular" || current === "seasonal") &&
          (mode === "regular" || mode === "seasonal");
        const canNavigateImmediately = page === "average" || isProfileModeSwitch;
        return (
          <Link
            key={mode}
            href={href}
            aria-current={mode === current ? "page" : undefined}
            className="mode-switch__item"
            onClick={(event) => {
              if (canNavigateImmediately && mode !== current && event.button === 0 &&
                !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
                event.preventDefault();
                onBeforeNavigate?.(mode);
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
