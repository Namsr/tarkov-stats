"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import { homeCountAt, type HomeCounterWindow } from "@/lib/home-counter";
import type { PublicIndexCoverage } from "@/lib/public-index-coverage";

type Coverage = PublicIndexCoverage & { counter: HomeCounterWindow | null; banned: number | null };

// Rounded measured profile-update throughput across all four modes; not live.
const DAILY_SCAN_FIGURE = 2_500;

export default function HomeScanRail() {
  const { t, lang } = useI18n();
  const [coverage, setCoverage] = useState<Coverage | null>(null);
  const [now, setNow] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let loading = false;
    async function refresh() {
      if (loading || document.hidden) return;
      loading = true;
      try {
        const response = await fetch("/api/home/coverage", { signal: controller.signal });
        if (response.ok) {
          const body = await response.json() as Coverage;
          if (!controller.signal.aborted) setCoverage(body);
        }
      } catch { /* Keep the last confirmed values on a transient failure. */ }
      finally { loading = false; }
    }
    const tick = () => { if (!document.hidden) setNow(Date.now()); };
    const onVisible = () => { tick(); void refresh(); };
    tick();
    void refresh();
    const clock = window.setInterval(tick, 1_000);
    const poll = window.setInterval(() => { void refresh(); }, 60_000);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      controller.abort();
      window.clearInterval(clock);
      window.clearInterval(poll);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  const total = coverage?.counter ? homeCountAt(coverage.counter, now) : coverage?.total ?? null;
  const banned = coverage?.banned ?? null;
  return <p className="home-scan-rail">
    <span className="home-scan-rail__item">
      <span className="home-scan-rail__note">{t("home.scanAbout")}</span>
      <strong className="home-scan-rail__value">{DAILY_SCAN_FIGURE.toLocaleString(lang)}</strong>
      <span className="home-scan-rail__caption">{t("home.scanPerDay")}</span>
    </span>
    {total !== null && <span className="home-scan-rail__item" title={t("home.scanTotalHint")}>
      <strong className="home-scan-rail__value">{total.toLocaleString(lang)}</strong>
      <span className="home-scan-rail__caption">{t("home.scanTotal")}</span>
    </span>}
    {banned !== null && <span className="home-scan-rail__item" title={t("home.scanBannedHint")}>
      <strong className="home-scan-rail__value">{banned.toLocaleString(lang)}</strong>
      <span className="home-scan-rail__caption">{t("home.scanBanned")}</span>
    </span>}
  </p>;
}
