"use client";

import Link from "next/link";
import { useI18n } from "@/lib/i18n/context";

export default function ModeUnavailable({ seasonal = false }: { seasonal?: boolean }) {
  const { t } = useI18n();
  return (
    <main className="page-frame">
      <h1 className="page-title">{t(seasonal ? "seasonal.unavailable" : "mode.unavailable")}</h1>
      <Link href="/" className="mt-6 inline-block text-[var(--accent)] hover:underline">{t("common.back")}</Link>
    </main>
  );
}
