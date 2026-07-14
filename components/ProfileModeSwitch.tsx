"use client";

import Link from "next/link";
import { useI18n } from "@/lib/i18n/context";
import { GAME_MODES, type GameMode } from "@/types/seasonal";

export default function ProfileModeSwitch({
  current,
  page,
  aid,
}: {
  current: GameMode;
  page: "average" | "player";
  aid?: number;
}) {
  const { t } = useI18n();

  return (
    <nav className="mode-switch" aria-label={t("mode.selectorAria")}>
      {GAME_MODES.map((mode) => {
        const href = page === "average"
          ? `/average/${mode}`
          : `/player/${mode}/${aid}`;
        return (
          <Link
            key={mode}
            href={href}
            aria-current={mode === current ? "page" : undefined}
            className="mode-switch__item"
          >
            {t("fav.mode." + mode)}
          </Link>
        );
      })}
    </nav>
  );
}
