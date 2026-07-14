"use client";

import Link from "next/link";
import { useI18n } from "@/lib/i18n/context";

export default function ModeUnavailable({ seasonal = false }: { seasonal?: boolean }) {
  const { t } = useI18n();
  return (
    <main className="page-frame">
      <p className="page-kicker">{t("seasonal.unavailableKicker")}</p>
      <h1 className="page-title">{t(seasonal ? "seasonal.unavailable" : "mode.unavailable")}</h1>
      <p className="mt-5 max-w-2xl text-[var(--muted)]">
        {t(seasonal ? "seasonal.unavailableDescription" : "mode.unavailableDescription")}
      </p>
      <Link href="/" className="mt-6 inline-block text-[var(--accent)] hover:underline">{t("common.back")}</Link>
    </main>
  );
}
