"use client";

import { useI18n } from "@/lib/i18n/context";
import type { AxisMatchReviewView } from "@/lib/axis-match-submission";

export function axisReviewNeedsAttention(review: AxisMatchReviewView) {
  return review.nicknameMismatches.length > 0 || review.unreadableNames > 0;
}

export default function AxisMatchReview({ review }: { review: AxisMatchReviewView }) {
  const { t } = useI18n();
  if (!axisReviewNeedsAttention(review)) return null;
  return <div className="axis-match-review" role="status">
    {review.nicknameMismatches.length > 0 && <p>{t("axis.review.unmatched", { names: review.nicknameMismatches.join(", ") })}</p>}
    {review.unreadableNames > 0 && <p>{t("axis.review.unreadableNames", { n: review.unreadableNames })}</p>}
  </div>;
}
