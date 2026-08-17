"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { Favorite, FavoriteIdentity } from "@/lib/db";
import { LEGACY_IDENTITY } from "@/types/seasonal";

export type ToggleResult = "added" | "removed" | "limit" | "noop";
export type FavoritesAuthStatus =
  | "loading"
  | "authenticated"
  | "unauthenticated"
  | "error";

interface FavoritesValue {
  /** True once we know the user is signed in (GET /api/favorites returned 200). */
  enabled: boolean;
  /** True until the first load resolves. */
  loading: boolean;
  /** Distinguishes a signed-out session from a failed session check. */
  authStatus: FavoritesAuthStatus;
  favorites: Favorite[];
  has: (aid: number, identity?: FavoriteIdentity) => boolean;
  /** Toggle a pin; returns what happened so callers can surface the limit. */
  toggle: (aid: number, nickname?: string | null, identity?: FavoriteIdentity) => Promise<ToggleResult>;
  remove: (aid: number, identity?: FavoriteIdentity) => Promise<void>;
  setNote: (aid: number, note: string | null, identity?: FavoriteIdentity) => Promise<void>;
  setMain: (aid: number, identity?: FavoriteIdentity) => Promise<void>;
  refresh: () => Promise<void>;
}

const FavoritesContext = createContext<FavoritesValue | null>(null);

const JSON_HEADERS = { "Content-Type": "application/json" };

function target(identity?: FavoriteIdentity): FavoriteIdentity {
  return identity ?? LEGACY_IDENTITY;
}

function matches(favorite: Favorite, aid: number): boolean {
  return favorite.aid === aid;
}

