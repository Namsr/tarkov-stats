"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import AverageNavButton from "@/components/AverageNavButton";
import AuthButton from "@/components/AuthButton";
import LanguageToggle from "@/components/LanguageToggle";
import ThemeToggle from "@/components/ThemeToggle";
import { useI18n } from "@/lib/i18n/context";
import { handleActiveLinkClick } from "@/lib/active-link";
import { usePathname, useRouter } from "next/navigation";

export default function SiteHeader() {
  const { t } = useI18n();
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <header className="site-header">
      <div className="site-header__inner">
        <Link href="/" className="site-mark" onClick={() => setOpen(false)}>
          <span>TARKOV</span>
          <span>STATS</span>
        </Link>

        <button
          type="button"
          className="site-header__menu"
          aria-label={open ? t("nav.closeMenu") : t("nav.menu")}
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <span aria-hidden>{open ? "×" : "≡"}</span>
        </button>

        <div className={`site-header__controls ${open ? "is-open" : ""}`}>
          <nav className="site-header__nav" aria-label={t("nav.primary")}>
            <AverageNavButton onNavigate={() => setOpen(false)} />
            {[
              { href: "/about", label: t("nav.about") },
              { href: "/support", label: t("nav.support"), support: true },
              { href: "/community", label: t("nav.community") },
            ].map((item) => {
              const active = pathname === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={[
                    "tactical-nav-link",
                    active ? "is-active" : "",
                    item.support ? "tactical-nav-link--support" : "",
                  ].filter(Boolean).join(" ")}
                  onClick={(event) => {
                    setOpen(false);
                    handleActiveLinkClick(event, pathname === item.href, router);
                  }}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
          <div className="site-header__utilities">
            <AuthButton />
            <ThemeToggle />
            <LanguageToggle />
          </div>
        </div>
      </div>
    </header>
  );
}
