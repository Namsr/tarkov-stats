"use client";

import { useEffect, useRef, useState } from "react";
import { Y_METRICS } from "@/lib/metrics";
import { useI18n } from "@/lib/i18n/context";

/**
 * Collapsed picker for the distribution chart's Y axis: shows the current
 * selection and reveals the full list of options on click. Closes on outside
 * click or Escape.
 */
export default function MetricPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (key: string) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const selected = Y_METRICS.find((m) => m.key === value) ?? Y_METRICS[0];
  const labelFor = (m: (typeof Y_METRICS)[number]) =>
    m.agg === "avg" ? `${t("common.avg")} ${t("metric." + m.key)}` : t("metric." + m.key);

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

  return (
    <div ref={ref} className="relative sm:w-52 shrink-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="ghost-button w-full flex justify-between gap-2 !text-left"
      >
        <span className="truncate">{labelFor(selected)}</span>
        <span className={`text-[var(--muted)] transition-transform ${open ? "rotate-180" : ""}`}>▾</span>
      </button>

      {open && (
        <ul
          role="listbox"
          className="absolute z-20 mt-2 w-full max-h-72 overflow-y-auto rounded-xl border border-[var(--card-border)] bg-[var(--card-bg)] shadow-xl py-1"
        >
          {Y_METRICS.map((m) => {
            const on = m.key === value;
            return (
              <li key={m.key}>
                <button
                  type="button"
                  role="option"
                  aria-selected={on}
                  onClick={() => {
                    onChange(m.key);
                    setOpen(false);
                  }}
                  className={`w-full text-left text-sm px-3 py-1.5 transition-colors ${
                    on
                      ? "bg-[var(--accent)]/15 text-[var(--accent)] font-medium"
                      : "text-[var(--muted-strong)] hover:bg-[var(--input-bg)] hover:text-[var(--foreground)]"
                  }`}
                >
                  {labelFor(m)}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
