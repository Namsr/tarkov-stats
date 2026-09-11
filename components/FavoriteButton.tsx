"use client";

import { useId, useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import { useFavorites } from "@/lib/favorites/context";
import type { FavoriteIdentity } from "@/lib/db";

// Keep in sync with MAX_FAVORITES in lib/db.ts (only used for the message text).
const MAX_FAVORITES = 50;

/** ★ pin/unpin toggle for a game account. Signed-out users see it disabled
 *  with a "sign in required" hint on hover. */
export default function FavoriteButton({
  aid,
  nickname,
  identity,
  iconOnly = false,
}: {
  aid: number;
  nickname?: string | null;
  identity?: FavoriteIdentity;
  iconOnly?: boolean;
}) {
  const { t } = useI18n();
  const { enabled, has, toggle } = useFavorites();
  const [msg, setMsg] = useState("");
  const authHintId = useId();
  const icon = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="m12 3 2.8 5.7 6.3.9-4.6 4.4 1.1 6.3-5.6-3-5.6 3 1.1-6.3L3 9.6l6.2-.9Z" /></svg>;

  if (!enabled) {
    return (
      <div className="profile-action">
        <span
          className="disabled-control-hint"
          tabIndex={0}
          role="group"
          aria-disabled="true"
          aria-label={t("fav.add")}
          aria-describedby={authHintId}
        >
          <button
            type="button"
            disabled
            aria-disabled="true"
            aria-describedby={authHintId}
            aria-label={t("fav.add")}
            className={`ghost-button profile-action__button !text-sm !normal-case !tracking-normal opacity-60 cursor-not-allowed ${iconOnly ? "profile-icon-button profile-favorite-button" : ""}`}
          >
            {iconOnly ? icon : t("fav.add")}
          </button>
          <span id={authHintId} role="tooltip" className="disabled-control-tooltip">
            {t("fav.authRequired")}
          </span>
        </span>
      </div>
    );
  }

  const active = has(aid, identity);

  async function onClick() {
    const result = await toggle(aid, nickname, identity);
    if (result === "limit") {
      setMsg(t("fav.limit", { max: MAX_FAVORITES }));
      setTimeout(() => setMsg(""), 3000);
    }
  }

  return (
    <div className="profile-action">
      <button
        onClick={onClick}
        title={active ? t("fav.inFavorites") : t("fav.add")}
        aria-pressed={active}
        aria-label={active ? t("fav.remove") : t("fav.add")}
          className={`ghost-button profile-action__button !text-sm !normal-case !tracking-normal ${iconOnly ? "profile-icon-button profile-favorite-button" : ""} ${
            active
            ? "!border-[var(--accent)] !text-[var(--accent)] bg-[var(--accent)]/10"
            : ""
        }`}
      >
        {iconOnly ? icon : active ? t("fav.inFavorites") : t("fav.add")}
      </button>
      {msg && (
        <span className="profile-action__status text-[var(--danger)]">
          {msg}
        </span>
      )}
    </div>
  );
}
