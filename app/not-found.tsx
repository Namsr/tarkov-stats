"use client";

import Link from "next/link";
import { useI18n } from "@/lib/i18n/context";

export default function NotFound() {
  const { t } = useI18n();
  return (
    <main className="page-frame">
      <p className="page-kicker">404</p>
      <h1 className="page-title">{t("notFound.title")}</h1>
      <p className="mt-5 max-w-2xl text-[var(--muted)]">{t("notFound.description")}</p>
      <Link href="/" className="mt-6 inline-block text-[var(--accent)] hover:underline">
        {t("common.back")}
      </Link>
    </main>
  );
}
