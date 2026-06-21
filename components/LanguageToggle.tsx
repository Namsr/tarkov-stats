"use client";

import { useI18n } from "@/lib/i18n/context";
import { LANGS } from "@/lib/i18n/dictionary";

/** Segmented EN | RU language switch for the header (top-right). */
export default function LanguageToggle() {
  const { lang, setLang } = useI18n();

  return (
    <div
      role="group"
      aria-label="Language"
      className="flex items-center rounded border border-[var(--card-border)] overflow-hidden text-xs"
    >
      {LANGS.map((l) => {
        const active = l === lang;
        return (
          <button
            key={l}
            type="button"
            onClick={() => setLang(l)}
            aria-pressed={active}
            className={`px-2 py-1.5 font-semibold uppercase transition-colors ${
              active
                ? "bg-[var(--accent)] text-[var(--background)]"
                : "text-gray-400 hover:text-[var(--accent)]"
            }`}
          >
            {l}
          </button>
        );
      })}
    </div>
  );
}
