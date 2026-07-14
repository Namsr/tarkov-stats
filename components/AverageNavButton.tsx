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
  const active = pathname === "/average" || pathname === "/average/regular";

  const base = "tactical-nav-link";
  const className = active
    ? `${base} is-active`
    : base;

  return (
    <Link href={active ? "/" : "/average/regular"} className={className}>
      {t("nav.average")}
    </Link>
  );
}
