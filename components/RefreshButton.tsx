"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import { tarkovDevMode, type GameMode } from "@/types/seasonal";
import { isProfileStale, PROFILE_STALE_MS } from "@/lib/profile-refresh-policy";

/** tarkov.dev profile URL (regular mode) for an account id. */
function tarkovDevUrl(aid: number, mode: GameMode): string {
  return `https://tarkov.dev/players/${tarkovDevMode(mode)}/${aid}`;
}

export type RefreshCheckResult = "updated" | "unchanged";

export default function RefreshButton({
  aid,
  mode = "regular",
  stale = false,
  updatedAt,
  missing = false,
  className = "",
  onCheck,
}: {
  aid: number;
  mode?: GameMode;
  stale?: boolean;
  updatedAt?: number | null;
  missing?: boolean;
  className?: string;
  onCheck?: () => Promise<RefreshCheckResult>;
}) {
  const { t } = useI18n();
  const [status, setStatus] = useState<"idle" | "waiting" | "checking" | RefreshCheckResult | "error">("idle");
  const [aged, setAged] = useState(() => isProfileStale(updatedAt));
  const awaitingReturn = useRef(false);
  const checking = useRef(false);
  const isStale = updatedAt === undefined ? stale : aged;
  const prominent = isStale || missing;

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      clearTimeout(timer);
      setAged(isProfileStale(updatedAt));
      if (updatedAt != null && Number.isFinite(updatedAt) && updatedAt > 0) {
        const remaining = updatedAt + PROFILE_STALE_MS - Date.now();
        if (remaining > 0) timer = setTimeout(update, Math.min(remaining, 2_147_483_647));
      }
    };
    update();
    document.addEventListener("visibilitychange", update);
    return () => { clearTimeout(timer); document.removeEventListener("visibilitychange", update); };
  }, [updatedAt]);

  const check = useCallback(async () => {
    if (!onCheck || checking.current) return;
    checking.current = true;
    setStatus("checking");
    try {
      setStatus(await onCheck());
    } catch {
      setStatus("error");
    } finally {
      checking.current = false;
    }
  }, [onCheck]);

  useEffect(() => {
    const handleFocus = () => {
      if (!awaitingReturn.current) return;
      awaitingReturn.current = false;
      void check();
    };
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [check]);

  const statusKey = status === "idle" ? null : `player.refreshStatus.${status}`;

  return (
    <div className="profile-action">
      <a
        href={tarkovDevUrl(aid, mode)}
        target="_blank"
        rel="noopener noreferrer"
        title={t(missing ? "player.refreshMissingHint" : isStale ? "player.refreshStaleHint" : "player.refreshHint")}
        onClick={() => {
          if (!onCheck) return;
          awaitingReturn.current = true;
          setStatus("waiting");
        }}
        className={`ghost-button profile-refresh-button ${prominent ? "is-stale" : ""} profile-action__button !text-sm !normal-case !tracking-normal ${className}`}
      >
        {t(missing ? "player.refreshCache" : "player.refresh")}
      </a>
      {onCheck && statusKey && (
        <p
          className={`text-xs leading-snug ${status === "error" ? "text-[var(--danger)]" : "text-[var(--muted)]"}`}
          aria-live="polite"
        >
          {t(statusKey)}
        </p>
      )}
      {onCheck && status !== "idle" && (
        <button
          type="button"
          onClick={() => void check()}
          disabled={status === "checking"}
          className="min-h-11 text-xs text-[var(--accent)] underline-offset-2 hover:underline disabled:cursor-wait disabled:opacity-60"
        >
          {t("player.refreshCheckAgain")}
        </button>
      )}
    </div>
  );
}
