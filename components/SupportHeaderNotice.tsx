"use client";

import { useEffect, useState } from "react";

const STORAGE_KEY = "tarkov-stats-support-notifications-seen";
const MAX_STORED_IDS = 200;
const SUPPORT_PATH = "/support";

// Dismissal is per browser, so it is keyed by notification id: editing the text of a
// notification the visitor already dismissed does not bring the dot back. Read and
// written only after mount, like ThemeToggle, so server and client markup agree.
function readSeen(): number[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is number => Number.isSafeInteger(value) && Number(value) > 0);
  } catch {
    return [];
  }
}

function writeSeen(ids: number[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...new Set([...readSeen(), ...ids])].slice(-MAX_STORED_IDS)));
  } catch {
    // A blocked or full storage just means the dot reappears on the next visit.
  }
}

/**
 * Ids of live notifications this browser has not dismissed yet. Reaching the support
 * page counts as having read them, which is what clears the dot.
 */
export function useUnseenSupportNotifications(pathname: string): number[] {
  // Stays empty until the read resolves, so the dot never renders on the server or
  // in the first paint and cannot flash on a page where nothing is unseen.
  const [ids, setIds] = useState<number[]>([]);

  useEffect(() => {
    let current = true;
    const request = new AbortController();
    void fetch("/api/support", { cache: "no-store", signal: request.signal })
      .then((response) => (response.ok ? (response.json() as Promise<{ notifications?: { id: number }[] }>) : null))
      .then((body) => {
        if (!current) return;
        const active = Array.isArray(body?.notifications) ? body.notifications.map((item) => Number(item.id)) : [];
        const onSupportPage = pathname === SUPPORT_PATH;
        if (onSupportPage && active.length > 0) {
          writeSeen(active);
          setIds([]);
        } else {
          const seen = readSeen();
          setIds(active.filter((id) => !seen.includes(id)));
        }
      })
      // Without a read there is nothing to flag, so the header stays clean. Swallowing
      // here is deliberate: a failed read must not clear ids already on screen.
      .catch(() => {});
    return () => { current = false; request.abort(); };
  }, [pathname]);

  return ids;
}
