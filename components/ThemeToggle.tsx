"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n/context";

type Theme = "dark" | "light";

const STORAGE_KEY = "tarkov-stats-theme";

function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
}

function initialTheme(): Theme {
  if (typeof window === "undefined") return "dark";
  const saved = window.localStorage.getItem(STORAGE_KEY);
  return saved === "light" || saved === "dark" ? saved : "dark";
}

/** Persists a user-selected reading mode; dark is the deliberate default. */
export default function ThemeToggle() {
  const { t } = useI18n();
  const [theme, setTheme] = useState<Theme>("dark");

  useEffect(() => {
    const savedTheme = initialTheme();
    setTheme(savedTheme);
    applyTheme(savedTheme);
  }, []);

  function toggle() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    window.localStorage.setItem(STORAGE_KEY, next);
    applyTheme(next);
  }

  const nextLabel = theme === "dark" ? t("theme.toLight") : t("theme.toDark");

  return (
    <button
      type="button"
      onClick={toggle}
      className="theme-toggle"
      aria-label={nextLabel}
      title={nextLabel}
    >
      <svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {theme === "dark" ? <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" /></> : <path d="M20.8 13.1A9 9 0 0 1 10.9 3.2a9 9 0 1 0 9.9 9.9Z" />}
      </svg>
    </button>
  );
}
