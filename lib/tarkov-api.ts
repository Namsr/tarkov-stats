import type {
  PlayerProfile,
  ParsedPlayerStats,
  ArenaCounterItem,
  ArenaCounterGroup,
  ArenaModeKey,
  ArenaModeStats,
} from "@/types/tarkov";
import {
  ARENA_MODE_KEYS,
  ARENA_RAW_COUNTERS,
  type ArenaCounters,
  type ArenaMetrics,
  type ArenaModeKey as PublicArenaModeKey,
  type ArenaModeStats as PublicArenaModeStats,
  type ArenaOverallStats,
  type ArenaProfile,
}
// @ts-expect-error Node's direct TypeScript runner needs the explicit extension.
from "../types/arena.ts";
// @ts-expect-error Node's strip-types runner needs the extension; Next can bundle it.
import { normalizeWeaponMastery, parseWeaponMastery, type WeaponMasteryReference } from "./profile-mastery.ts";

export const TARKOV_JSON_USER_AGENT = "TarkovStats/0.1 (+https://tarkovstats.ru)";

/** Server-side JSON request with the identity required by tarkov.dev. */
export function fetchTarkovJson(url: string | URL, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  headers.set("User-Agent", TARKOV_JSON_USER_AGENT);
  return fetch(url, { ...init, headers });
}

/** Captcha-gated live service (nickname search + live account fetch). */
const PLAYER_API_BASE = "https://player.tarkov.dev";
/** Captcha-free static cache of already-viewed profiles, keyed by account id. */
const PUBLIC_PROFILE_BASE = "https://players.tarkov.dev";
const ITEMS_URL = "https://json.tarkov.dev/regular/items";
const ACHIEVEMENT_ENDPOINTS = {
  regular: {
    tasks: "https://json.tarkov.dev/regular/tasks",
    english: "https://json.tarkov.dev/regular/tasks_en",
    russian: "https://json.tarkov.dev/regular/tasks_ru",
  },
  seasonal: {
    tasks: "https://json.tarkov.dev/pvp-season/tasks",
    english: "https://json.tarkov.dev/pvp-season/tasks_en",
    russian: "https://json.tarkov.dev/pvp-season/tasks_ru",
  },
} as const;

/**
 * Nickname search. Requires a valid Cloudflare Turnstile token bound to
 * tarkov.dev's hostname, so it only works from a real browser session on
 * tarkov.dev — not server-to-server. Kept for reference / future use.
 */
export async function searchPlayer(
  nickname: string,
  turnstileToken?: string
): Promise<{ aid: number; name: string }[]> {
  const params = new URLSearchParams();
  if (turnstileToken) params.set("token", turnstileToken);
  const qs = params.toString();
  const url = `${PLAYER_API_BASE}/name/${encodeURIComponent(nickname)}${qs ? `?${qs}` : ""}`;

  const res = await fetchTarkovJson(url, { cache: "no-store" });
  if (!res.ok) {
    if (res.status === 404) return [];
    throw new Error(`Player search failed: ${res.status}`);
  }
  return res.json();
}

