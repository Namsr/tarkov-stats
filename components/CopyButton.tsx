"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n/context";

type CopyState = "idle" | "copied" | "error";

export default function CopyButton({ value }: { value: string }) {
  const { t } = useI18n();
  const [state, setState] = useState<CopyState>("idle");

  useEffect(() => {
    if (state === "idle") return;
    const timeout = window.setTimeout(() => setState("idle"), 2_500);
    return () => window.clearTimeout(timeout);
  }, [state]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setState("copied");
    } catch {
      setState("error");
    }
  }

  const status =
    state === "copied"
      ? t("support.copied")
      : state === "error"
        ? t("support.copyError")
        : "";

  return (
    <div className="copy-control">
      <button type="button" className="ghost-button" onClick={() => void copy()}>
        {state === "copied" ? t("support.copied") : t("support.copy")}
      </button>
      <span className="sr-only" aria-live="polite">
        {status}
      </span>
    </div>
  );
}
