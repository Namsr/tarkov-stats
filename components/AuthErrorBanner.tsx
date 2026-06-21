"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n/context";

// The Google callback redirects to "/?auth_error=<reason>" on any failure.
// Without this, a failed login silently bounces home and looks like nothing
// happened. Map the known reasons to a readable message and show it once.
const KNOWN_CODES = new Set([
  "not_configured",
  "invalid_state",
  "login_failed",
  "access_denied",
]);

export default function AuthErrorBanner() {
  const { t } = useI18n();
  const [code, setCode] = useState<string | null>(null);

  useEffect(() => {
    const param = new URLSearchParams(window.location.search).get("auth_error");
    if (!param) return;
    setCode(param);
    // Strip the param so a refresh or share doesn't re-trigger the banner.
    const url = new URL(window.location.href);
    url.searchParams.delete("auth_error");
    window.history.replaceState({}, "", url);
  }, []);

  if (!code) return null;

  const message = KNOWN_CODES.has(code)
    ? t("authError." + code)
    : t("authError.fallback", { code });

  return (
    <div
      role="alert"
      className="w-full rounded border border-[var(--danger)]/40 bg-[var(--danger)]/10 px-4 py-2 text-sm text-[var(--danger)] text-center"
    >
      {message}
    </div>
  );
}