/** Live, captcha-gated profile fetch by account id. Kept for reference. */
export async function getPlayerProfile(
  aid: number,
  turnstileToken?: string
): Promise<PlayerProfile> {
  const params = new URLSearchParams();
  if (turnstileToken) params.set("token", turnstileToken);
  const qs = params.toString();
  const url = `${PLAYER_API_BASE}/account/${aid}${qs ? `?${qs}` : ""}`;

  const res = await fetchTarkovJson(url, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Profile fetch failed: ${res.status}`);
  }
  return res.json();
}

// In-process кэш upstream-профилей по aid. Снижает удары по players.tarkov.dev
// (риск бана IP VPS / амплификации) и частоту записи одинаковых строк в БД.
// Кэшируем и 404 (null) — защита от перебора несуществующих id.
type CachedProfile = { profile: PlayerProfile | null; ts: number };
export type PublicProfileMode = "regular" | "pve" | "arena";
const PUBLIC_PROFILE_PATH: Record<PublicProfileMode, string> = {
  regular: "profile",
  pve: "pve",
  arena: "arena",
};
const profileCache = new Map<string, CachedProfile>();
const PROFILE_TTL_MS = 5 * 60 * 1000; // 5 минут
const PROFILE_CACHE_MAX = 2000;
const PROFILE_VERSION_TOLERANCE_MS = 1000;

type EdgeProfileCache = {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
};

function getEdgeProfileCache(): EdgeProfileCache | null {
  const storage = (globalThis as typeof globalThis & {
    caches?: { default?: EdgeProfileCache };
  }).caches;
  return storage?.default ?? null;
}

function cacheProfile(key: string, profile: PlayerProfile | null, ts: number) {
  if (profileCache.size > PROFILE_CACHE_MAX) {
    for (const [k, v] of profileCache) {
      if (ts - v.ts >= PROFILE_TTL_MS) profileCache.delete(k);
    }
    if (profileCache.size > PROFILE_CACHE_MAX) profileCache.clear();
  }
  profileCache.set(key, { profile, ts });
}

export interface PublicProfileResult {
  profile: PlayerProfile | null;
  fromCache: boolean;
  fromEdgeCache?: boolean;
}

export class PublicProfileVersionConflictError extends Error {
  readonly code = "public_profile_version_conflict";
  readonly expectedUpdatedAt: number;
  readonly actualUpdatedAt: number | null;

  constructor(
    expectedUpdatedAt: number,
    actualUpdatedAt: number | null,
  ) {
    super(`Public profile version ${actualUpdatedAt ?? "missing"} is older than ${expectedUpdatedAt}`);
    this.expectedUpdatedAt = expectedUpdatedAt;
    this.actualUpdatedAt = actualUpdatedAt;
  }
}

function profileUpdatedAt(value: unknown): number | null {
  const timestamp = Number(value);
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) return null;
  return timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp;
}

/**
 * Captcha-free profile fetch by account id from the public static cache.
 * `profile` is null when not cached upstream (404). `fromCache` says whether the
 * result came from our in-process cache (caller can then skip the DB upsert).
 * Pass `{ force: true }` to bypass the in-process cache and always re-fetch
 * upstream (the explicit "Refresh" / page reload path).
 */
export async function getPublicProfile(
  aid: number,
  opts: { force?: boolean; mode?: PublicProfileMode; expectedUpdatedAt?: number } = {}
): Promise<PublicProfileResult> {
  const now = Date.now();
  const mode = opts.mode ?? "regular";
  const cacheKey = `${mode}:${aid}`;
  // force обходит in-process кэш: всё равно идём в upstream и перезаписываем кэш
  // свежим ответом (fromCache=false → вызывающий сделает upsert в БД).
  if (!opts.force) {
    const hit = profileCache.get(cacheKey);
    if (hit && now - hit.ts < PROFILE_TTL_MS) {
      return { profile: hit.profile, fromCache: true };
    }
  }

  const canonicalUrl = `${PUBLIC_PROFILE_BASE}/${PUBLIC_PROFILE_PATH[mode]}/${aid}.json`;
  const expectedUpdatedAt = mode === "regular" || mode === "pve" || mode === "arena"
    ? profileUpdatedAt(opts.expectedUpdatedAt)
    : null;
  const cacheBust = expectedUpdatedAt ?? now;
  const url = opts.force && (mode === "regular" || mode === "arena" || expectedUpdatedAt !== null)
    ? `${canonicalUrl}?v=${cacheBust}`
    : canonicalUrl;
  const edgeCache = opts.force ? null : getEdgeProfileCache();
  const edgeRequest = edgeCache ? new Request(canonicalUrl) : null;
  let res: Response | undefined;
  let fromEdgeCache = false;
  if (edgeCache && edgeRequest) {
    try {
      res = await edgeCache.match(edgeRequest);
      fromEdgeCache = Boolean(res);
    } catch {
      // The Cache API is an optimization. Fall back to the normal fetch path.
    }
  }
  if (!res) {
    // Normal profile opens can use the platform/edge fetch cache. Explicit
    // refreshes remain uncached so the user can still request fresh upstream data.
    res = await fetchTarkovJson(url, {
      cache: opts.force ? "no-store" : "force-cache",
    });
  }
  if (res.status === 404) {
    cacheProfile(cacheKey, null, now);
    return { profile: null, fromCache: false, fromEdgeCache };
  }
  if (!res.ok) {
    throw new Error(`Public profile fetch failed: ${res.status}`);
  }
  const edgeResponse = !fromEdgeCache && edgeCache && edgeRequest ? res.clone() : null;
  const profile = (await res.json()) as PlayerProfile;
  if (Number(profile.aid) !== aid || !profile.info) {
    throw new Error("Public profile identity mismatch");
  }
  if (mode === "arena" && !profile.stat?.arenaOverAllCounters) {
    throw new Error("Public Arena profile schema mismatch");
  }
  if (mode === "pve" && (!profile.pmcStats?.eft || !Array.isArray(profile.skills?.Common))) {
    throw new Error("Public PVE profile schema mismatch");
  }
  const actualUpdatedAt = profileUpdatedAt(profile.updated);
  if (
    expectedUpdatedAt !== null &&
    (
      actualUpdatedAt === null ||
      actualUpdatedAt < expectedUpdatedAt - PROFILE_VERSION_TOLERANCE_MS
    )
  ) {
    throw new PublicProfileVersionConflictError(
      expectedUpdatedAt,
      actualUpdatedAt,
    );
  }
  if (expectedUpdatedAt !== null) {
    // updated.json is authoritative for sub-second serialization skew. Persist
    // its version so the completed queue item is not rediscovered every day.
    profile.updated = Math.max(actualUpdatedAt ?? expectedUpdatedAt, expectedUpdatedAt);
  }
  if (edgeResponse && edgeCache && edgeRequest) {
    try {
      // Do not inherit players.tarkov.dev's 24-hour max-age: normal profile
      // opens should not serve a stale snapshot longer than our old 5-minute
      // in-process cache. Explicit refreshes still bypass this entry entirely.
      const cacheHeaders = new Headers(edgeResponse.headers);
      cacheHeaders.set("Cache-Control", "public, max-age=300");
      await edgeCache.put(
        edgeRequest,
        new Response(edgeResponse.body, {
          status: edgeResponse.status,
          statusText: edgeResponse.statusText,
          headers: cacheHeaders,
        }),
      );
    } catch {
      // A cache write failure must never fail a profile response.
    }
  }
  cacheProfile(cacheKey, profile, now);
  return { profile, fromCache: false, fromEdgeCache };
}

export type PlayerLevel = { level: number; exp: number };

/** Known-good 2026-07-22 snapshot of JSON API incremental level XP. */
export const PLAYER_LEVELS_V2026_07_22: readonly PlayerLevel[] = [
  { level: 1, exp: 0 }, { level: 2, exp: 1000 }, { level: 3, exp: 3017 },
  { level: 4, exp: 4415 }, { level: 5, exp: 5824 }, { level: 6, exp: 7221 },
  { level: 7, exp: 8546 }, { level: 8, exp: 9913 }, { level: 9, exp: 11268 },
  { level: 10, exp: 12519 }, { level: 11, exp: 13840 }, { level: 12, exp: 15716 },
  { level: 13, exp: 22023 }, { level: 14, exp: 27951 }, { level: 15, exp: 34084 },
  { level: 16, exp: 40548 }, { level: 17, exp: 46547 }, { level: 18, exp: 52419 },
  { level: 19, exp: 57549 }, { level: 20, exp: 63065 }, { level: 21, exp: 67696 },
  { level: 22, exp: 72817 }, { level: 23, exp: 78369 }, { level: 24, exp: 84803 },
  { level: 25, exp: 94916 }, { level: 26, exp: 108067 }, { level: 27, exp: 122126 },
  { level: 28, exp: 133164 }, { level: 29, exp: 144320 }, { level: 30, exp: 155595 },
  { level: 31, exp: 166982 }, { level: 32, exp: 180344 }, { level: 33, exp: 196685 },
  { level: 34, exp: 215087 }, { level: 35, exp: 233690 }, { level: 36, exp: 258091 },
  { level: 37, exp: 281805 }, { level: 38, exp: 305744 }, { level: 39, exp: 326065 },
  { level: 40, exp: 346570 }, { level: 41, exp: 367261 }, { level: 42, exp: 388137 },
  { level: 43, exp: 416600 }, { level: 44, exp: 445333 }, { level: 45, exp: 474331 },
  { level: 46, exp: 528224 }, { level: 47, exp: 559155 }, { level: 48, exp: 590350 },
  { level: 49, exp: 621815 }, { level: 50, exp: 653537 }, { level: 51, exp: 685522 },
  { level: 52, exp: 717765 }, { level: 53, exp: 761235 }, { level: 54, exp: 805078 },
  { level: 55, exp: 849297 }, { level: 56, exp: 893877 }, { level: 57, exp: 938823 },
  { level: 58, exp: 984131 }, { level: 59, exp: 1029795 }, { level: 60, exp: 1095775 },
  { level: 61, exp: 1225050 }, { level: 62, exp: 1319453 }, { level: 63, exp: 1431321 },
  { level: 64, exp: 1558177 }, { level: 65, exp: 1748019 }, { level: 66, exp: 2002313 },
  { level: 67, exp: 2480456 }, { level: 68, exp: 3447343 }, { level: 69, exp: 4924970 },
  { level: 70, exp: 6306999 }, { level: 71, exp: 7640970 }, { level: 72, exp: 8986198 },
  { level: 73, exp: 10341135 }, { level: 74, exp: 11704613 }, { level: 75, exp: 13075721 },
  { level: 76, exp: 14453730 }, { level: 77, exp: 15838039 }, { level: 78, exp: 18623623 },
  { level: 79, exp: 27091684 },
];

let levelsCache: { data: PlayerLevel[]; ts: number } | null = null;
const LEVELS_TTL_MS = 6 * 60 * 60 * 1000; // 6h

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Validates the JSON API's incremental-XP level table at the trust boundary. */
export function parsePlayerLevels(payload: unknown): PlayerLevel[] {
  const data = record(record(payload)?.data);
  const rows = data?.playerLevels;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error("playerLevels must be a non-empty array");
  }
  const seen = new Set<number>();
  const levels = rows.map((value, index) => {
    const row = record(value);
    const level = row?.level;
    const exp = row?.exp;
    if (typeof level !== "number" || !Number.isSafeInteger(level) || level <= 0) {
      throw new Error(`playerLevels[${index}].level must be a positive integer`);
    }
    if (typeof exp !== "number" || !Number.isFinite(exp) || exp < 0) {
      throw new Error(`playerLevels[${index}].exp must be a finite non-negative number`);
    }
    if (seen.has(Number(level))) {
      throw new Error(`playerLevels contains duplicate level ${level}`);
    }
    seen.add(Number(level));
    return { level: Number(level), exp };
  });
  return levels.sort((a, b) => a.level - b.level);
}

/** Fetches levels once; failures return the versioned known-good local table. */
export async function loadPlayerLevels(
  request: typeof fetchTarkovJson = fetchTarkovJson
): Promise<PlayerLevel[]> {
  try {
    const response = await request(ITEMS_URL, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const levels = parsePlayerLevels(await response.json());
    console.info("tarkov reference", { reference: "playerLevels", source: "json" });
    return levels;
  } catch (error) {
    console.error(
      "tarkov reference validation failed",
      { reference: "playerLevels", error: error instanceof Error ? error.message : "unknown" }
    );
    const fallback = parsePlayerLevels({ data: { playerLevels: PLAYER_LEVELS_V2026_07_22 } });
    console.info("tarkov reference", { reference: "playerLevels", source: "local-fallback" });
    return fallback;
  }
}

/** Reference table mapping cumulative XP to character level, cached in-isolate. */
export async function getPlayerLevels(): Promise<PlayerLevel[]> {
  const now = Date.now();
  if (levelsCache && now - levelsCache.ts < LEVELS_TTL_MS) {
    console.info("tarkov reference", { reference: "playerLevels", source: "memory-cache" });
    return levelsCache.data;
  }
  const levels = await loadPlayerLevels();
  levelsCache = { data: levels, ts: now };
  return levels;
}

/**
 * Resolves a character level from total experience.
 * playerLevels[].exp is the XP required FOR each level (an increment), so the
 * level is the highest one whose cumulative (running-sum) requirement is met.
 */
export function expToLevel(exp: number, levels: PlayerLevel[]): number {
  const sorted = [...levels].sort((a, b) => a.level - b.level);
  let cumulative = 0;
  let level = 0;
  for (const l of sorted) {
    cumulative += l.exp;
    if (exp >= cumulative) level = l.level;
    else break;
  }
  return level;
}

/** Static metadata for an achievement (names, rarity, BSG-wide completion %). */
export interface AchievementMeta {
  id: string;
  name: string;
  /** Explicit language fields for server ViewModels; `name` remains English for legacy callers. */
  nameEn: string;
  nameRu: string | null;
  /** Explicit language fields for server ViewModels. */
  descriptionEn: string | null;
  descriptionRu: string | null;
  /** Sanitized official achievement asset URL. */
  imageUrl: string | null;
  side: string;
  rarity: string;
  /** BSG's official share of ALL players who have it. */
  playersCompletedPercent: number;
  /** BSG's share among players who reached the relevant content. */
  adjustedPlayersCompletedPercent: number;
}

export type AchievementMode = keyof typeof ACHIEVEMENT_ENDPOINTS;
type AchievementCache = { data: Map<string, AchievementMeta>; ts: number };
const achievementsCache = new Map<AchievementMode, AchievementCache>();
const ACHIEVEMENTS_TTL_MS = 6 * 60 * 60 * 1000; // 6h
const MASTERY_TTL_MS = 6 * 60 * 60 * 1000; // 6h
const ACHIEVEMENT_IMAGE_HOSTS = new Set(["assets.tarkov.dev"]);
let masteryCache: { data: WeaponMasteryReference[]; ts: number } | null = null;

/**
 * Keep externally supplied image URLs inside the official Tarkov asset host.
 * Invalid or unknown values are intentionally dropped instead of being
 * persisted or rendered as an arbitrary remote resource.
 */
export function safeAchievementImageUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !ACHIEVEMENT_IMAGE_HOSTS.has(url.hostname.toLowerCase())) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * The VPS image is read-only apart from /data. Keep the last valid reference
 * response there so an upstream restart does not turn every achievement into
 * its raw id after the web container is recreated. Cloudflare/other runtimes
 * simply skip this optional Node filesystem cache.
 */
function achievementCacheFile(mode: AchievementMode): string {
  const directory = process.env.ACHIEVEMENTS_CACHE_DIR || "/data";
  return `${directory.replace(/[\\/]+$/, "")}/achievements-${mode}.json`;
}

function parsePersistedAchievements(payload: unknown, mode: AchievementMode): AchievementCache {
  const root = record(payload);
  if (
    root?.version !== 1 ||
    root.mode !== mode ||
    typeof root.savedAt !== "number" ||
    !Number.isFinite(root.savedAt) ||
    !Array.isArray(root.entries) ||
    root.entries.length === 0
  ) {
    throw new Error("invalid persisted achievement cache");
  }
  const data = new Map<string, AchievementMeta>();
  let hasLegacyEntry = false;
  for (const value of root.entries) {
    const row = record(value);
    if (
      !row ||
      typeof row.id !== "string" ||
      typeof row.name !== "string" ||
      typeof row.nameEn !== "string" ||
      (row.nameRu !== null && typeof row.nameRu !== "string") ||
      typeof row.side !== "string" ||
      (row.rarity !== "common" && row.rarity !== "rare" && row.rarity !== "legendary" && row.rarity !== "seasonal")
    ) {
      throw new Error("invalid persisted achievement entry");
    }
    if (
      !Object.prototype.hasOwnProperty.call(row, "descriptionEn") ||
      !Object.prototype.hasOwnProperty.call(row, "descriptionRu") ||
      !Object.prototype.hasOwnProperty.call(row, "imageUrl")
    ) {
      hasLegacyEntry = true;
    }
    const nameRu = row.nameRu === null ? null : row.nameRu;
    data.set(row.id, {
      id: row.id,
      name: row.name,
      nameEn: row.nameEn,
      nameRu,
      descriptionEn: row.descriptionEn === undefined || row.descriptionEn === null
        ? null
        : typeof row.descriptionEn === "string" ? row.descriptionEn : null,
      descriptionRu: row.descriptionRu === undefined || row.descriptionRu === null
        ? null
        : typeof row.descriptionRu === "string" ? row.descriptionRu : null,
      imageUrl: safeAchievementImageUrl(row.imageUrl),
      side: row.side,
      rarity: row.rarity,
      playersCompletedPercent: percentage(row.playersCompletedPercent, `achievement ${row.id}.playersCompletedPercent`),
      adjustedPlayersCompletedPercent: percentage(row.adjustedPlayersCompletedPercent, `achievement ${row.id}.adjustedPlayersCompletedPercent`),
    });
  }
  // v1 caches written before descriptions/images were added remain valid
  // outage fallbacks, but must refresh on the next healthy request.
  return { data, ts: hasLegacyEntry ? 0 : root.savedAt };
}

async function readPersistedAchievements(mode: AchievementMode): Promise<AchievementCache | null> {
  try {
    const fs = await import("node:fs/promises" as string) as {
      readFile(file: string, encoding: "utf8"): Promise<string>;
    };
    const payload = JSON.parse(await fs.readFile(achievementCacheFile(mode), "utf8"));
    return parsePersistedAchievements(payload, mode);
  } catch {
    return null;
  }
}

async function writePersistedAchievements(mode: AchievementMode, cache: AchievementCache): Promise<void> {
  const file = achievementCacheFile(mode);
  let temporary = "";
  try {
    const fs = await import("node:fs/promises" as string) as {
      mkdir(directory: string, options: { recursive: true }): Promise<void>;
      writeFile(file: string, data: string, options: { encoding: "utf8"; mode: number }): Promise<void>;
      rename(oldPath: string, newPath: string): Promise<void>;
      unlink(file: string): Promise<void>;
    };
    const path = await import("node:path" as string) as { dirname(file: string): string };
    temporary = `${file}.${Date.now()}.tmp`;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(temporary, JSON.stringify({
      version: 1,
      mode,
      savedAt: cache.ts,
      entries: [...cache.data.values()],
    }), { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporary, file);
  } catch (error) {
    if (temporary) {
      try {
        const fs = await import("node:fs/promises" as string) as { unlink(file: string): Promise<void> };
        await fs.unlink(temporary);
      } catch {
        // Best-effort cleanup only; persistence is an optimization.
      }
    }
    console.warn("tarkov reference cache write failed", {
      reference: "achievements",
      mode,
      error: error instanceof Error ? error.message : "unknown",
    });
  }
}

/** Return fresh in-process achievement metadata without starting a network request. */
export function getCachedAchievements(mode: AchievementMode = "regular"): Map<string, AchievementMeta> | null {
  const cached = achievementsCache.get(mode);
  if (!cached || Date.now() - cached.ts >= ACHIEVEMENTS_TTL_MS) return null;
  return cached.data;
}

function percentage(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error(`${field} must be a percentage`);
  }
  return value;
}

function achievementTranslations(payload: unknown, language: "en" | "ru"): Record<string, string> {
  const data = record(record(payload)?.data);
  if (!data) throw new Error(`tasks_${language}.data must be an object`);
  const translations: Record<string, string> = {};
  let usable = 0;
  for (const [key, value] of Object.entries(data)) {
    if (typeof value !== "string") throw new Error(`tasks_${language}.data.${key} must be a string`);
    translations[key] = value;
    if (value.trim() !== "") usable += 1;
  }
  if (usable === 0) throw new Error(`tasks_${language}.data must contain translations`);
  return translations;
}

/** Converts the JSON API achievement object into the existing metadata Map. */
export function parseAchievements(
  payload: unknown,
  translationsPayload?: unknown,
  russianTranslationsPayload?: unknown,
): Map<string, AchievementMeta> {
  const achievements = record(record(record(payload)?.data)?.achievements);
  if (!achievements || Object.keys(achievements).length === 0) {
    throw new Error("tasks.data.achievements must be a non-empty object");
  }
  const translations = translationsPayload === undefined
    ? {}
    : achievementTranslations(translationsPayload, "en");
  const russianTranslations = russianTranslationsPayload === undefined
    ? {}
    : achievementTranslations(russianTranslationsPayload, "ru");
  const result = new Map<string, AchievementMeta>();
  for (const [key, value] of Object.entries(achievements)) {
    const row = record(value);
    if (!row || typeof row.id !== "string" || row.id !== key) {
      throw new Error(`achievement ${key} has an invalid id`);
    }
    const translationKey = typeof row.name === "string" ? row.name : "";
    const translated = translations[translationKey]?.trim();
    const translatedRu = russianTranslations[translationKey]?.trim();
    const descriptionKey = typeof row.description === "string" ? row.description : "";
    const translatedDescription = translations[descriptionKey]?.trim() || null;
    const translatedDescriptionRu = russianTranslations[descriptionKey]?.trim() || null;
    const normalizedName = typeof row.normalizedName === "string"
      ? row.normalizedName.trim()
      : "";
    const rarity = row.normalizedRarity;
    if (rarity !== "common" && rarity !== "rare" && rarity !== "legendary" && rarity !== "seasonal") {
      throw new Error(`achievement ${key} has an invalid normalizedRarity`);
    }
    result.set(key, {
      id: key,
      name: translated || normalizedName || key,
      nameEn: translated || normalizedName || key,
      nameRu: translatedRu || null,
      descriptionEn: translatedDescription,
      descriptionRu: translatedDescriptionRu,
      imageUrl: safeAchievementImageUrl(row.imageLink),
      side: typeof row.side === "string" ? row.side : "",
      rarity,
      playersCompletedPercent: percentage(
        row.playersCompletedPercent,
        `achievement ${key}.playersCompletedPercent`
      ),
      adjustedPlayersCompletedPercent: percentage(
        row.adjustedPlayersCompletedPercent,
        `achievement ${key}.adjustedPlayersCompletedPercent`
      ),
    });
  }
  return result;
}

/** Achievement id -> metadata, cached in-isolate. Rarely changes (per wipe). */
export async function getAchievements(mode: AchievementMode = "regular"): Promise<Map<string, AchievementMeta>> {
  const now = Date.now();
  const cached = getCachedAchievements(mode);
  if (cached) {
    console.info("tarkov reference", { reference: "achievements", mode, source: "memory-cache" });
    return cached;
  }
  // A stale disk snapshot is still a better fallback than raw IDs. A fresh
  // snapshot can be returned immediately and avoids an unnecessary upstream
  // hit after a normal container restart.
  const persisted = await readPersistedAchievements(mode);
  if (persisted && now - persisted.ts < ACHIEVEMENTS_TTL_MS) {
    achievementsCache.set(mode, persisted);
    console.info("tarkov reference", { reference: "achievements", mode, source: "persistent-cache" });
    return persisted.data;
  }
  const endpoints = ACHIEVEMENT_ENDPOINTS[mode];
  let tasks: unknown;
  try {
    const response = await fetchTarkovJson(endpoints.tasks, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    tasks = await response.json();
  } catch (error) {
    console.error("tarkov reference validation failed", {
      reference: "achievements",
      mode,
      error: error instanceof Error ? error.message : "unknown",
    });
    const cachedFallback = achievementsCache.get(mode);
    const fallback = cachedFallback?.data ?? persisted?.data ?? new Map();
    console.info("tarkov reference", {
      reference: "achievements",
      mode,
      source: cachedFallback ? "memory-cache" : persisted ? "persistent-cache" : "local-fallback",
    });
    return fallback;
  }

  try {
    const response = await fetchTarkovJson(endpoints.english, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const english = await response.json();
    let russian: unknown;
    try {
      const russianResponse = await fetchTarkovJson(endpoints.russian, { cache: "no-store" });
      if (russianResponse.ok) russian = await russianResponse.json();
    } catch (error) {
      console.warn("tarkov reference validation failed", {
        reference: "achievements-ru-translations",
        mode,
        error: error instanceof Error ? error.message : "unknown",
      });
    }
    const map = parseAchievements(tasks, english, russian);
    const cache = { data: map, ts: now };
    achievementsCache.set(mode, cache);
    await writePersistedAchievements(mode, cache);
    console.info("tarkov reference", { reference: "achievements", mode, source: "json" });
    return map;
  } catch (error) {
    console.error("tarkov reference validation failed", {
      reference: "achievements-translations",
      mode,
      error: error instanceof Error ? error.message : "unknown",
    });
    const cachedAfterError = achievementsCache.get(mode) ?? persisted;
    if (cachedAfterError) {
      console.info("tarkov reference", {
        reference: "achievements",
        mode,
        source: achievementsCache.has(mode) ? "memory-cache" : "persistent-cache",
      });
      return cachedAfterError.data;
    }
    try {
      const fallback = parseAchievements(tasks);
      console.info("tarkov reference", { reference: "achievements", mode, source: "local-fallback" });
      return fallback;
    } catch (tasksError) {
      console.error("tarkov reference validation failed", {
        reference: "achievements",
        mode,
        error: tasksError instanceof Error ? tasksError.message : "unknown",
      });
      console.info("tarkov reference", { reference: "achievements", mode, source: "local-fallback" });
      return new Map();
    }
  }
}

/** Handbook mastery thresholds and display names, cached for the isolate. */
export async function getWeaponMastery(): Promise<WeaponMasteryReference[]> {
  const now = Date.now();
  if (masteryCache && now - masteryCache.ts < MASTERY_TTL_MS) {
    console.info("tarkov reference", { reference: "mastering", source: "memory-cache" });
    return masteryCache.data;
  }
  try {
    const response = await fetchTarkovJson(ITEMS_URL, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = parseWeaponMastery(await response.json());
    masteryCache = { data, ts: now };
    console.info("tarkov reference", { reference: "mastering", source: "json" });
    return data;
  } catch (error) {
    console.error("tarkov reference validation failed", {
      reference: "mastering",
      error: error instanceof Error ? error.message : "unknown",
    });
    return masteryCache?.data ?? [];
  }
}

function getCounterValue(
  items: { Key: string[]; Value: number }[],
  ...keys: string[]
): number {
  const entry = items.find(
    (item) =>
      item.Key.length === keys.length &&
      keys.every((k, i) => item.Key[i] === k)
  );
  // Values come from untrusted external JSON — coerce and reject non-finite.
  const v = Number(entry?.Value);
  return Number.isFinite(v) ? v : 0;
}

function hasCounter(
  items: { Key: string[]; Value: number }[],
  ...keys: string[]
): boolean {
  return items.some(
    (item) =>
      item.Key.length === keys.length &&
      keys.every((key, index) => item.Key[index] === key)
  );
}

const round = (n: number, d = 2) => {
  const f = 10 ** d;
  return Math.round(n * f) / f;
};

export const PVE_SKILL_CUTOFF_SECONDS = Date.parse("2025-11-15T00:00:00+03:00") / 1000;
export type PveProfileDecision =
  | { state: "store"; lastSkillAccess: number }
  | { state: "skipped_before_cutoff"; lastSkillAccess: number }
  | { state: "skipped_missing_skill_date"; lastSkillAccess: null };

export function lastSkillAccessSeconds(profile: PlayerProfile): number | null {
  const accesses = (profile.skills?.Common ?? [])
    .filter((skill) => Number(skill.Progress) > 0)
    .map((skill) => Number(skill.LastAccess))
    .filter((value) => Number.isFinite(value) && value > 0);
  return accesses.length > 0 ? Math.max(...accesses) : null;
}

export function pveProfileDecision(profile: PlayerProfile): PveProfileDecision {
  const lastSkillAccess = lastSkillAccessSeconds(profile);
  if (lastSkillAccess === null) {
    return { state: "skipped_missing_skill_date", lastSkillAccess: null };
  }
  return {
    state: lastSkillAccess >= PVE_SKILL_CUTOFF_SECONDS ? "store" : "skipped_before_cutoff",
    lastSkillAccess,
  };
}

function arenaCounterValue(group: ArenaCounterGroup | undefined, key: string): number | null {
  const counters = group?.Counters;
  if (!counters) return null;
  const valid = (value: unknown): number | null => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
    return key === "DamageDealt" || Number.isSafeInteger(value) ? value : null;
  };
  const fromItems = (items: ArenaCounterItem[]) => {
    const item = items.find(
      ({ Key }) => Key === key || (Array.isArray(Key) && Key.length === 1 && Key[0] === key)
    );
    return item ? valid(item.Value) : null;
  };
  if (Array.isArray(counters)) return fromItems(counters);
  if (typeof counters !== "object") return null;
  const items = (counters as { Items?: unknown }).Items;
  if (Array.isArray(items)) return fromItems(items as ArenaCounterItem[]);
  return valid((counters as Record<string, unknown>)[key]);
}

function arenaCounter(group: ArenaCounterGroup | undefined, key: string): number {
  return arenaCounterValue(group, key) ?? 0;
}

const ARENA_MODES: readonly [ArenaModeKey, string][] = [
  ["teamFight", "UnrankedTeamFight"],
  ["lastHero", "UnrankedLastHero"],
  ["checkpoint", "UnrankedCheckPoint"],
  ["blastGang", "UnrankedBlastGang"],
  ["shootOutDuo", "UnrankedShootOutDuo"],
];

const ARENA_COUNTER_KEYS = [
  "matches",
  "wins",
  "losses",
  "kills",
  "deaths",
  "assists",
  "headshots",
  "damage",
  "round_mvp",
  "match_mvp",
  "current_kill_streak",
  "max_kill_streak",
  "current_win_streak",
  "max_win_streak",
  "current_loss_streak",
  "max_loss_streak",
] as const satisfies readonly (keyof ArenaCounters)[];

const ARENA_ADDITIVE_COUNTER_KEYS = [
  "matches", "wins", "losses", "kills", "deaths", "assists", "headshots", "damage", "round_mvp", "match_mvp",
] as const satisfies readonly (keyof ArenaCounters)[];

const ARENA_MAX_COUNTER_KEYS = [
  "max_kill_streak", "max_win_streak", "max_loss_streak",
] as const satisfies readonly (keyof ArenaCounters)[];

function firstArenaCounter(group: ArenaCounterGroup | undefined, keys: string[]): number | null {
  for (const key of keys) {
    const value = arenaCounterValue(group, key);
    if (value !== null) return value;
  }
  return null;
}

function arenaCounters(group: ArenaCounterGroup | undefined): ArenaCounters {
  const matches = firstArenaCounter(group, ["GamesCount"]);
  const wins = firstArenaCounter(group, ["ArenaWins"]);
  const losses = firstArenaCounter(group, ["ArenaLoses"]);
  return {
    matches,
    wins,
    losses,
    kills: firstArenaCounter(group, ["Kills"]),
    deaths: firstArenaCounter(group, ["Deaths"]),
    assists: firstArenaCounter(group, ["Assists"]),
    headshots: firstArenaCounter(group, ["Headshots"]),
    damage: firstArenaCounter(group, ["DamageDealt"]),
    round_mvp: firstArenaCounter(group, ["RoundMvpCount"]),
    match_mvp: firstArenaCounter(group, ["MatchMvpCount"]),
    current_kill_streak: firstArenaCounter(group, ["KillsWithoutDeaths"]),
    max_kill_streak: firstArenaCounter(group, ["MaxKillsWithoutDeaths"]),
    current_win_streak: firstArenaCounter(group, ["WinStreak"]),
    max_win_streak: firstArenaCounter(group, ["LongestWinStreak"]),
    current_loss_streak: firstArenaCounter(group, ["LoseStreak"]),
    max_loss_streak: firstArenaCounter(group, ["LongestLoseStreak"]),
  };
}

function rate(numerator: number | null, denominator: number | null, percent = false): number | null {
  if (numerator === null || denominator === null || denominator <= 0) return null;
  const value = numerator / denominator * (percent ? 100 : 1);
  if (!Number.isFinite(value) || value < 0 || (percent && value > 100)) return null;
  return value;
}

function arenaMetrics(counters: ArenaCounters): ArenaMetrics {
  return {
    kd_ratio: rate(counters.kills, counters.deaths),
    win_rate: rate(counters.wins, counters.matches, true),
    headshot_rate: rate(counters.headshots, counters.kills, true),
    kills_per_match: rate(counters.kills, counters.matches),
    damage_per_match: rate(counters.damage, counters.matches),
  };
}

function completeCounterSum(modes: PublicArenaModeStats[], key: keyof ArenaCounters): number | null {
  const values = modes.map((mode) => mode.counters[key]);
  if (!values.every((value): value is number => value !== null)) return null;
  const sum = values.reduce((total, value) => total + value, 0);
  return Number.isFinite(sum) && sum >= 0 && (key === "damage" || Number.isSafeInteger(sum)) ? sum : null;
}

function completeCounterMax(modes: PublicArenaModeStats[], key: keyof ArenaCounters): number | null {
  const values = modes.map((mode) => mode.counters[key]);
  if (!values.every((value): value is number => value !== null)) return null;
  const max = Math.max(...values);
  return Number.isFinite(max) && max >= 0 && (key === "damage" || Number.isSafeInteger(max)) ? max : null;
}

function completeModeCounters(modes: PublicArenaModeStats[]): ArenaCounters {
  const counters = Object.fromEntries(ARENA_COUNTER_KEYS.map((key) => [key, null])) as unknown as ArenaCounters;
  for (const key of ARENA_ADDITIVE_COUNTER_KEYS) counters[key] = completeCounterSum(modes, key);
  for (const key of ARENA_MAX_COUNTER_KEYS) counters[key] = completeCounterMax(modes, key);
  return counters;
}

function completeModeOverall(modes: PublicArenaModeStats[], hours: number | null): ArenaOverallStats {
  const counters = completeModeCounters(modes);
  const complete = ARENA_ADDITIVE_COUNTER_KEYS.every((key) => counters[key] !== null);
  return {
    hours,
    counters,
    metrics: arenaMetrics(counters),
    source: complete ? "complete_mode_sum" : "unavailable",
  };
}

function overallWithFallback(
  direct: ArenaCounterGroup | undefined,
  modes: PublicArenaModeStats[],
  hours: number | null,
): ArenaOverallStats {
  const summed = completeModeCounters(modes);
  if (!direct) return completeModeOverall(modes, hours);
  const directCounters = arenaCounters(direct);
  const counters = Object.fromEntries(ARENA_COUNTER_KEYS.map((key) => [
    key,
    directCounters[key] ?? summed[key],
  ])) as unknown as ArenaCounters;
  return { hours, counters, metrics: arenaMetrics(counters), source: "upstream" };
}

/** Parses Arena's separate counter tree into the shared stored-stat envelope. */
export function parseArenaProfileStats(profile: PlayerProfile): ParsedPlayerStats {
  const counters = profile.stat?.arenaOverAllCounters;
  const modes: ArenaModeStats[] = ARENA_MODES.map(([key, upstreamKey]) => {
    const group = counters?.[upstreamKey] as ArenaCounterGroup | undefined;
    const kills = arenaCounter(group, "Kills");
    const deaths = arenaCounter(group, "Deaths");
    return {
      key,
      kills,
      deaths,
      kdRatio: round(deaths > 0 ? kills / deaths : kills),
      maxKillStreak: arenaCounter(group, "MaxKillsWithoutDeaths"),
      roundMvp: arenaCounter(group, "RoundMvpCount"),
      matchMvp: arenaCounter(group, "MatchMvpCount"),
      maxWinStreak: arenaCounter(group, "LongestWinStreak"),
    };
  });
  const totalKills = modes.reduce((sum, mode) => sum + mode.kills, 0);
  const totalDeaths = modes.reduce((sum, mode) => sum + mode.deaths, 0);
  const overall = counters?.UnrankedOverall;
  const totalInGameTime = profile.stat?.totalInGameTime;
  const validArenaTime = typeof totalInGameTime === "number" && Number.isFinite(totalInGameTime) && totalInGameTime >= 0;
  const arenaHours = validArenaTime
    ? totalInGameTime / 3600
    : null;
  const hoursPlayed = round(
    validArenaTime && totalInGameTime > 0 ? totalInGameTime / 3600 : 0,
    1
  );
  const arena = {
    currentKillStreak: arenaCounter(overall, "KillsWithoutDeaths"),
    maxKillStreak: arenaCounter(overall, "MaxKillsWithoutDeaths"),
    maxWinStreak: arenaCounter(overall, "LongestWinStreak"),
    bestArp: arenaCounter(overall, "BestArp"),
    currentLossStreak: arenaCounter(overall, "LoseStreak"),
    maxLossStreak: arenaCounter(overall, "LongestLoseStreak"),
    totalKills,
    totalDeaths,
    kdRatio: round(totalDeaths > 0 ? totalKills / totalDeaths : totalKills),
    modes,
  };
  const publicModes = Object.fromEntries(
    ARENA_MODES.map(([mode, upstreamKey]) => {
      const modeCounters = arenaCounters(counters?.[upstreamKey] as ArenaCounterGroup | undefined);
      const value: PublicArenaModeStats = {
        mode: mode as PublicArenaModeKey,
        hours: null,
        counters: modeCounters,
        metrics: arenaMetrics(modeCounters),
      };
      return [mode, value];
    })
  ) as Record<PublicArenaModeKey, PublicArenaModeStats>;
  const directOverall = counters?.UnrankedOverall;
  const publicOverall = overallWithFallback(
    directOverall,
    ARENA_MODE_KEYS.map((mode) => publicModes[mode]),
    arenaHours,
  );
  const arenaProfile: ArenaProfile = {
    aid: Number(profile.aid) || 0,
    nickname: profile.info?.nickname ?? profile.nickname ?? "Unknown",
    profileUpdatedAt: profileUpdatedAt(profile.updated) ?? 0,
    fetchedAt: null,
    parserVersion: 1,
    overall: publicOverall,
    modes: publicModes,
  };
  arenaProfile[ARENA_RAW_COUNTERS] = Object.fromEntries([
    ["overall", directOverall ?? null],
    ...ARENA_MODES.map(([mode, upstreamKey]) => [mode, counters?.[upstreamKey] ?? null]),
  ]);

  return {
    nickname: profile.info?.nickname ?? profile.nickname ?? "Unknown",
    level: 0,
    prestige: profile.info?.prestigeLevel ?? 0,
    experience: profile.info?.experience ?? profile.experience ?? 0,
    side: profile.info?.side ?? "Unknown",
    totalRaids: 0,
    pmcRaids: 0,
    scavRaids: 0,
    survivedRaids: 0,
    survivalRate: 0,
    totalKills,
    pmcKilledPmc: 0,
    killedPmc: 0,
    pvpStatsKnown: false,
    killsPerRaid: 0,
    kdRatio: arena.kdRatio,
    pmcKdRatio: 0,
    deaths: totalDeaths,
    pmcDeaths: 0,
    runThrough: 0,
    pmcSurvived: 0,
    pmcSurvivalRate: 0,
    pmcKills: 0,
    pmcKillsPerRaid: 0,
    pmcExitKilled: 0,
    pmcExitLeft: 0,
    pmcExitTransit: 0,
    pmcExitMia: 0,
    hoursPlayed,
    longestWinStreak: arena.maxWinStreak,
    achievementsCount: 0,
    registrationDate: profile.info?.registrationDate ?? 0,
    lastActiveDate: profile.info?.lastActiveDate ?? 0,
    profileUpdatedAt: profileUpdatedAt(profile.updated) ?? 0,
    avgLifespan: 0,
    totalLootValue: 0,
    arena,
    arenaProfile,
  };
}

/**
 * Parses the real public profile payload into flat stats.
 * Real schema: profile.{pmc,scav}Stats.eft.{totalInGameTime, overAllCounters.Items}
 * with counters keyed like ["Sessions","Pmc"], ["ExitStatus","Survived","Pmc"],
 * ["Deaths"], ["Kills"], ["KilledPmc"], ["LongestWinStreak","Pmc"], etc.
 */
export function parseProfileStats(
  profile: PlayerProfile,
  levels?: PlayerLevel[]
): ParsedPlayerStats {
  const pmcEft = profile.pmcStats?.eft;
  const scavEft = profile.scavStats?.eft;
  const pmcCounters = pmcEft?.overAllCounters?.Items ?? [];
  const scavCounters = scavEft?.overAllCounters?.Items ?? [];

  const pmcRaids = getCounterValue(pmcCounters, "Sessions", "Pmc");
  const scavRaids = getCounterValue(scavCounters, "Sessions", "Scav");
  const totalRaids = pmcRaids + scavRaids;

  const pmcSurvived = getCounterValue(pmcCounters, "ExitStatus", "Survived", "Pmc");
  const scavSurvived = getCounterValue(scavCounters, "ExitStatus", "Survived", "Scav");
  const survivedRaids = pmcSurvived + scavSurvived;
  const survivalRate = totalRaids > 0 ? (survivedRaids / totalRaids) * 100 : 0;

  const pmcKills = getCounterValue(pmcCounters, "Kills");
  const scavKills = getCounterValue(scavCounters, "Kills");
  const totalKills = pmcKills + scavKills;

  const pmcDeaths = getCounterValue(pmcCounters, "Deaths");
  const scavDeaths = getCounterValue(scavCounters, "Deaths");
  const deaths = pmcDeaths + scavDeaths;

  const pmcKilledPmc = getCounterValue(pmcCounters, "KilledPmc");
  const scavKilledPmc = getCounterValue(scavCounters, "KilledPmc");
  const killedPmc = pmcKilledPmc + scavKilledPmc;

  const runThrough = getCounterValue(pmcCounters, "ExitStatus", "Runner", "Pmc");

  // Full PMC raid-outcome breakdown. Survived (pmcSurvived) and Runner (runThrough)
  // are computed above; these are the remaining outcomes. Together they partition
  // every PMC session (sum ≈ pmcRaids).
  const pmcExitKilled = getCounterValue(pmcCounters, "ExitStatus", "Killed", "Pmc");
  const pmcExitLeft = getCounterValue(pmcCounters, "ExitStatus", "Left", "Pmc");
  const pmcExitTransit = getCounterValue(pmcCounters, "ExitStatus", "Transit", "Pmc");
  const pmcExitMia = getCounterValue(pmcCounters, "ExitStatus", "MissingInAction", "Pmc");

  const kdRatio = deaths > 0 ? totalKills / deaths : totalKills;
  const pmcKdRatio = pmcDeaths > 0 ? pmcKilledPmc / pmcDeaths : pmcKilledPmc;
  const killsPerRaid = totalRaids > 0 ? totalKills / totalRaids : 0;

  // PMC-only versions of survival and kills-per-raid — these feed the cheating-risk
  // score (Scav raids excluded). pmcKills is all kills made while playing PMC.
  const pmcSurvivalRate = pmcRaids > 0 ? (pmcSurvived / pmcRaids) * 100 : 0;
  const pmcKillsPerRaid = pmcRaids > 0 ? pmcKills / pmcRaids : 0;

  // totalInGameTime is an account-wide value duplicated in both pmcStats.eft and
  // scavStats.eft (same number), so we take it once rather than summing.
  const inGameSeconds = pmcEft?.totalInGameTime ?? scavEft?.totalInGameTime ?? 0;
  const hoursPlayed = inGameSeconds / 3600;
  const avgLifespan = totalRaids > 0 ? inGameSeconds / totalRaids / 60 : 0;

  const longestWinStreak = getCounterValue(pmcCounters, "LongestWinStreak", "Pmc");

  const achievementsCount = profile.achievements
    ? Object.keys(profile.achievements).length
    : 0;

  const experience = profile.info?.experience ?? profile.experience ?? 0;
  const level = levels && levels.length > 0 ? expToLevel(experience, levels) : 0;

  return {
    nickname: profile.info?.nickname ?? profile.nickname ?? "Unknown",
    level,
    prestige: profile.info?.prestigeLevel ?? 0,
    experience,
    side: profile.info?.side ?? "Unknown",
    totalRaids,
    pmcRaids,
    scavRaids,
    survivedRaids,
    survivalRate: round(survivalRate, 1),
    totalKills,
    pmcKilledPmc,
    killedPmc,
    pvpStatsKnown: hasCounter(pmcCounters, "KilledPmc"),
    killsPerRaid: round(killsPerRaid),
    kdRatio: round(kdRatio),
    pmcKdRatio: round(pmcKdRatio),
    deaths,
    pmcDeaths,
    runThrough,
    pmcSurvived,
    pmcSurvivalRate: round(pmcSurvivalRate, 1),
    pmcKills,
    pmcKillsPerRaid: round(pmcKillsPerRaid),
    pmcExitKilled,
    pmcExitLeft,
    pmcExitTransit,
    pmcExitMia,
    hoursPlayed: round(hoursPlayed, 1),
    longestWinStreak,
    achievementsCount,
    registrationDate: profile.info?.registrationDate ?? 0,
    lastActiveDate: profile.info?.lastActiveDate ?? 0,
    profileUpdatedAt: profileUpdatedAt(profile.updated) ?? 0,
    lastPlayedAt: (lastSkillAccessSeconds(profile) ?? 0) * 1000,
    avgLifespan: round(avgLifespan, 1),
    totalLootValue: 0,
    weaponMastery: normalizeWeaponMastery(profile.skills?.Mastering),
  };
}
