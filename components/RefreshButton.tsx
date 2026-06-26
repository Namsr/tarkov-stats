"use client";

import { useI18n } from "@/lib/i18n/context";

/** tarkov.dev profile URL (regular mode) for an account id. */
function tarkovDevUrl(aid: number): string {
  return `https://tarkov.dev/players/regular/${aid}`;
}

/**
 * Per-account "Refresh" control. Our site can only read tarkov.dev's public
 * profile cache, which refreshes when the profile is viewed on tarkov.dev itself.
 * So this just opens that profile on tarkov.dev (new tab) — the user refreshes the
 * cache there, then reloading our page (F5) pulls the fresh data (reload bypasses
 * the in-process cache; see isReload + the ?refresh=1 routes).
 */
export default function RefreshButton({
  aid,
  className = "",
}: {
  aid: number;
  className?: string;
}) {
  const { t } = useI18n();
  return (
    <a
      href={tarkovDevUrl(aid)}
      target="_blank"
      rel="noopener noreferrer"
      title={t("player.refreshHint")}
      className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded border border-[var(--card-border)] text-gray-400 hover:border-[var(--accent)] hover:text-[var(--accent)] transition-colors ${className}`}
    >
      <span aria-hidden>⟳</span>
      <span className="hidden sm:inline">{t("player.refresh")}</span>
    </a>
  );
}
