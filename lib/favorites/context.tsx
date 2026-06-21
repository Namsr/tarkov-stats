"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { Favorite } from "@/lib/db";

export type ToggleResult = "added" | "removed" | "limit" | "noop";

interface FavoritesValue {
  /** True once we know the user is signed in (GET /api/favorites returned 200). */
  enabled: boolean;
  /** True until the first load resolves. */
  loading: boolean;
  favorites: Favorite[];
  has: (aid: number) => boolean;
  /** Toggle a pin; returns what happened so callers can surface the limit. */
  toggle: (aid: number, nickname?: string | null) => Promise<ToggleResult>;
  remove: (aid: number) => Promise<void>;
  setNote: (aid: number, note: string | null) => Promise<void>;
  setMain: (aid: number) => Promise<void>;
  refresh: () => Promise<void>;
}

const FavoritesContext = createContext<FavoritesValue | null>(null);

const JSON_HEADERS = { "Content-Type": "application/json" };

export function FavoritesProvider({ children }: { children: React.ReactNode }) {
  const [favorites, setFavorites] = useState<Favorite[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/favorites");
      if (!res.ok) {
        // 401 → not signed in: the feature is simply disabled, never an error.
        setEnabled(false);
        setFavorites([]);
        return;
      }
      const data = (await res.json()) as { favorites: Favorite[] };
      setEnabled(true);
      setFavorites(data.favorites ?? []);
    } catch {
      setEnabled(false);
      setFavorites([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Fetch-on-mount: load favorites (and learn whether the user is signed in).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh();
  }, [refresh]);

  const has = useCallback((aid: number) => favorites.some((f) => f.aid === aid), [favorites]);

  const toggle = useCallback<FavoritesValue["toggle"]>(
    async (aid, nickname) => {
      if (!enabled) return "noop";

      if (favorites.some((f) => f.aid === aid)) {
        setFavorites((prev) => prev.filter((f) => f.aid !== aid)); // optimistic
        try {
          await fetch(`/api/favorites?aid=${aid}`, { method: "DELETE" });
        } catch {
          refresh();
        }
        return "removed";
      }

      const optimistic: Favorite = {
        aid,
        nickname: nickname ?? null,
        note: null,
        isMain: false,
        createdAt: Date.now(),
      };
      setFavorites((prev) => [optimistic, ...prev]);
      try {
        const res = await fetch("/api/favorites", {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ aid, nickname }),
        });
        if (!res.ok) {
          setFavorites((prev) => prev.filter((f) => f.aid !== aid)); // roll back
          if (res.status === 409) {
            const d = (await res.json().catch(() => ({}))) as { error?: string };
            if (d.error === "limit") return "limit";
          }
          return "noop";
        }
        return "added";
      } catch {
        refresh();
        return "noop";
      }
    },
    [enabled, favorites, refresh]
  );

  const remove = useCallback(
    async (aid: number) => {
      setFavorites((prev) => prev.filter((f) => f.aid !== aid));
      try {
        await fetch(`/api/favorites?aid=${aid}`, { method: "DELETE" });
      } catch {
        refresh();
      }
    },
    [refresh]
  );

  const setNote = useCallback(
    async (aid: number, note: string | null) => {
      setFavorites((prev) => prev.map((f) => (f.aid === aid ? { ...f, note } : f)));
      try {
        await fetch("/api/favorites", {
          method: "PATCH",
          headers: JSON_HEADERS,
          body: JSON.stringify({ aid, note: note ?? "" }),
        });
      } catch {
        refresh();
      }
    },
    [refresh]
  );

  const setMain = useCallback(
    async (aid: number) => {
      setFavorites((prev) => prev.map((f) => ({ ...f, isMain: f.aid === aid })));
      try {
        await fetch("/api/favorites", {
          method: "PATCH",
          headers: JSON_HEADERS,
          body: JSON.stringify({ aid, main: true }),
        });
      } catch {
        refresh();
      }
    },
    [refresh]
  );

  const value = useMemo<FavoritesValue>(
    () => ({ enabled, loading, favorites, has, toggle, remove, setNote, setMain, refresh }),
    [enabled, loading, favorites, has, toggle, remove, setNote, setMain, refresh]
  );

  return <FavoritesContext.Provider value={value}>{children}</FavoritesContext.Provider>;
}

export function useFavorites(): FavoritesValue {
  const ctx = useContext(FavoritesContext);
  if (!ctx) throw new Error("useFavorites must be used within <FavoritesProvider>");
  return ctx;
}
