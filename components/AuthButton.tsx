"use client";

import { useEffect, useState } from "react";
import type { SessionUser } from "@/lib/auth/session";

export default function AuthButton() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [loggingOut, setLoggingOut] = useState(false);

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((d: { user: SessionUser | null }) => setUser(d.user))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  async function logout() {
    setLoggingOut(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
      window.location.reload();
    } catch {
      setLoggingOut(false);
    }
  }

  if (loading) {
    return <div className="h-8 w-20 skeleton rounded" aria-hidden />;
  }

  if (!user) {
    return (
      <a
        href="/api/auth/google"
        className="flex items-center gap-2 px-3 py-1.5 text-sm bg-[var(--card-bg)] border border-[var(--card-border)] rounded hover:border-[var(--accent)] hover:text-[var(--accent)] transition-colors"
      >
        <GoogleIcon />
        Sign in
      </a>
    );
  }

  const initial = (user.name || user.email || "?").charAt(0).toUpperCase();

  return (
    <div className="flex items-center gap-3">
      {user.picture ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={user.picture}
          alt=""
          width={28}
          height={28}
          className="rounded-full border border-[var(--card-border)]"
          referrerPolicy="no-referrer"
        />
      ) : (
        <div className="h-7 w-7 rounded-full bg-[var(--accent)] text-[var(--background)] flex items-center justify-center text-sm font-bold">
          {initial}
        </div>
      )}
      <span className="text-sm text-gray-300 hidden sm:inline max-w-32 truncate">
        {user.name || user.email}
      </span>
      <button
        onClick={logout}
        disabled={loggingOut}
        className="text-xs text-gray-500 hover:text-[var(--danger)] transition-colors disabled:opacity-50"
      >
        {loggingOut ? "..." : "Logout"}
      </button>
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 48 48" aria-hidden>
      <path
        fill="#FFC107"
        d="M43.6 20.5H42V20H24v8h11.3c-1.6 4.7-6.1 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.6 6.1 29.6 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.3-.4-3.5z"
      />
      <path
        fill="#FF3D00"
        d="m6.3 14.7 6.6 4.8C14.7 15.1 18.9 12 24 12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.6 6.1 29.6 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"
      />
      <path
        fill="#4CAF50"
        d="M24 44c5.5 0 10.5-2.1 14.3-5.6l-6.6-5.6C29.6 34.6 26.9 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"
      />
      <path
        fill="#1976D2"
        d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.6 5.6C41.4 36.4 44 30.7 44 24c0-1.3-.1-2.3-.4-3.5z"
      />
    </svg>
  );
}
