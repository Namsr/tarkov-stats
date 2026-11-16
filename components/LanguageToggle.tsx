"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useI18n } from "@/lib/i18n/context";

/** Segmented EN | RU language switch for the header (top-right). */
export default function LanguageToggle() {
  const { lang, t } = useI18n();
  const pathname = usePathname();
  const query = useSearchParams().toString();
  const returnTo = pathname + (query ? "?" + query : "");

  return (
    <div
      role="group"
      aria-label={t("nav.language")}
      className="flex min-h-11 items-center overflow-hidden rounded-full border border-[var(--card-border)] text-xs"
    >
      {(["en", "ru"] as const).map((l) => {
        const active = l === lang;
        const endpoint = `/api/language?lang=${l}`;
        return (
          <a
            key={l}
            href={endpoint + "&returnTo=" + encodeURIComponent(returnTo)}
            hrefLang={l}
            onClick={(event) => {
              const { pathname, search, hash } = window.location;
              event.currentTarget.href = endpoint + "&returnTo=" + encodeURIComponent(pathname + search + hash);
            }}
            aria-current={active || undefined}
            className={`inline-flex h-11 min-w-11 items-center justify-center px-2 font-semibold uppercase transition-colors focus-visible:-outline-offset-2 ${
              active
                ? "bg-[var(--accent)] text-[var(--background)]"
                : "text-[var(--muted)] hover:text-[var(--foreground)]"
            }`}
          >
            {l}
          </a>
        );
      })}
    </div>
  );
}
