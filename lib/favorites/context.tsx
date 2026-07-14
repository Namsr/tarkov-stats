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

function matches(favorite: Favorite, aid: number, identity?: FavoriteIdentity): boolean {
  const id = target(identity);
  return favorite.aid === aid && favorite.mode === id.mode && favorite.cycleId === id.cycleId;
}

function identityParams(aid: number, identity?: FavoriteIdentity): string {
  const id = target(identity);
  return new URLSearchParams({ aid: String(aid), mode: id.mode, cycle: id.cycleId }).toString();
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
        // 401 → not signed in: the feature is simply disabled, never an error.
        setEnabled(false);
        setFavorites([]);
        setAuthStatus(res.status === 401 ? "unauthenticated" : "error");
        return;
      }
      const data = (await res.json()) as { favorites: Favorite[] };
      setEnabled(true);
      setFavorites(data.favorites ?? []);
      setAuthStatus("authenticated");
    } catch {
      setEnabled(false);
      setFavorites([]);
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
    (aid: number, identity?: FavoriteIdentity) => favorites.some((favorite) => matches(favorite, aid, identity)),
    [favorites]
  );

  const toggle = useCallback<FavoritesValue["toggle"]>(
    async (aid, nickname, identity) => {
      if (!enabled) return "noop";
      const id = target(identity);

      if (favorites.some((favorite) => matches(favorite, aid, id))) {
        setFavorites((prev) => prev.filter((favorite) => !matches(favorite, aid, id))); // optimistic
        try {
          await fetch(`/api/favorites?${identityParams(aid, id)}`, { method: "DELETE" });
        } catch {
          refresh();
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
      setFavorites((prev) => [optimistic, ...prev]);
      try {
        const res = await fetch("/api/favorites", {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ aid, nickname, mode: id.mode, cycle: id.cycleId }),
        });
        if (!res.ok) {
          setFavorites((prev) => prev.filter((favorite) => !matches(favorite, aid, id))); // roll back
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
    async (aid: number, identity?: FavoriteIdentity) => {
      const id = target(identity);
      setFavorites((prev) => prev.filter((favorite) => !matches(favorite, aid, id)));
      try {
        await fetch(`/api/favorites?${identityParams(aid, id)}`, { method: "DELETE" });
      } catch {
        refresh();
      }
    },
    [refresh]
  );

  const setNote = useCallback(
    async (aid: number, note: string | null, identity?: FavoriteIdentity) => {
      const id = target(identity);
      setFavorites((prev) => prev.map((favorite) => matches(favorite, aid, id) ? { ...favorite, note } : favorite));
      try {
        await fetch("/api/favorites", {
          method: "PATCH",
          headers: JSON_HEADERS,
          body: JSON.stringify({ aid, note: note ?? "", mode: id.mode, cycle: id.cycleId }),
        });
      } catch {
        refresh();
      }
    },
    [refresh]
  );

  const setMain = useCallback(
    async (aid: number, identity?: FavoriteIdentity) => {
      const id = target(identity);
      setFavorites((prev) => prev.map((favorite) => ({ ...favorite, isMain: matches(favorite, aid, id) })));
      try {
        await fetch("/api/favorites", {
          method: "PATCH",
          headers: JSON_HEADERS,
          body: JSON.stringify({ aid, main: true, mode: id.mode, cycle: id.cycleId }),
        });
      } catch {
        refresh();
      }
    },
    [refresh]
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
