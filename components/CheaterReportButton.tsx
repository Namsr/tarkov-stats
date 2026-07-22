"use client";

import { useEffect, useState } from "react";
import { useFavorites } from "@/lib/favorites/context";
import { useI18n } from "@/lib/i18n/context";
import type { GameMode } from "@/types/seasonal";

export default function CheaterReportButton({ aid, mode, cycle }: { aid: number; mode: GameMode; cycle: string }) {
  const { t } = useI18n();
  const { authStatus } = useFavorites();
  const [count, setCount] = useState(0);
  const [reported, setReported] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/community-reports?aid=${aid}`, { cache: "no-store" })
      .then(async (response) => ({ response, body: await response.json() as { count?: number; reportedByMe?: boolean } }))
      .then(({ response, body }) => {
        if (!cancelled && response.ok) {
          setCount(Number(body.count ?? 0));
          setReported(body.reportedByMe === true);
        }
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [aid, authStatus]);

  const signedOut = authStatus === "unauthenticated";
  const disabled = signedOut || reported || submitting || authStatus !== "authenticated";

  async function submit() {
    if (disabled) return;
    setSubmitting(true);
    setError("");
    try {
      const response = await fetch("/api/community-reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ aid, mode, cycle }),
      });
      const body = await response.json() as { count?: number };
      if (!response.ok || typeof body.count !== "number") throw new Error();
      setCount(body.count);
      setReported(true);
    } catch {
      setError(t("report.submitFailed"));
    } finally {
      setSubmitting(false);
    }
  }

  const label = reported ? t("report.already") : t("report.action");
  return (
    <div className="relative flex shrink-0 flex-col items-start gap-1 group">
      <button
        type="button"
        onClick={() => void submit()}
        disabled={disabled}
        aria-disabled={disabled}
        title={signedOut ? t("report.authRequired") : label}
        className="ghost-button !min-h-12 whitespace-nowrap !text-sm !normal-case !tracking-normal disabled:cursor-not-allowed disabled:opacity-60"
      >
        {submitting ? t("common.loading") : label}
      </button>
      <p className="text-xs text-[var(--muted)]">{t("report.count", { n: count })}</p>
      {signedOut && <span className="pointer-events-none absolute right-0 top-full z-10 mt-1 whitespace-nowrap rounded border border-[var(--card-border)] bg-[var(--card-bg)] px-2 py-1 text-xs text-gray-300 opacity-0 transition-opacity group-hover:opacity-100">{t("report.authRequired")}</span>}
      {error && <span className="absolute right-0 top-full mt-1 whitespace-nowrap text-xs text-[var(--danger)]" role="alert">{error}</span>}
    </div>
  );
}
