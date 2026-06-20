"use client";

import { useEffect, useState } from "react";

// The Google callback redirects to "/?auth_error=<reason>" on any failure.
// Without this, a failed login silently bounces home and looks like nothing
// happened. Map the known reasons to a readable message and show it once.
const MESSAGES: Record<string, string> = {
  not_configured: "Google sign-in isn't configured on the server yet.",
  invalid_state: "Sign-in session expired or was blocked — please try again.",
  login_failed: "Couldn't complete Google sign-in — please try again.",
  access_denied: "Sign-in was cancelled.",
};

export default function AuthErrorBanner() {
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get("auth_error");
    if (!code) return;
    setMessage(MESSAGES[code] ?? `Sign-in failed (${code}).`);
    // Strip the param so a refresh or share doesn't re-trigger the banner.
    const url = new URL(window.location.href);
    url.searchParams.delete("auth_error");
    window.history.replaceState({}, "", url);
  }, []);

  if (!message) return null;

  return (
    <div
      role="alert"
      className="w-full rounded border border-[var(--danger)]/40 bg-[var(--danger)]/10 px-4 py-2 text-sm text-[var(--danger)] text-center"
    >
      {message}
    </div>
  );
}
