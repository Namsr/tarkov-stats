"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useI18n } from "@/lib/i18n/context";

const LINK = "text-[var(--accent)] hover:underline";

/** Floating "?" help button (bottom-right) that opens an FAQ accordion. */
export default function FaqWidget() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [openQ, setOpenQ] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
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
          {t("faq.a4.text")}{" "}
          <a className={LINK} href="https://new.donatepay.ru/@namsr" target="_blank" rel="noopener noreferrer">
            DonatePay
          </a>
        </>
      ),
    },
    {
      q: t("faq.q5"),
      a: (
        <>
          {t("faq.a5.text")}{" "}
          <a className={LINK} href="mailto:namsrr@protonmail.com">
            namsrr@protonmail.com
          </a>{" "}
          {t("faq.a5.stream")}{" "}
          <a className={LINK} href="https://www.twitch.tv/namsr__" target="_blank" rel="noopener noreferrer">
            twitch.tv/namsr__
          </a>
          .
        </>
      ),
    },
  ];

  return (
    <div ref={ref} className="fixed bottom-4 right-4 z-50">
      {open && (
        <div
          role="dialog"
          aria-label={t("faq.title")}
          className="absolute bottom-full right-0 mb-3 w-80 max-w-[calc(100vw-2rem)] rounded-lg border border-[var(--card-border)] bg-[var(--card-bg)] shadow-xl overflow-hidden"
        >
          <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--card-border)]">
            <h2 className="text-sm font-bold uppercase tracking-wider text-[var(--accent)]">
              {t("faq.title")}
            </h2>
            <button
              onClick={() => setOpen(false)}
              aria-label={t("common.close")}
              className="text-gray-500 hover:text-gray-200 text-lg leading-none"
            >
              ✕
            </button>
          </div>
          <ul className="max-h-[70vh] overflow-y-auto py-1">
            {items.map((item, i) => {
              const on = openQ === i;
              return (
                <li key={i} className="border-b border-[var(--card-border)]/40 last:border-0">
                  <button
                    onClick={() => setOpenQ(on ? null : i)}
                    aria-expanded={on}
                    className="w-full flex items-start gap-2 text-left px-4 py-2.5 text-sm text-gray-200 hover:text-[var(--accent)] transition-colors"
                  >
                    <span className={`text-gray-500 mt-0.5 transition-transform ${on ? "rotate-90" : ""}`}>▸</span>
                    <span className="flex-1">{item.q}</span>
                  </button>
                  {on && (
                    <div className="px-4 pb-3 pl-9 text-sm text-gray-400 leading-relaxed">{item.a}</div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <button
        onClick={() => setOpen((o) => !o)}
        aria-label={t("faq.ariaOpen")}
        aria-expanded={open}
        className="w-11 h-11 rounded-full bg-[var(--accent)] text-[var(--background)] text-xl font-bold shadow-lg hover:bg-[var(--accent-dim)] transition-colors flex items-center justify-center"
      >
        ?
      </button>
    </div>
  );
}
