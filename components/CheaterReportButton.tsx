"use client";

import { useEffect, useId, useState } from "react";
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
  const authHintId = useId();

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
  const button = (
    <button
      type="button"
      onClick={() => void submit()}
      disabled={disabled}
      aria-disabled={disabled}
      aria-describedby={signedOut ? authHintId : undefined}
      title={signedOut ? undefined : label}
      className="ghost-button profile-action__button !text-sm !normal-case !tracking-normal disabled:cursor-not-allowed disabled:opacity-60"
    >
      <span>{submitting ? t("common.loading") : label}</span>{" "}
      <span className="report-count">({count})</span>
    </button>
  );

  return (
    <div className="profile-action">
      {signedOut ? (
        <span
          className="disabled-control-hint"
          tabIndex={0}
          role="group"
          aria-disabled="true"
          aria-label={label}
          aria-describedby={authHintId}
        >
          {button}
          <span id={authHintId} role="tooltip" className="disabled-control-tooltip">
            {t("report.authRequired")}
          </span>
        </span>
      ) : button}
      <span className="sr-only">{t("report.count", { n: count })}</span>
      {error && <span className="profile-action__status text-[var(--danger)]" role="alert">{error}</span>}
    </div>
  );
}
