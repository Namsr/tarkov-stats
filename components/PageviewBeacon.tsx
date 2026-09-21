"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { PAGEVIEW_VISITOR_PATTERN } from "@/lib/admin/pageviews";

const VISITOR_KEY = "ts_visitor_id";
const ENDPOINT = "/api/pageview";

function getVisitorId(): string | null {
  try {
    const stored = window.localStorage.getItem(VISITOR_KEY);
    if (stored && PAGEVIEW_VISITOR_PATTERN.test(stored)) return stored;
    const fresh = typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
    window.localStorage.setItem(VISITOR_KEY, fresh);
    return fresh;
  } catch {
    return null;
  }
}

/**
 * First-party pageview beacon for our own traffic counter.
 * Sends one hit per visited path (including client-side navigation):
 * anonymous visitor id + path + referrer host only, no query strings.
 * Skips /admin, Do Not Track users and servers that answer from non-canonical hosts.
 */
export default function PageviewBeacon() {
  const pathname = usePathname();
  const lastSent = useRef("");

  useEffect(() => {
    if (!pathname || pathname === "/admin" || pathname.startsWith("/admin/")) return;
    if (typeof navigator !== "undefined" && navigator.doNotTrack === "1") return;
    // Guard against React StrictMode double-invocation and duplicate navigations.
    if (lastSent.current === pathname) return;
    lastSent.current = pathname;

    const visitor = getVisitorId();
    if (!visitor) return;

    let referrer: string | null = null;
    try {
      if (document.referrer) {
        const url = new URL(document.referrer);
        // Same-site navigation is not acquisition; the server also drops own domains.
        if (url.host !== window.location.host) referrer = url.hostname.toLowerCase();
      }
    } catch {
      referrer = null;
    }

    const payload = JSON.stringify({ path: pathname, visitor, referrer });
    try {
      if (typeof navigator.sendBeacon === "function") {
        if (navigator.sendBeacon(ENDPOINT, new Blob([payload], { type: "application/json" }))) return;
      }
    } catch {
      // Fall through to fetch.
    }
    try {
      void fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
        keepalive: true,
        credentials: "same-origin",
      });
    } catch {
      // Analytics must never surface errors to the user.
    }
  }, [pathname]);

  return null;
}
