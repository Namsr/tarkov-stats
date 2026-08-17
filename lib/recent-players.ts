"use client";

export type RecentPlayerMode = "regular" | "pve" | "arena" | "pvp-season";

export type RecentPlayerEntry = {
  aid: string;
  nickname: string;
  mode: RecentPlayerMode;
  cycle?: string;
};

export const RECENT_PLAYERS_COOKIE = "recent_players";
export const RECENT_PLAYERS_MAX_AGE = 15552000;
export const MAX_RECENT_PLAYERS = 10;

const COOKIE_VERSION = 1;
const MODES = new Set<RecentPlayerMode>(["regular", "pve", "arena", "pvp-season"]);
const AID_RE = /^\d{1,15}$/;
const CYCLE_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

type RecentPlayersPayload = {
  v: typeof COOKIE_VERSION;
  items: RecentPlayerEntry[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeAid(value: unknown): string | null {
  if (typeof value !== "string" || !AID_RE.test(value)) return null;
  const aid = Number(value);
  return Number.isSafeInteger(aid) && aid > 0 ? String(aid) : null;
}

function normalizeEntry(value: unknown): RecentPlayerEntry | null {
  if (!isRecord(value)) return null;

  const aid = normalizeAid(value.aid);
  const nickname = typeof value.nickname === "string" ? value.nickname.trim() : "";
  const mode = value.mode;
  if (!aid || !nickname || typeof mode !== "string" || !MODES.has(mode as RecentPlayerMode)) {
    return null;
  }

  const entry: RecentPlayerEntry = {
    aid,
    nickname,
    mode: mode as RecentPlayerMode,
  };

  if (entry.mode === "pvp-season" && typeof value.cycle === "string") {
    const cycle = value.cycle.trim();
    if (CYCLE_RE.test(cycle)) entry.cycle = cycle;
  }

  return entry;
}

function uniqueEntries(items: unknown[]): RecentPlayerEntry[] {
  const seen = new Set<string>();
  const result: RecentPlayerEntry[] = [];

  for (const item of items) {
    const entry = normalizeEntry(item);
    if (!entry || seen.has(entry.aid)) continue;
    seen.add(entry.aid);
    result.push(entry);
    if (result.length === MAX_RECENT_PLAYERS) break;
  }

  return result;
}

function readCookieValue(): string | null {
  if (typeof document === "undefined") return null;

  try {
    const prefix = `${RECENT_PLAYERS_COOKIE}=`;
    const part = document.cookie
      .split(";")
      .map((cookie) => cookie.trim())
      .find((cookie) => cookie.startsWith(prefix));
    return part ? part.slice(prefix.length) : null;
  } catch {
    return null;
  }
}

function writeCookie(items: RecentPlayerEntry[]): void {
  if (typeof document === "undefined") return;

  try {
    const value = encodeURIComponent(JSON.stringify({ v: COOKIE_VERSION, items } satisfies RecentPlayersPayload));
    const secure = typeof window !== "undefined" && window.location.protocol === "https:";
    document.cookie = `${RECENT_PLAYERS_COOKIE}=${value}; Max-Age=${RECENT_PLAYERS_MAX_AGE}; Path=/; SameSite=Lax${secure ? "; Secure" : ""}`;
  } catch {
    // Cookies can be disabled or unavailable in privacy-restricted contexts.
  }
}

export function readRecentPlayers(): RecentPlayerEntry[] {
  const raw = readCookieValue();
  if (!raw) return [];

  try {
    const payload: unknown = JSON.parse(decodeURIComponent(raw));
    if (!isRecord(payload) || payload.v !== COOKIE_VERSION || !Array.isArray(payload.items)) return [];
    return uniqueEntries(payload.items);
  } catch {
    return [];
  }
}

export function upsertRecentPlayer(entry: RecentPlayerEntry): RecentPlayerEntry[] {
  const normalized = normalizeEntry(entry);
  const current = readRecentPlayers();
  if (!normalized) return current;

  const next = [normalized, ...current.filter((item) => item.aid !== normalized.aid)].slice(0, MAX_RECENT_PLAYERS);
  writeCookie(next);
  return next;
}

export function removeRecentPlayer(aid: string): RecentPlayerEntry[] {
  const current = readRecentPlayers();
  const normalizedAid = normalizeAid(aid);
  if (!normalizedAid) return current;

  const next = current.filter((item) => item.aid !== normalizedAid);
  if (next.length !== current.length) writeCookie(next);
  return next;
}

export function filterRecentPlayers(entries: RecentPlayerEntry[], query: string): RecentPlayerEntry[] {
  const needle = query.trim().toLowerCase();
  return needle ? entries.filter((entry) => entry.nickname.toLowerCase().includes(needle)) : [...entries];
}

export function getRecentPlayerHref(entry: RecentPlayerEntry): string {
  const href = `/player/${entry.mode}/${encodeURIComponent(entry.aid)}`;
  return entry.mode === "pvp-season" && entry.cycle
    ? `${href}?cycle=${encodeURIComponent(entry.cycle)}`
    : href;
}
