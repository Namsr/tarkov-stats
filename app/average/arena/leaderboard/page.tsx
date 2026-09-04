"use client";

import Link from "next/link";
import ArenaLeaderboard from "@/components/ArenaLeaderboard";
import { useI18n } from "@/lib/i18n/context";

export default function ArenaLeaderboardPage() {
  const { t } = useI18n();
  return (
    <main className="page-frame">
      <Link
        href="/average/arena"
        className="mb-8 inline-block text-sm text-[var(--muted)] transition-colors hover:text-[var(--foreground)]"
      >
        {t("common.back")}
      </Link>
      <ArenaLeaderboard limit={500} footerLink="compact" />
    </main>
  );
}
