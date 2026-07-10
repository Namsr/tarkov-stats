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
  const [theme, setTheme] = useState<Theme>(initialTheme);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

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
      <span aria-hidden>{theme === "dark" ? "☾" : "☼"}</span>
    </button>
  );
}
