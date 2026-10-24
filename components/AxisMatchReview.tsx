"use client";

import { useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import type { AxisMatchReviewView } from "@/lib/axis-match-submission";
import { axisPhotoUrl } from "@/lib/axis-match-photo";
import { AxisPhotoViewer } from "@/components/AxisMatchPhoto";

export function axisReviewNeedsAttention(review: AxisMatchReviewView, roundsMissing: boolean) {
  return review.missingStats.length > 0 || review.nicknameMismatches.length > 0 || review.unreadableNames > 0
    || review.conflicts.length > 0 || review.roundConflict !== null || roundsMissing;
}

export default function AxisMatchReview({ review, roundsMissing }: { review: AxisMatchReviewView; roundsMissing: boolean }) {
  const { t } = useI18n();
  const [viewer, setViewer] = useState<{ src: string; width: number; height: number } | null>(null);
  const conflictNames = [...new Set(review.conflicts.map(conflict => conflict.name))];
  return <section className="axis-match-review" aria-label={t("axis.review.attention")}>
    {review.missingStats.length > 0 && <p>{t("axis.review.missing", { names: review.missingStats.join(", ") })}</p>}
    {roundsMissing && <p>{t("axis.review.roundsMissing")}</p>}
    {review.nicknameMismatches.length > 0 && <p>{t("axis.review.unmatched", { names: review.nicknameMismatches.join(", ") })}</p>}
    {review.unreadableNames > 0 && <p>{t("axis.review.unreadableNames", { n: review.unreadableNames })}</p>}
    {conflictNames.length > 0 && <p>{t("axis.review.conflicts", { names: conflictNames.join(", ") })}</p>}
    {review.conflicts.length > 0 && <ul className="axis-review-conflicts">{review.conflicts.map((conflict, index) => <li key={`${conflict.discordId}:${index}`}>
      <strong>{conflict.name}</strong><span aria-label={t("axis.review.recorded")}>{conflict.existing.kills} / {conflict.existing.deaths} / {conflict.existing.assists}</span>
      <span aria-hidden="true">↔</span><span aria-label={t("axis.review.recognized")}>{conflict.incoming.kills} / {conflict.incoming.deaths} / {conflict.incoming.assists}</span>
    </li>)}</ul>}
    {review.roundConflict && <p>{t("axis.review.roundsConflict")} {review.roundConflict.existing.a} : {review.roundConflict.existing.b} ↔ {review.roundConflict.incoming.a} : {review.roundConflict.incoming.b}</p>}
    {!axisReviewNeedsAttention(review, roundsMissing) && <p>{t("axis.review.complete")}</p>}
    {review.submissions.length > 0 && <details className="axis-review-photos">
      <summary>{t("axis.review.photos", { n: review.submissions.length })}</summary>
      <div className="axis-review-photos__list">{review.submissions.map((submission, index) => {
        const src = axisPhotoUrl(review.matchNumber, submission.photoRevision);
        return <a href={src} target="_blank" rel="noopener noreferrer" className="axis-photo-thumbnail" key={submission.photoRevision}
          aria-label={t("axis.review.openPhoto", { n: review.matchNumber, index: index + 1 })}
          onClick={event => { const image = event.currentTarget.querySelector("img"); if (image?.naturalWidth) { event.preventDefault(); setViewer({ src, width: image.naturalWidth, height: image.naturalHeight }); } }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={src} loading="lazy" alt={t("axis.photo.alt", { n: review.matchNumber })} />
        </a>;
      })}</div>
    </details>}
    {viewer && <AxisPhotoViewer image={viewer} matchNumber={review.matchNumber} onClose={() => setViewer(null)} />}
  </section>;
}
