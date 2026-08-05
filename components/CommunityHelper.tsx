"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import { tarkovDevMode } from "@/types/seasonal";
import CommunityBanReview from "@/components/CommunityBanReview";
import type { ScanTaskRecord } from "@/types/seasonal";

interface HelperStatus {
  polling: boolean;
  pollingUntil: number;
  tasks: ScanTaskRecord[];
}

const JSON_HEADERS = { "Content-Type": "application/json" };

export default function CommunityHelper({
  seasonalEnabled,
  reviewEnabled,
  defaultExpanded = false,
}: {
  seasonalEnabled: boolean;
  reviewEnabled: boolean;
  defaultExpanded?: boolean;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [limit, setLimit] = useState(3);
  const [status, setStatus] = useState<HelperStatus | null>(null);
  const [starting, setStarting] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const pollingRef = useRef(false);

  const loadStatus = useCallback(async () => {
    const response = await fetch("/api/seasonal/helper/status", { cache: "no-store" });
    if (!response.ok) return null;
    const next = (await response.json()) as HelperStatus;
    setStatus(next);
    return next;
  }, []);

  async function start() {
    setStarting(true);
    setError("");
    try {
      const session = await fetch("/api/seasonal/helper/session", { method: "POST" });
      if (!session.ok) throw new Error();
      const claim = await fetch(`/api/seasonal/helper/claim?limit=${limit}`, { method: "POST" });
      if (!claim.ok) throw new Error();
      const body = (await claim.json()) as { tasks: ScanTaskRecord[]; pollingUntil: number };
      setStatus({ polling: true, pollingUntil: body.pollingUntil, tasks: body.tasks });
    } catch {
      setError(t("helper.startFailed"));
    } finally {
      setStarting(false);
    }
  }

  const verifyAll = useCallback(async () => {
    if (pollingRef.current) return;
    pollingRef.current = true;
    setChecking(true);
    try {
      const current = status?.tasks ?? [];
      await Promise.all(current.map((task) => fetch("/api/seasonal/helper/verify", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ taskId: task.id }),
      }).catch(() => null)));
      await loadStatus();
    } finally {
      pollingRef.current = false;
      setChecking(false);
    }
  }, [loadStatus, status?.tasks]);

  useEffect(() => {
    if (!status?.polling || status.tasks.length === 0) return;
    const remaining = status.pollingUntil - Date.now();
    if (remaining <= 0) return;
    const interval = window.setInterval(() => void verifyAll(), 5_000);
    const timeout = window.setTimeout(() => {
      setStatus((current) => current ? { ...current, polling: false } : current);
    }, remaining);
    return () => {
      window.clearInterval(interval);
      window.clearTimeout(timeout);
    };
  }, [status?.polling, status?.pollingUntil, status?.tasks.length, verifyAll]);

  async function skip(taskId: number) {
    setError("");
    const response = await fetch("/api/seasonal/helper/skip", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ taskId }),
    });
    if (!response.ok) setError(t("helper.skipFailed"));
    await loadStatus();
  }

  return (
    <section className="community-helper data-panel">
      <button type="button" className="community-helper__toggle" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
        <span>
          <span className="section-kicker">{t("helper.kicker")}</span>
          <strong>{t(seasonalEnabled && !reviewEnabled ? "helper.title" : "review.helperTitle")}</strong>
        </span>
        <span aria-hidden="true">{expanded ? "−" : "+"}</span>
      </button>
      {expanded && (
        <div className="community-helper__body">
          {seasonalEnabled && <>
          <p>{t("helper.description")}</p>
          {!status && (
            <>
              <div className="community-helper__limit" role="group" aria-label={t("helper.taskCount")}>
                {[1, 2, 3].map((value) => (
                  <button type="button" key={value} aria-pressed={limit === value} className={limit === value ? "is-active" : ""} onClick={() => setLimit(value)}>{value}</button>
                ))}
              </div>
              <button type="button" className="tactical-button" onClick={() => void start()} disabled={starting}>
                {starting ? t("common.loading") : t("helper.start")}
              </button>
            </>
          )}
          {status && status.tasks.length === 0 && <p className="community-helper__done">{t("helper.done")}</p>}
          {status && status.tasks.length > 0 && (
            <>
              <p className="text-xs text-[var(--muted)]">
                {status.polling
                  ? t("helper.polling", { n: status.tasks.length })
                  : t("helper.pollingStopped")}
              </p>
              <ul className="community-helper__tasks">
                {status.tasks.map((task) => (
                  <li key={task.id}>
                    <div>
                      <strong>#{task.aid}</strong>
                      <span>{t("helper.kind." + (task.kind === "linked_pvp" ? "linkedPvp" : "profile"))}</span>
                    </div>
                    <div className="community-helper__actions">
                      <a
                        href={`https://tarkov.dev/players/${tarkovDevMode(task.kind === "linked_pvp" ? "regular" : "seasonal")}/${task.aid}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="ghost-button"
                      >
                        {t("helper.openProfile")}
                      </a>
                      <button type="button" className="ghost-button" onClick={() => void verifyAll()} disabled={checking}>
                        {checking ? t("common.loading") : t("helper.retry")}
                      </button>
                      <button type="button" className="community-helper__skip" onClick={() => void skip(task.id)}>{t("helper.skip")}</button>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
          {error && <p className="text-sm text-[var(--danger)]" role="alert">{error}</p>}
          <p className="community-helper__privacy">{t("helper.privacy")}</p>
          </>}
          {reviewEnabled && <CommunityBanReview />}
        </div>
      )}
    </section>
  );
}
