"use client";

import type { ReactNode } from "react";
import { useI18n } from "@/lib/i18n/context";

export function ArenaProfileLoading({ children }: { children?: ReactNode } = {}) {
  const { t } = useI18n();
  return (
    <main className="page-frame profile-page min-h-screen" aria-label={t("arena.profile.loading")}>
      {children}
      <div className="surface p-5 sm:p-6">
        <div className="h-3 w-16 skeleton rounded" />
        <div className="mt-4 h-12 w-56 skeleton rounded" />
        <div className="mt-7 grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => <div key={index} className="h-24 skeleton rounded-xl" />)}
        </div>
      </div>
      <div className="mt-5 grid gap-4 xl:grid-cols-2">
        <div className="h-[420px] skeleton rounded-xl" />
        <div className="h-[420px] skeleton rounded-xl" />
      </div>
    </main>
  );
}
