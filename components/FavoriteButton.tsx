"use client";

import { useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import { useFavorites } from "@/lib/favorites/context";

// Keep in sync with MAX_FAVORITES in lib/db.ts (only used for the message text).
const MAX_FAVORITES = 50;

/** ★ pin/unpin toggle for a game account. Signed-out users see it disabled
 *  with a "sign in required" hint on hover. */
export default function FavoriteButton({
  aid,
  nickname,
}: {
  aid: number;
  nickname?: string | null;
}) {
  const { t } = useI18n();
  const { enabled, has, toggle } = useFavorites();
  const [msg, setMsg] = useState("");

  // Signed-out: show the button but disabled, with a hover hint that auth is needed.
  if (!enabled) {
    return (
      <div className="relative shrink-0 group">
        <button
          type="button"
          disabled
          aria-disabled="true"
          title={t("fav.authRequired")}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded border border-[var(--card-border)] text-gray-500 opacity-60 cursor-not-allowed"
        >
          <span aria-hidden>☆</span>
          <span className="hidden sm:inline">{t("fav.add")}</span>
        </button>
        <span className="pointer-events-none absolute right-0 top-full mt-1 z-10 whitespace-nowrap rounded border border-[var(--card-border)] bg-[var(--card-bg)] px-2 py-1 text-xs text-gray-300 opacity-0 group-hover:opacity-100 transition-opacity">
          {t("fav.authRequired")}
        </span>
      </div>
    );
  }

  const active = has(aid);

  async function onClick() {
    const result = await toggle(aid, nickname);
    if (result === "limit") {
      setMsg(t("fav.limit", { max: MAX_FAVORITES }));
      setTimeout(() => setMsg(""), 3000);
    }
  }

  return (
    <div className="relative shrink-0">
      <button
        onClick={onClick}
        title={active ? t("fav.inFavorites") : t("fav.add")}
        aria-pressed={active}
        aria-label={active ? t("fav.remove") : t("fav.add")}
        className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded border transition-colors ${
          active
            ? "border-[var(--accent)] text-[var(--accent)] bg-[var(--accent)]/10"
            : "border-[var(--card-border)] text-gray-400 hover:border-[var(--accent)] hover:text-[var(--accent)]"
        }`}
      >
        <span aria-hidden>{active ? "★" : "☆"}</span>
        <span className="hidden sm:inline">{active ? t("fav.inFavorites") : t("fav.add")}</span>
      </button>
      {msg && (
        <span className="absolute right-0 top-full mt-1 whitespace-nowrap text-xs text-[var(--danger)]">
          {msg}
        </span>
      )}
    </div>
  );
}
