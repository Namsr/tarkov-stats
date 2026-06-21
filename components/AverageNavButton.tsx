"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useI18n } from "@/lib/i18n/context";

/**
 * Header link to the Average Player Statistics page that doubles as a toggle:
 * when you're already on /average it highlights and links back to "/", so a
 * second click leaves the page.
 */
export default function AverageNavButton() {
  const pathname = usePathname();
  const { t } = useI18n();
  const active = pathname === "/average";

  const base = "px-3 py-1.5 text-sm rounded border transition-colors";
  const className = active
    ? `${base} bg-[var(--accent)]/15 border-[var(--accent)] text-[var(--accent)] font-medium`
    : `${base} bg-[var(--input-bg)] border-[var(--card-border)] text-gray-300 hover:text-[var(--accent)] hover:border-[var(--accent)]`;

  return (
    <Link href={active ? "/" : "/average"} className={className}>
      {t("nav.average")}
    </Link>
  );
}
