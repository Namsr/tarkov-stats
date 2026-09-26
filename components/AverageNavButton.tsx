"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n/context";
import { handleActiveLinkClick } from "@/lib/active-link";

export default function CompareNavButton({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const router = useRouter();
  const { t } = useI18n();
  const active = pathname === "/compare" || pathname === "/compare/";

  const base = "tactical-nav-link";
  const className = active
    ? `${base} is-active`
    : base;

  return (
    <Link
      href="/compare"
      className={className}
      aria-current={active ? "page" : undefined}
      onClick={(event) => {
        onNavigate?.();
        handleActiveLinkClick(event, active, router);
      }}
    >
      {t("nav.compare")}
    </Link>
  );
}
