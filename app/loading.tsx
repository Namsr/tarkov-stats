"use client";

import { useI18n } from "@/lib/i18n/context";

/** Keep the shared header interactive while any page waits for its server. */
export default function Loading() {
  const { t } = useI18n();

  return (
    <main className="page-frame" role="status" aria-busy="true">
      <span className="sr-only">{t("common.loading")}</span>
      <div aria-hidden="true">
        <div className="h-5 w-20 skeleton rounded" />
        <div className="mt-8 h-12 w-full max-w-72 skeleton rounded" />
        <div className="detail-grid mt-7">
          {Array.from({ length: 4 }, (_, index) => (
            <div key={index} className="h-28 skeleton rounded-xl" />
          ))}
        </div>
      </div>
    </main>
  );
}
