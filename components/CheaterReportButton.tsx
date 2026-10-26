"use client";

import { useEffect, useId, useState } from "react";
import { useFavorites, type FavoritesAuthStatus } from "@/lib/favorites/context";
import { useI18n } from "@/lib/i18n/context";
import type { GameMode } from "@/types/seasonal";

type Props = { aid: number; mode: GameMode; cycle: string };

export default function CheaterReportButton(props: Props) {
  const { authStatus } = useFavorites();
  // A pending write belongs to the old profile/session, even if it finishes
  // after navigation. A new key resets state before the next render.
  return <ReportButton key={`${props.aid}:${authStatus}`} {...props} authStatus={authStatus} />;
}

function ReportButton({ aid, mode, cycle, authStatus }: Props & { authStatus: FavoritesAuthStatus }) {
  const { t } = useI18n();
  const [readState, setReadState] = useState<"loading" | "ready" | "error">("loading");
  const [readAttempt, setReadAttempt] = useState(0);
  const [count, setCount] = useState(0);
  const [reported, setReported] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const authHintId = useId();

  useEffect(() => {
    // Only a signed-in visitor can have reported this player, and the effect
    // re-runs on every authStatus transition. Fetching before the status is
    // known sent the request twice per mount and wasted it entirely for a
    // signed-out visitor whose button is disabled anyway.
    if (authStatus !== "authenticated") return;
    let cancelled = false;
    fetch(`/api/community-reports?aid=${aid}`, { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json() as { count?: number; reportedByMe?: boolean };
        if (!response.ok || typeof body.count !== "number" || !Number.isSafeInteger(body.count) || body.count < 0 || typeof body.reportedByMe !== "boolean") throw new Error();
        return { count: body.count, reportedByMe: body.reportedByMe };
      })
      .then((body) => {
        if (!cancelled) {
          setCount(body.count);
          setReported(body.reportedByMe);
          setReadState("ready");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setReadState("error");
          setError("report.loadFailed");
        }
      });
    return () => { cancelled = true; };
  }, [aid, authStatus, readAttempt]);

  const signedOut = authStatus === "unauthenticated";
  const loading = authStatus === "authenticated" && readState === "loading";
  const disabled = loading || submitting || authStatus !== "authenticated";

  async function submit() {
    if (disabled) return;
    if (readState === "error") {
      setError("");
      setReadState("loading");
      setReadAttempt((attempt) => attempt + 1);
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      const response = await fetch("/api/community-reports", {
        method: reported ? "DELETE" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(reported ? { aid } : { aid, mode, cycle }),
      });
      const body = await response.json() as { count?: number };
      if (!response.ok || typeof body.count !== "number" || !Number.isSafeInteger(body.count) || body.count < 0) throw new Error();
      setCount(body.count);
      setReported(!reported);
    } catch {
      setError("report.submitFailed");
    } finally {
      setSubmitting(false);
    }
  }

  const label = readState === "error" ? t("report.retry") : reported ? t("report.remove") : t("report.action");
  const button = (
    <button
      type="button"
      onClick={() => void submit()}
      disabled={disabled}
      aria-disabled={disabled}
      aria-pressed={readState === "ready" ? reported : undefined}
      aria-label={label}
      aria-describedby={signedOut ? authHintId : undefined}
      title={signedOut ? undefined : label}
      className="ghost-button profile-action__button profile-report-button !text-sm !normal-case !tracking-normal disabled:cursor-not-allowed"
    >
      <span>{loading || submitting ? t("common.loading") : readState === "error" ? t("report.retry") : t(reported ? "report.remove" : "profile.reportAction")}</span>{" "}
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
      {error && <span className="profile-action__status text-[var(--danger)]" role="alert">{t(error)}</span>}
    </div>
  );
}
