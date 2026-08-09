import type { Favorite } from "@/lib/db";
import { appRouteMode } from "@/types/seasonal";

export type FavoriteTarget = Pick<Favorite, "mode" | "cycleId" | "aid">;

export function favoriteKey(target: FavoriteTarget): string {
  return `${target.mode}:${target.cycleId}:${target.aid}`;
}

export function favoriteHref(target: FavoriteTarget): string {
  const path = `/player/${appRouteMode(target.mode)}/${target.aid}`;
  return target.mode === "seasonal"
    ? `${path}?${new URLSearchParams({ cycle: target.cycleId })}`
    : path;
}
