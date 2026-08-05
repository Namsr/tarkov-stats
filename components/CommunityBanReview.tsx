"use client";

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import { isGameMode, tarkovDevMode } from "@/types/seasonal";

interface Candidate { aid: number; mode: string; reportCount: number }

export default function CommunityBanReview() {
  const { t } = useI18n();
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [voting, setVoting] = useState<number | null>(null);
  const [error, setError] = useState("");

  const claim = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/community/ban-reviews/claim", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ limit: 3 }),
      });
      if (!response.ok) throw new Error();
      const body = await response.json() as { candidates?: Candidate[] };
      setCandidates(body.candidates ?? []);
    } catch {
      setError(t("review.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => { void claim(); }, [claim]);

  async function vote(aid: number, verdict: "yes" | "no") {
    setVoting(aid);
    setError("");
    try {
      const response = await fetch("/api/community/ban-reviews/vote", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ aid, verdict }),
      });
      if (!response.ok) throw new Error();
      const body = await response.json() as { candidates?: Candidate[] };
      setCandidates(body.candidates ?? []);
    } catch {
      setError(t("review.voteFailed"));
    } finally {
      setVoting(null);
    }
  }

  return (
    <section className="mt-6 border-t border-[var(--card-border)] pt-5">
      <span className="section-kicker">{t("review.kicker")}</span>
      <h2 className="text-lg font-semibold">{t("review.title")}</h2>
      <p className="mt-1 text-sm text-[var(--muted)]">{t("review.description")}</p>
      {loading && <p className="mt-3 text-sm text-[var(--muted)]">{t("common.loading")}</p>}
      {!loading && candidates.length === 0 && <p className="mt-3 text-sm text-[var(--muted)]">{t("review.empty")}</p>}
      {candidates.length > 0 && <ul className="community-helper__tasks mt-3">
        {candidates.map((candidate) => (
          <li key={candidate.aid}>
            <div><strong>#{candidate.aid}</strong><span>{t("review.reports", { n: candidate.reportCount })}</span></div>
            <div className="community-helper__actions">
              <a href={`https://tarkov.dev/players/${tarkovDevMode(isGameMode(candidate.mode) ? candidate.mode : "regular")}/${candidate.aid}`} target="_blank" rel="noopener noreferrer" className="ghost-button">{t("review.openProfile")}</a>
              <button type="button" className="ghost-button" disabled={voting !== null} onClick={() => void vote(candidate.aid, "yes")}>{t("review.yes")}</button>
              <button type="button" className="community-helper__skip" disabled={voting !== null} onClick={() => void vote(candidate.aid, "no")}>{t("review.no")}</button>
            </div>
          </li>
        ))}
      </ul>}
      {error && <p className="mt-2 text-sm text-[var(--danger)]" role="alert">{error}</p>}
    </section>
  );
}
