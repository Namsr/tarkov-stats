"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n/context";
import { handleActiveLinkClick } from "@/lib/active-link";

/** Header link to the canonical Average Player Statistics page. */
export default function AverageNavButton({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const router = useRouter();
  const { t } = useI18n();
  const active = pathname.startsWith("/average");

  const base = "tactical-nav-link";
  const className = active
    ? `${base} is-active`
    : base;

  return (
    <Link
      href="/average/regular"
      className={className}
      aria-current={active ? "page" : undefined}
      onClick={(event) => {
        onNavigate?.();
        handleActiveLinkClick(event, active, router);
      }}
    >
      {t("nav.average")}
    </Link>
  );
}
