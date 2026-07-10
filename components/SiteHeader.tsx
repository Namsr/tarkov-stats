"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import AverageNavButton from "@/components/AverageNavButton";
import AuthButton from "@/components/AuthButton";
import LanguageToggle from "@/components/LanguageToggle";
import ThemeToggle from "@/components/ThemeToggle";
import { useI18n } from "@/lib/i18n/context";

export default function SiteHeader() {
  const { t } = useI18n();
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
          <AverageNavButton />
          <AuthButton />
          <ThemeToggle />
          <LanguageToggle />
        </div>
      </div>
    </header>
  );
}
