"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useI18n } from "@/lib/i18n/context";

const LINK = "text-[var(--accent)] hover:underline";
type DialogState = "closed" | "open" | "closing";

/** Global FAQ control with a safe, non-overlapping dialog on every route. */
export default function FaqWidget() {
  const { t } = useI18n();
  const [dialogState, setDialogState] = useState<DialogState>("closed");
  const [openQ, setOpenQ] = useState<number | null>(null);
  const open = dialogState === "open";
  const rootRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const navigatingRef = useRef(false);

  function closeFaq() {
    setDialogState((state) => (state === "open" ? "closing" : state));
  }

  // The answer links soft-navigate and this widget lives in the root layout, so the exit
  // animation can end on the destination page, where focusing the trigger would override
  // the router's own focus handling. A handler of its own rather than an argument on
  // closeFaq, because `onMouseDown={closeFaq}` hands closeFaq a MouseEvent.
  function closeFaqAndNavigate() {
    navigatingRef.current = true;
    closeFaq();
  }

  // Focus the dialog on open and inert the rest of the page, so Tab stays in the
  // dialog instead of walking the page behind the backdrop. The wrapper keeps the
  // overlay and the trigger a single body child, so the rest of the page is exactly
  // the body siblings. The cleanup runs on the open -> closing transition, the step
  // all three close paths share, and again on unmount, so nothing is left inert.
  // Focus goes back to the trigger when the backdrop's animation ends instead: until
  // then the backdrop still covers the trigger and the focus ring would be hidden. Every
  // open clears the pending-navigation flag, so a close that does not navigate still gets
  // its focus back.
  useEffect(() => {
    if (!open) return;
    navigatingRef.current = false;
    const siblings = Array.from(document.body.children).filter(
      (el): el is HTMLElement => el instanceof HTMLElement && el !== rootRef.current,
    );
    for (const el of siblings) el.inert = true;
    dialogRef.current?.focus();
    return () => {
      for (const el of siblings) el.inert = false;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setDialogState("closing");
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
          {t("faq.a5.short")}{" "}
          <Link className={LINK} href="/about" onClick={closeFaqAndNavigate}>
            {t("nav.about")}
          </Link>
          .
        </>
      ),
    },
    { q: t("faq.q6"), a: t("faq.a6") },
    { q: t("faq.q7"), a: t("faq.a7") },
    {
      q: t("faq.q8"),
      a: (
        <>
          {t("faq.a8.short")}{" "}
          <Link className={LINK} href="/support" onClick={closeFaqAndNavigate}>
            {t("nav.support")}
          </Link>
          .
        </>
      ),
    },
    {
      q: t("faq.q9"),
      a: (
        <>
          {t("faq.a9.short")}{" "}
          <Link className={LINK} href="/community" onClick={closeFaqAndNavigate}>
            {t("nav.community")}
          </Link>
          .
        </>
      ),
    },
  ];

  return (
    <div ref={rootRef}>
      {dialogState !== "closed" && (
        <div
          className={`faq-backdrop${dialogState === "closing" ? " is-closing" : ""}`}
          onMouseDown={closeFaq}
          onAnimationEnd={(event) => {
            if (event.target === event.currentTarget && dialogState === "closing") {
              setDialogState("closed");
              if (!navigatingRef.current) triggerRef.current?.focus();
            }
          }}
        >
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label={t("faq.title")}
            tabIndex={-1}
            className="faq-dialog"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--card-border)]">
              <h2 className="section-heading text-base text-[var(--accent)]">
              {t("faq.title")}
              </h2>
              <button
                onClick={closeFaq}
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
                      aria-controls={`faq-answer-${i}`}
                      className="w-full flex items-start gap-3 text-left px-5 py-4 text-sm text-[var(--muted-strong)] hover:text-[var(--foreground)] transition-colors"
                    >
                      <span className={`text-[var(--accent)] mt-0.5 transition-transform ${on ? "rotate-90" : ""}`}>▸</span>
                      <span className="flex-1">{item.q}</span>
                    </button>
                    <div
                      id={`faq-answer-${i}`}
                      aria-hidden={!on}
                      inert={!on}
                      className={`faq-answer${on ? " is-open" : ""}`}
                    >
                      <div className="faq-answer__clip">
                        <div className="faq-answer__content px-5 pb-4 pl-10 text-sm text-[var(--muted)] leading-relaxed">
                          {item.a}
                        </div>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      )}

      <button
        ref={triggerRef}
        onClick={() => setDialogState((state) => (state === "closed" ? "open" : "closing"))}
        aria-label={t("faq.ariaOpen")}
        aria-expanded={open}
        className="faq-trigger"
      >
        {t("faq.title")}
      </button>
    </div>
  );
}
