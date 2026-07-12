"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useI18n } from "@/lib/i18n/context";

const LINK = "text-[var(--accent)] hover:underline";

/** Global FAQ control with a safe, non-overlapping dialog on every route. */
export default function FaqWidget() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [openQ, setOpenQ] = useState<number | null>(null);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Answers with links are JSX; plain ones are strings. URLs/handles are constants
  // (not translated) — only the surrounding text comes from the dictionary.
  const items: { q: string; a: ReactNode }[] = [
    {
      q: t("faq.q1"),
      a: (
        <>
          {t("faq.a1.before")}{" "}
          <a className={LINK} href="https://tarkov.dev/players" target="_blank" rel="noopener noreferrer">
            tarkov.dev/players
          </a>{" "}
          {t("faq.a1.after")}
        </>
      ),
    },
    { q: t("faq.q2"), a: t("faq.a2") },
    { q: t("faq.q3"), a: t("faq.a3") },
    {
      q: t("faq.q4"),
      a: (
        <>
          {t("faq.a4.before")}{" "}
          <a className={LINK} href="https://tarkov.dev" target="_blank" rel="noopener noreferrer">
            tarkov.dev
          </a>
          {t("faq.a4.after")}
        </>
      ),
    },
    {
      q: t("faq.q5"),
      a: (
        <>
          {t("faq.a5.before")}{" "}
          <a className={LINK} href="https://github.com/Namsr/tarkov-stats" target="_blank" rel="noopener noreferrer">
            GitHub
          </a>
          {t("faq.a5.after")}
        </>
      ),
    },
    { q: t("faq.q6"), a: t("faq.a6") },
    { q: t("faq.q7"), a: t("faq.a7") },
    {
      q: t("faq.q8"),
      a: (
        <>
          {t("faq.a8.text")}{" "}
          <a className={LINK} href="https://new.donatepay.ru/@namsr" target="_blank" rel="noopener noreferrer">
            DonatePay
          </a>
        </>
      ),
    },
    {
      q: t("faq.q9"),
      a: (
        <>
          {t("faq.a9.text")}{" "}
          <a className={LINK} href="mailto:namsrr@protonmail.com">
            namsrr@protonmail.com
          </a>{" "}
          {t("faq.a9.stream")}{" "}
          <a className={LINK} href="https://www.twitch.tv/namsr__" target="_blank" rel="noopener noreferrer">
            twitch.tv/namsr__
          </a>
          .
        </>
      ),
    },
  ];

  return (
    <>
      {open && (
        <div className="faq-backdrop" onMouseDown={() => setOpen(false)}>
          <div
            role="dialog"
            aria-modal="true"
            aria-label={t("faq.title")}
            className="faq-dialog"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--card-border)]">
              <h2 className="section-heading text-base text-[var(--accent)]">
              {t("faq.title")}
              </h2>
              <button
                onClick={() => setOpen(false)}
                aria-label={t("common.close")}
                className="grid h-10 w-10 place-items-center rounded-full border border-[var(--card-border)] text-xl text-[var(--muted)] hover:border-[var(--accent)] hover:text-[var(--foreground)]"
              >
                ✕
              </button>
            </div>
            <ul className="max-h-[70vh] overflow-y-auto py-1">
              {items.map((item, i) => {
                const on = openQ === i;
                return (
                  <li key={i} className="border-b border-[var(--card-border)]/70 last:border-0">
                    <button
                      onClick={() => setOpenQ(on ? null : i)}
                      aria-expanded={on}
                      className="w-full flex items-start gap-3 text-left px-5 py-4 text-sm text-[var(--muted-strong)] hover:text-[var(--foreground)] transition-colors"
                    >
                      <span className={`text-[var(--accent)] mt-0.5 transition-transform ${on ? "rotate-90" : ""}`}>▸</span>
                      <span className="flex-1">{item.q}</span>
                    </button>
                    {on && (
                      <div className="px-5 pb-4 pl-10 text-sm text-[var(--muted)] leading-relaxed">{item.a}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      )}

      <button
        onClick={() => setOpen((o) => !o)}
        aria-label={t("faq.ariaOpen")}
        aria-expanded={open}
        className="faq-trigger"
      >
        {t("faq.title")}
      </button>
    </>
  );
}
