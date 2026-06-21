"use client";

import SearchBar from "@/components/SearchBar";
import AuthErrorBanner from "@/components/AuthErrorBanner";
import { useI18n } from "@/lib/i18n/context";

export default function Home() {
  const { t } = useI18n();
  return (
    <main className="flex-1 flex flex-col items-center justify-center px-4">
      <div className="flex flex-col items-center gap-8 max-w-xl w-full">
        <AuthErrorBanner />
        <div className="text-center">
          <div className="text-6xl mb-4">☠</div>
          <h1 className="text-3xl font-bold text-[var(--accent)] tracking-tight">
            TARKOV STATS
          </h1>
          <p className="text-sm text-gray-500 mt-1 uppercase tracking-widest">
            {t("home.subtitle")}
          </p>
        </div>

        <SearchBar autoFocus />

        <p className="text-xs text-gray-600 text-center max-w-sm">
          {t("home.description")}
        </p>
      </div>
    </main>
  );
}