export function FavoritesProvider({ children }: { children: React.ReactNode }) {
  const [favorites, setFavorites] = useState<Favorite[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [authStatus, setAuthStatus] = useState<FavoritesAuthStatus>("loading");

  const refresh = useCallback(async () => {
    setLoading(true);
    setAuthStatus("loading");
    try {
      const res = await fetch("/api/favorites?all=1");
      if (!res.ok) {
        if (res.status === 401) {
          setEnabled(false);
          setFavorites([]);
          setAuthStatus("unauthenticated");
        } else {
          setAuthStatus("error");
        }
        return;
      }
      const data = (await res.json()) as { favorites: Favorite[] };
      setEnabled(true);
      setFavorites(data.favorites ?? []);
      setAuthStatus("authenticated");
    } catch {
      setAuthStatus("error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Fetch-on-mount: load favorites (and learn whether the user is signed in).
    refresh();
  }, [refresh]);

  const has = useCallback(
    (aid: number) => favorites.some((favorite) => matches(favorite, aid)),
    [favorites]
  );

  const toggle = useCallback<FavoritesValue["toggle"]>(
    async (aid, nickname, identity) => {
      if (!enabled) return "noop";
      const id = target(identity);

      if (favorites.some((favorite) => matches(favorite, aid))) {
        const removed = favorites.find((favorite) => matches(favorite, aid)) ?? null;
        const removedIndex = favorites.findIndex((favorite) => matches(favorite, aid));
        setFavorites((prev) => prev.filter((favorite) => !matches(favorite, aid))); // optimistic
        try {
          const res = await fetch(`/api/favorites?${new URLSearchParams({ aid: String(aid) })}`, { method: "DELETE" });
          if (!res.ok) throw new Error();
        } catch {
          setFavorites((prev) => {
            if (!removed || prev.some((favorite) => matches(favorite, aid))) return prev;
            const next = [...prev];
            next.splice(Math.min(removedIndex, next.length), 0, removed);
            return next;
          });
          await refresh();
          return "noop";
        }
        return "removed";
      }

      const optimistic: Favorite = {
        ...id,
        aid,
        nickname: nickname ?? null,
        note: null,
        isMain: false,
        createdAt: Date.now(),
      };
      setFavorites((prev) => prev.some((favorite) => matches(favorite, aid))
        ? prev
        : [optimistic, ...prev]);
      try {
        const res = await fetch("/api/favorites", {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ aid, nickname, mode: id.mode, cycle: id.cycleId }),
        });
        if (!res.ok) {
          let outcome: ToggleResult = "noop";
          if (res.status === 409) {
            const d = (await res.json().catch(() => ({}))) as { error?: string };
            if (d.error === "limit") outcome = "limit";
          }
          setFavorites((prev) => prev.filter((favorite) => !matches(favorite, aid)));
          await refresh();
          return outcome;
        }
        const data = (await res.json().catch(() => ({}))) as { already?: boolean };
        if (data.already) await refresh();
        return "added";
      } catch {
        setFavorites((prev) => prev.filter((favorite) => !matches(favorite, aid)));
        await refresh();
        return "noop";
      }
    },
    [enabled, favorites, refresh]
  );

  const remove = useCallback(
    async (aid: number) => {
      const removed = favorites.find((favorite) => matches(favorite, aid)) ?? null;
      const removedIndex = favorites.findIndex((favorite) => matches(favorite, aid));
      setFavorites((prev) => prev.filter((favorite) => !matches(favorite, aid)));
      try {
        const res = await fetch(`/api/favorites?${new URLSearchParams({ aid: String(aid) })}`, { method: "DELETE" });
        if (!res.ok) throw new Error();
      } catch {
        setFavorites((prev) => {
          if (!removed || prev.some((favorite) => matches(favorite, aid))) return prev;
          const next = [...prev];
          next.splice(Math.min(removedIndex, next.length), 0, removed);
          return next;
        });
        await refresh();
      }
    },
    [favorites, refresh]
  );

  const setNote = useCallback(
    async (aid: number, note: string | null) => {
      const previousNote = favorites.find((favorite) => matches(favorite, aid))?.note ?? null;
      setFavorites((prev) => prev.map((favorite) => matches(favorite, aid) ? { ...favorite, note } : favorite));
      try {
        const res = await fetch("/api/favorites", {
          method: "PATCH",
          headers: JSON_HEADERS,
          body: JSON.stringify({ aid, note: note ?? "" }),
        });
        if (!res.ok) throw new Error();
      } catch {
        setFavorites((prev) => prev.map((favorite) =>
          matches(favorite, aid) && favorite.note === note ? { ...favorite, note: previousNote } : favorite));
        await refresh();
      }
    },
    [favorites, refresh]
  );

  const setMain = useCallback(
    async (aid: number) => {
      const previousMainAid = favorites.find((favorite) => favorite.isMain)?.aid ?? null;
      setFavorites((prev) => prev.map((favorite) => ({ ...favorite, isMain: matches(favorite, aid) })));
      try {
        const res = await fetch("/api/favorites", {
          method: "PATCH",
          headers: JSON_HEADERS,
          body: JSON.stringify({ aid, main: true }),
        });
        if (!res.ok) throw new Error();
      } catch {
        setFavorites((prev) => prev.some((favorite) => matches(favorite, aid) && favorite.isMain)
          ? prev.map((favorite) => ({ ...favorite, isMain: favorite.aid === previousMainAid }))
          : prev);
        await refresh();
      }
    },
    [favorites, refresh]
  );

  const value = useMemo<FavoritesValue>(
    () => ({
      enabled,
      loading,
      authStatus,
      favorites,
      has,
      toggle,
      remove,
      setNote,
      setMain,
      refresh,
    }),
    [enabled, loading, authStatus, favorites, has, toggle, remove, setNote, setMain, refresh]
  );

  return <FavoritesContext.Provider value={value}>{children}</FavoritesContext.Provider>;
}

export function useFavorites(): FavoritesValue {
  const ctx = useContext(FavoritesContext);
  if (!ctx) throw new Error("useFavorites must be used within <FavoritesProvider>");
  return ctx;
}
