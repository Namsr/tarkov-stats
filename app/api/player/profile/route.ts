import { after, NextRequest, NextResponse } from "next/server";
import {
  getPublicProfile,
  PLAYER_LEVELS_V2026_07_22,
  getAchievements,
  getWeaponMastery,
  safeAchievementImageUrl,
  parseProfileStats,
  pveProfileDecision,
  needsPvpStatsParserRefresh,
} from "@/lib/tarkov-api";
import { getRateLimitHeaders } from "@/lib/rate-limiter";
import { getClientIp } from "@/lib/client-ip";
import { parsePlayerId } from "@/lib/player-id";
import { getStore, type AchievementBaseline } from "@/lib/db";
import { isGameMode, normalizeCycleId } from "@/types/seasonal";
import { resolveSeasonalProfile } from "@/lib/seasonal/profile-service";
import { getSeasonalStore } from "@/lib/seasonal/storage";
import { getPublishedSeasonalAchievementBaseline } from "@/lib/seasonal/progression-db";
import { seasonalRiskMatchesIdentity } from "@/lib/seasonal/average-db";
import { isSeasonalRolloutReady, loadSeasonalCycleConfig } from "@/lib/seasonal/config";
import { validateSeasonalProfile } from "@/lib/seasonal-upstream";
import { fetchSeasonalPayload } from "@/lib/seasonal/fetch";
import { recordSeasonalCaptureLifecycle } from "@/lib/seasonal/scanner";
import type { PlayerProfile } from "@/types/tarkov";
import { createRequestTiming } from "@/lib/observability/request-timing";
import { findProfileSummary } from "@/lib/profile-summary";
import { makePlayerSnapshot } from "@/lib/ban-db";
import { persistRegularProfileSnapshot } from "@/lib/regular-profile-capture";
import { getProgressionStore } from "@/lib/progression-db";
import { progressionFlightKey, singleFlight } from "@/lib/seasonal/progression-flight";
import {
  evaluateAndStoreRisk,
  evaluateAndStoreSeasonalRisk,
  riskScoreVersion,
} from "@/lib/admin/risk-service";
import { getRiskEvaluation } from "@/lib/admin/moderation-db";
import { buildWeaponMasteryRows } from "@/lib/profile-mastery";
import {
  buildPersistentProfileViewModel,
  buildRegularProfileViewModel,
  buildSeasonalProfileViewModel,
  toPublicRiskView,
} from "@/lib/player-profile-view";
import {
  buildPersistentComparisonStats,
  buildRegularComparisonStats,
  buildSeasonalComparisonStats,
} from "@/lib/profile-comparison";
import { getArenaProfile, getArenaProfileRisk, getStoredArenaProfileRisk, isArenaProfileRiskFresh, persistArenaProfile } from "@/lib/arena/service";
import { rateArena } from "@/lib/arena/ts-rating";
import { arenaTsReference } from "@/lib/arena/ts-rating-reference";

export const runtime = "nodejs";

const PERSISTENT_ACHIEVEMENT_BASELINE_TTL_MS = 60_000;
type PersistentMode = "regular" | "pve";
type ArenaLegacySnapshot = Awaited<ReturnType<NonNullable<Awaited<ReturnType<typeof getStore>>>["stored"]>>;
const persistentAchievementBaselineCache = new Map<PersistentMode, {
  value: AchievementBaseline | null;
  expiresAt: number;
}>();
const persistentAchievementBaselineInFlight = new Map<
  PersistentMode,
  Promise<AchievementBaseline | null>
>();
const regularBackgroundRefreshes = new Map<string, Promise<void>>();
const arenaRiskRefreshes = new Map<number, Promise<void>>();
const STORED_PROFILE_REFRESH_MS = 5 * 60_000;

async function refreshStoredArenaRisk(aid: number): Promise<void> {
  return singleFlight(arenaRiskRefreshes, aid, async () => {
    try {
      await getArenaProfileRisk(aid);
    } catch (error) {
      console.error("Arena risk background refresh failed", error);
    }
  });
}

async function refreshStoredRegularProfile(aid: number): Promise<void> {
  const key = progressionFlightKey("regular", "persistent", aid);
  return singleFlight(regularBackgroundRefreshes, key, async () => {
    try {
      const result = await getPublicProfile(aid, { force: true });
      if (!result.profile) return;
      const stats = parseProfileStats(result.profile, [...PLAYER_LEVELS_V2026_07_22]);
      const achievementIds = Object.keys(result.profile.achievements ?? {});
      await persistRegularProfileSnapshot(
        makePlayerSnapshot(aid, stats, achievementIds, Number(stats.profileUpdatedAt)),
        { upsertPlayer: !(result.fromCache || result.fromEdgeCache), strict: true },
      );
    } catch (error) {
      console.error("regular stored profile background refresh failed", error);
    }
  });
}

async function refreshStoredPveProfile(aid: number): Promise<void> {
  const key = progressionFlightKey("pve", "persistent", aid);
  return singleFlight(regularBackgroundRefreshes, key, async () => {
    try {
      const { profile } = await getPublicProfile(aid, { force: true, mode: "pve" });
      if (!profile || pveProfileDecision(profile).state !== "store") return;
      const stats = parseProfileStats(profile, [...PLAYER_LEVELS_V2026_07_22]);
      const achievementIds = Object.keys(profile.achievements ?? {});
      await persistRegularProfileSnapshot(
        makePlayerSnapshot(aid, stats, achievementIds, Number(stats.profileUpdatedAt)),
        { mode: "pve", strict: true },
      );
    } catch (error) {
      console.error("pve stored profile background refresh failed", error);
    }
  });
}

async function loadPersistentAchievementBaseline(mode: PersistentMode): Promise<AchievementBaseline | null> {
  const now = Date.now();
  const cached = persistentAchievementBaselineCache.get(mode);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }
  const inFlight = persistentAchievementBaselineInFlight.get(mode);
  if (inFlight) return inFlight;

  const request = (async () => {
    try {
      const store = await getStore(mode);
      return store ? await store.achievementBaseline() : null;
    } catch {
      return null;
    }
  })();
  persistentAchievementBaselineInFlight.set(mode, request);

  try {
    const baseline = await request;
    persistentAchievementBaselineCache.set(mode, {
      value: baseline,
      expiresAt: Date.now() + PERSISTENT_ACHIEVEMENT_BASELINE_TTL_MS,
    });
    return baseline;
  } finally {
    if (persistentAchievementBaselineInFlight.get(mode) === request) {
      persistentAchievementBaselineInFlight.delete(mode);
    }
  }
}

type ProfileEnrichmentPhases = { baselineMs?: number; metadataMs?: number; masteryMs?: number };

async function timedEnrichmentPhase<T>(
  phases: ProfileEnrichmentPhases | undefined,
  key: keyof ProfileEnrichmentPhases,
  load: () => Promise<T>,
): Promise<T> {
  const started = performance.now();
  try {
    return await load();
  } finally {
    if (phases) phases[key] = Math.max(0, Math.round(performance.now() - started));
  }
}

async function enrichSeasonalViewModel(
  profile: import("@/types/seasonal").SeasonalProfile,
  viewModel: ReturnType<typeof buildSeasonalProfileViewModel>,
  phases?: ProfileEnrichmentPhases,
) {
  const [baseline, metadata, masteryReferences] = await Promise.all([
    timedEnrichmentPhase(phases, "baselineMs", () => getPublishedSeasonalAchievementBaseline(profile.cycleId)),
    timedEnrichmentPhase(phases, "metadataMs", () => getAchievements("seasonal").catch(() => new Map())),
    viewModel.mastering.items.length > 0
      ? timedEnrichmentPhase(phases, "masteryMs", () => getWeaponMastery({ staleOnly: true }))
      : Promise.resolve([]),
  ]);
  const baselineById = new Map((baseline?.achievements ?? []).map((entry) => [entry.id, entry]));
  const achievements = (viewModel.seasonalAchievements ?? []).map((achievement) => {
    const meta = metadata.get(achievement.id);
    const row = baselineById.get(achievement.id);
    const eligibleN = baseline?.eligibleN ?? null;
    return {
      ...achievement,
      name: meta?.nameEn ?? meta?.name ?? achievement.name ?? achievement.id,
      nameRu: meta?.nameRu ?? achievement.nameRu ?? null,
      rarity: meta?.rarity ?? achievement.rarity ?? "common",
      owners: row?.owners ?? null,
      eligibleN,
      description: meta?.descriptionEn ?? achievement.description ?? null,
      descriptionRu: meta?.descriptionRu ?? achievement.descriptionRu ?? null,
      imageUrl: safeAchievementImageUrl(meta?.imageUrl ?? achievement.imageUrl),
      percentage: row && eligibleN !== null && eligibleN >= 30 ? row.samplePct : null,
      officialPercentage: meta?.adjustedPlayersCompletedPercent
        ?? meta?.playersCompletedPercent
        ?? null,
    };
  });
  return {
    ...viewModel,
    achievements: { items: achievements },
    seasonalAchievements: achievements,
    skills: { ...viewModel.skills, achievements },
    mastering: { items: buildWeaponMasteryRows(viewModel.mastering.items, masteryReferences) },
  };
}

async function enrichPersistentViewModel(
  mode: PersistentMode,
  viewModel: ReturnType<typeof buildPersistentProfileViewModel>,
  phases?: ProfileEnrichmentPhases,
) {
  const [baseline, metadata, masteryReferences] = await Promise.all([
    timedEnrichmentPhase(phases, "baselineMs", () => loadPersistentAchievementBaseline(mode)),
    // Achievement definitions are shared. Ownership stays in the mode store.
    timedEnrichmentPhase(phases, "metadataMs", () => getAchievements("regular").catch(() => new Map())),
    viewModel.mastering.items.length > 0
      ? timedEnrichmentPhase(phases, "masteryMs", () => getWeaponMastery({ staleOnly: true }))
      : Promise.resolve([]),
  ]);
  const baselineById = new Map((baseline?.achievements ?? []).map((entry) => [entry.ach_id, entry]));
  const eligibleN = baseline?.total ?? null;
  const achievements = viewModel.achievements.items.map((achievement) => {
    const meta = metadata.get(achievement.id);
    const row = baselineById.get(achievement.id);
    return {
      ...achievement,
      name: meta?.nameEn ?? meta?.name ?? achievement.name ?? achievement.id,
      nameRu: meta?.nameRu ?? achievement.nameRu ?? null,
      description: meta?.descriptionEn ?? achievement.description ?? null,
      descriptionRu: meta?.descriptionRu ?? achievement.descriptionRu ?? null,
      imageUrl: safeAchievementImageUrl(meta?.imageUrl ?? achievement.imageUrl),
      rarity: meta?.rarity ?? achievement.rarity ?? "common",
      owners: row?.owners ?? null,
      eligibleN,
      percentage: row && eligibleN !== null && eligibleN >= 30 ? row.owners / eligibleN * 100 : null,
      officialPercentage: meta?.adjustedPlayersCompletedPercent
        ?? meta?.playersCompletedPercent
        ?? null,
    };
  });
  return {
    ...viewModel,
    achievements: { items: achievements },
    skills: { ...viewModel.skills, achievements },
    mastering: { items: buildWeaponMasteryRows(viewModel.mastering.items, masteryReferences) },
  };
}

async function enrichRegularViewModel(
  viewModel: ReturnType<typeof buildRegularProfileViewModel>,
  phases?: ProfileEnrichmentPhases,
) {
  return enrichPersistentViewModel("regular", viewModel, phases);
}

async function arenaProfileResponse(input: {
  aid: number;
  cycleId: string;
  force: boolean;
  profileHeaders: HeadersInit;
  noStore: HeadersInit;
  timing: ReturnType<typeof createRequestTiming>;
}) {
  const { aid, cycleId, force, profileHeaders, noStore, timing } = input;
  let source: "stored" | "upstream" | "cache" = "stored";
  let profile: PlayerProfile | null = null;
  let capture = { inserted: false, status: "stored" };
  let profileMs: number | undefined;
  let storeReadMs: number | undefined;
  let riskMs: number | undefined;
  let stored: Awaited<ReturnType<typeof getArenaProfile>> = null;
  let legacy: ArenaLegacySnapshot = null;
  const scheduleArenaRiskRefresh = () => {
    try {
      // `after()` already runs outside the critical response path, so no
      // artificial delay is needed (serverless does not guarantee +1s life).
      // `refreshStoredArenaRisk` coalesces concurrent refreshes per aid.
      after(() => refreshStoredArenaRisk(aid));
    } catch {
      // `after()` is unavailable outside a request scope (unit tests). The
      // stored response must stay fast regardless.
    }
  };
  const legacyResponse = (snapshot: NonNullable<ArenaLegacySnapshot>) => {
    timing.setRequestContext({ nickname: snapshot.stats.nickname });
    timing.finish({
      operation: "player_profile", mode: "arena", outcome: "success", status: 200, force,
      source: "stored", cache: "hit", storage: "sqlite", profileMs, storeReadMs, riskMs,
    });
    return NextResponse.json({
      profile: null,
      stats: snapshot.stats,
      achievementIds: snapshot.achievementIds,
      arena: null,
      arenaStatus: "legacy_incomplete",
      risk: null,
      identity: { aid, mode: "arena", cycleId },
      profileUpdatedAt: Number(snapshot.stats.profileUpdatedAt) || null,
      capture: { inserted: false, status: "legacy_incomplete" },
      freshness: {
        fetchedAt: snapshot.capturedAt,
        profileUpdatedAt: Number(snapshot.stats.profileUpdatedAt) || null,
      },
    }, { headers: force ? noStore : profileHeaders });
  };

  try {
    const storeReadStarted = timing.now();
    stored = await getArenaProfile(aid);
    storeReadMs = timing.elapsedMs(storeReadStarted);
    if (!stored) {
      const store = await getStore("arena");
      legacy = store ? await store.stored(aid) : null;
      // A legacy row cannot fill the normalized Arena DTO, but it remains a
      // useful display snapshot until the collector (or an explicit refresh)
      // reparses it. Never make this non-forced read wait on upstream.
      if (legacy && !force) return legacyResponse(legacy);
    }
    if (force || !stored) {
      const started = timing.now();
      const fetched = await getPublicProfile(aid, { force, mode: "arena" });
      profileMs = timing.elapsedMs(started);
      profile = fetched.profile;
      source = fetched.fromCache || fetched.fromEdgeCache ? "cache" : "upstream";
      if (profile) {
        await persistArenaProfile(profile);
        const rereadStarted = timing.now();
        stored = await getArenaProfile(aid);
        storeReadMs = timing.elapsedMs(rereadStarted);
        if (!stored) throw new Error("Arena profile was not stored");
        capture = { inserted: !fetched.fromCache && !fetched.fromEdgeCache, status: "updated" };
      }
    }
    if (!stored) {
      if (legacy) return legacyResponse(legacy);
      timing.finish({ operation: "player_profile", mode: "arena", outcome: "not_found", status: 404, force, source, profileMs, storeReadMs, riskMs });
      return NextResponse.json({
        identity: { aid, mode: "arena", cycleId },
        code: "mode_profile_unavailable",
        error: "Arena profile is not available in the public cache",
      }, { status: 404, headers: noStore });
    }
    // Stored cache hits reuse the saved risk row. A full cohort recomputation
    // runs only for fresh fetches or as a background refresh outside the
    // critical response path.
    let risk: Awaited<ReturnType<typeof getStoredArenaProfileRisk>> = null;
    const isStoredHit = !force && source === "stored";
    if (isStoredHit) {
      const riskStarted = timing.now();
      try {
        risk = await getStoredArenaProfileRisk(aid).catch(() => null);
      } catch (error) {
        console.error("Arena display risk failed", error);
        risk = null;
      } finally {
        riskMs = timing.elapsedMs(riskStarted);
      }
      if (!isArenaProfileRiskFresh(risk, stored.profileUpdatedAt)) {
        risk = null;
        scheduleArenaRiskRefresh();
      }
    } else {
      const riskStarted = timing.now();
      try {
        risk = await getArenaProfileRisk(aid);
      } catch (error) {
        console.error("Arena display risk failed", error);
        risk = null;
      } finally {
        riskMs = timing.elapsedMs(riskStarted);
      }
    }
    timing.setRequestContext({ nickname: stored.nickname });
    timing.finish({
      operation: "player_profile", mode: "arena", outcome: "success", status: 200, force, source,
      cache: force ? "bypass" : source === "stored" ? "hit" : source === "cache" ? "hit" : "miss",
      storage: "sqlite", profileMs, storeReadMs, riskMs,
    });
    return NextResponse.json({
      profile,
      arena: stored,
      tsRating: rateArena(stored, arenaTsReference),
      risk,
      identity: { aid, mode: "arena", cycleId },
      profileUpdatedAt: stored.profileUpdatedAt || null,
      capture,
      freshness: {
        fetchedAt: stored.fetchedAt,
        profileUpdatedAt: stored.profileUpdatedAt || null,
      },
    }, { headers: profileHeaders });
  } catch (error) {
    console.error("Arena profile load failed", error);
    if (stored) {
      const riskStarted = timing.now();
      const risk = await getStoredArenaProfileRisk(aid).catch(() => null);
      riskMs = timing.elapsedMs(riskStarted);
      timing.setRequestContext({ nickname: stored.nickname });
      timing.finish({
        operation: "player_profile", mode: "arena", outcome: "success", status: 200, force,
        source: "stored", cache: "hit", storage: "sqlite", profileMs, storeReadMs, riskMs,
      });
      return NextResponse.json({
        profile: null,
        arena: stored,
        tsRating: rateArena(stored, arenaTsReference),
        risk,
        identity: { aid, mode: "arena", cycleId },
        profileUpdatedAt: stored.profileUpdatedAt || null,
        capture: { inserted: false, status: "refresh_failed" },
        freshness: {
          fetchedAt: stored.fetchedAt,
          profileUpdatedAt: stored.profileUpdatedAt || null,
        },
      }, { headers: noStore });
    }
    if (legacy) return legacyResponse(legacy);
    timing.finish({ operation: "player_profile", mode: "arena", outcome: "error", status: 503, force, source, profileMs, storeReadMs, riskMs });
    return NextResponse.json({ error: "Failed to load Arena profile", identity: { aid, mode: "arena", cycleId } }, {
      status: 503,
      headers: noStore,
    });
  }
}

export async function GET(request: NextRequest) {
  const timing = createRequestTiming();
  const ip = getClientIp(request);
  const aid = parsePlayerId(request.nextUrl.searchParams.get("aid") ?? "");
  const rawMode = request.nextUrl.searchParams.get("mode");
  const mode = rawMode === null || rawMode === "" ? "regular" : rawMode;
  timing.setRequestContext({
    aid: aid ?? undefined,
    host: request.headers.get("x-forwarded-host") ?? request.headers.get("host"),
  });

  // Строгий лимит: роут делает upstream-fetch к tarkov.dev и пишет строку в БД
  // (датасет /average), поэтому жёстче общего лимита.
  const { allowed, headers } = getRateLimitHeaders(ip, { bucket: "profile", max: 10 });
  // Профиль не кэшируем у браузера/CDN — иначе «Обновить»/F5 показывал бы старое.
  const noStore = { ...headers, "Cache-Control": "no-store" };
  if (!allowed) {
    timing.finish({
      operation: "player_profile", outcome: "rate_limited", status: 429,
      ...(isGameMode(mode) ? { mode } : {}),
    });
    return NextResponse.json(
      { error: "Rate limit exceeded" },
      { status: 429, headers: noStore }
    );
  }

  if (aid === null) {
    timing.finish({ operation: "player_profile", outcome: "invalid", status: 400 });
    return NextResponse.json(
      { error: "Invalid account ID. Paste a numeric id or a tarkov.dev profile link." },
      { status: 400, headers: noStore }
    );
  }

  if (!isGameMode(mode)) {
    timing.finish({ operation: "player_profile", outcome: "invalid", status: 400 });
    return NextResponse.json({ error: "Invalid game mode" }, { status: 400, headers: noStore });
  }
  const cycleId = normalizeCycleId(request.nextUrl.searchParams.get("cycle"), mode);
  if (cycleId === null) {
    timing.finish({ operation: "player_profile", mode, outcome: "invalid", status: 400 });
    return NextResponse.json({ error: "Invalid or missing cycle" }, { status: 400, headers: noStore });
  }

  timing.setRequestContext({ cycleId });

  // ?refresh=1 (кнопка «Обновить» / перезагрузка) обходит наш 5-мин in-process кэш.
  const force = request.nextUrl.searchParams.get("refresh") === "1";
  const allowStaleRisk = request.nextUrl.searchParams.get("allowStaleRisk") === "1";
  const profileHeaders = force
    ? noStore
    : {
        ...headers,
        "Cache-Control": "public, max-age=60, stale-while-revalidate=300",
      };

  if (mode === "seasonal") {
    if (!isSeasonalRolloutReady()) {
      timing.finish({ operation: "player_profile", mode, outcome: "unavailable", status: 404 });
      return NextResponse.json({
        identity: { aid, mode, cycleId },
        error: "Seasonal profile unavailable",
      }, { status: 404, headers: noStore });
    }
    const seasonalStarted = timing.now();
    const enrichmentPhases: ProfileEnrichmentPhases = {};
    const result = await resolveSeasonalProfile(
      { aid, cycleId, force },
      {
        loadCycle: loadSeasonalCycleConfig,
        validatePayload: (payload, cycle) =>
          validateSeasonalProfile(payload, {
            enabled: cycle.enabled,
            confirmedContract: cycle.upstreamContract,
            cycleId: cycle.cycleId,
            seasonStartsAt: cycle.startsAt,
            seasonEndsAt: cycle.endsAt,
          }),
        getStore: getSeasonalStore,
        fetchPayload: ({ aid: seasonalAid, force: shouldForce }) =>
          fetchSeasonalPayload(seasonalAid, { force: shouldForce }),
        afterCapture: async ({ cycle, profile, capture, observedAt }) => {
          // Queue capture bookkeeping after the profile response. It updates
          // scanner state, not the profile payload needed for first paint.
          after(() => recordSeasonalCaptureLifecycle(cycle, profile, capture, "profile_open", observedAt).catch((error) => {
            console.error("seasonal profile-open lifecycle failed", error);
          }));
        },
      }
    );
    const storedRisk = result.ok
      ? await getRiskEvaluation({ aid, mode: "seasonal", cycleId }).catch(() => null)
      : null;
    const currentStoredRisk = seasonalRiskMatchesIdentity(storedRisk, { aid, cycleId })
      ? storedRisk
      : null;
    const seasonalRiskIsCurrent = result.ok && currentStoredRisk !== null;
    const seasonalRiskIsFresh = seasonalRiskIsCurrent && currentStoredRisk !== null &&
      currentStoredRisk.scoreVersion === riskScoreVersion("seasonal", cycleId) &&
      currentStoredRisk.profileUpdatedAt >= result.profile.profileUpdatedAt &&
      Date.now() - currentStoredRisk.evaluatedAt < 5 * 60 * 60 * 1000;
    if (result.ok && !seasonalRiskIsFresh) {
      after(async () => {
        // Keep a stale population-wide scan behind an immediate mode switch.
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        await evaluateAndStoreSeasonalRisk(result.profile).catch((error) => {
          console.error("seasonal admin risk evaluation failed", error);
        });
      });
    }
    const publicRisk = seasonalRiskIsCurrent && currentStoredRisk !== null &&
      (currentStoredRisk.scoreVersion === riskScoreVersion("seasonal", cycleId) || allowStaleRisk)
      ? toPublicRiskView(currentStoredRisk, { aid, mode: "seasonal", cycleId })
      : null;
    const enrichedSeasonalViewModel = result.ok
      ? await enrichSeasonalViewModel(
          result.profile,
          buildSeasonalProfileViewModel({ profile: result.profile }, publicRisk),
          enrichmentPhases,
        )
      : null;
    const response = NextResponse.json(
      result.ok
        ? {
            profile: result.profile,
            capture: result.capture,
            identity: { aid, mode, cycleId },
            risk: publicRisk,
            comparisonStats: buildSeasonalComparisonStats(result.profile),
            viewModel: enrichedSeasonalViewModel,
          }
        : result.status === 404
          ? { identity: { aid, mode, cycleId }, code: "mode_profile_unavailable", error: result.error }
          : { identity: { aid, mode, cycleId }, error: result.error },
      { status: result.ok ? 200 : result.status, headers: result.ok ? profileHeaders : noStore }
    );
    timing.finish({
      operation: "player_profile",
      mode,
      outcome: result.ok ? "success" : result.status === 404 ? "not_found" : "error",
      status: result.ok ? 200 : result.status,
      force,
      source: result.ok && result.capture.status === "stored" ? "stored" : "upstream",
      seasonalMs: timing.elapsedMs(seasonalStarted),
      baselineMs: enrichmentPhases.baselineMs,
      metadataMs: enrichmentPhases.metadataMs,
      masteryMs: enrichmentPhases.masteryMs,
    });
    return response;
  }
  if (mode === "arena") {
    return arenaProfileResponse({ aid, cycleId, force, profileHeaders, noStore, timing });
  }
  if (mode === "pve") {
    let storeOpenMs: number | undefined;
    let storeReadMs: number | undefined;
    let storeWriteMs: number | undefined;
    let profileMs: number | undefined;
    let levelsMs: number | undefined;
    let parseMs: number | undefined;
    const enrichmentPhases: ProfileEnrichmentPhases = {};
    let profileStarted: number | undefined;
    let storage: "sqlite" | "unavailable" = "unavailable";
    let source: "upstream" | "cache" = "upstream";
    let cache: "hit" | "miss" | "bypass" = force ? "bypass" : "miss";
    try {
      const storeOpenStarted = timing.now();
      const store = await getStore(mode);
      storeOpenMs = timing.elapsedMs(storeOpenStarted);
      const storeReadStarted = store ? timing.now() : undefined;
      const stored = store ? await store.stored(aid) : undefined;
      if (storeReadStarted !== undefined) storeReadMs = timing.elapsedMs(storeReadStarted);
      storage = store ? "sqlite" : "unavailable";
      const pveResponse = async (input: {
        profile?: PlayerProfile | null;
        stats: NonNullable<typeof stored>["stats"];
        achievementIds: string[];
        capturedAt: number | null;
        capture: { inserted: boolean; status: string };
      }) => {
        const storedRisk = await getRiskEvaluation({ aid, mode: "pve", cycleId }).catch(() => null);
        const riskIsFresh = storedRisk &&
          storedRisk.scoreVersion === riskScoreVersion("pve", cycleId) &&
          storedRisk.profileUpdatedAt >= Number(input.stats.profileUpdatedAt) &&
          Date.now() - storedRisk.evaluatedAt < 5 * 60 * 60 * 1000;
        if (!riskIsFresh) {
          after(() => evaluateAndStoreRisk({
            aid,
            mode: "pve",
            cycleId,
            stats: input.stats,
            achievementIds: input.achievementIds,
          }).catch((error) => {
            console.error("PvE admin risk evaluation failed", error);
          }));
        }
        const publicRisk = storedRisk?.scoreVersion === riskScoreVersion("pve", cycleId) || allowStaleRisk
          ? toPublicRiskView(storedRisk, { aid, mode: "pve", cycleId })
          : null;
        const viewModel = await enrichPersistentViewModel("pve", buildPersistentProfileViewModel({
          aid,
          mode: "pve",
          cycleId,
          profile: input.profile ?? undefined,
          stats: input.stats,
          achievementIds: input.achievementIds,
          capturedAt: input.capturedAt,
        }, publicRisk), enrichmentPhases);
        return NextResponse.json({
          profile: input.profile ?? null,
          stats: input.stats,
          achievementIds: input.achievementIds,
          profileUpdatedAt: Number(input.stats.profileUpdatedAt) || null,
          identity: { aid, mode: "pve", cycleId },
          risk: publicRisk,
          comparisonStats: buildPersistentComparisonStats(input.stats),
          capture: input.capture,
          freshness: viewModel.freshness,
          viewModel,
        }, { headers: profileHeaders });
      };
      const storedResponse = async (snapshot: NonNullable<typeof stored>) => {
        const response = await pveResponse({
          ...snapshot,
          capturedAt: null,
          capture: { inserted: false, status: "stored" },
        });
        timing.setRequestContext({ nickname: snapshot.stats.nickname });
        timing.finish({
          operation: "player_profile",
          mode,
          outcome: "success",
          status: 200,
          force,
          source: "stored",
          cache: force ? "bypass" : "hit",
          storage,
          storeOpenMs,
          storeReadMs,
          profileMs: profileMs ?? (profileStarted === undefined ? undefined : timing.elapsedMs(profileStarted)),
          baselineMs: enrichmentPhases.baselineMs,
          metadataMs: enrichmentPhases.metadataMs,
          masteryMs: enrichmentPhases.masteryMs,
        });
        return response;
      };
      if (stored && !force) {
        if (needsPvpStatsParserRefresh(stored.stats)) {
          after(() => refreshStoredPveProfile(aid));
        }
        return await storedResponse(stored);
      }

      let profile: PlayerProfile | null;
      profileStarted = timing.now();
      try {
        const result = await getPublicProfile(aid, { force, mode });
        profile = result.profile;
        source = result.fromCache ? "cache" : "upstream";
        cache = force ? "bypass" : result.fromCache ? "hit" : "miss";
      } catch (error) {
        if (stored) return await storedResponse(stored);
        profileMs = timing.elapsedMs(profileStarted);
        throw error;
      }
      profileMs = timing.elapsedMs(profileStarted);
      if (!profile) {
        if (stored) return await storedResponse(stored);
        const profileSummary = await findProfileSummary(aid, mode, async (candidateMode, candidateAid) => {
          const candidateStore = await getStore(candidateMode);
          return candidateStore?.profileSummary(candidateAid) ?? null;
        });
        const response = NextResponse.json(
          {
            code: "mode_profile_unavailable",
            error: "Profile mode is not available in the public cache",
            ...(profileSummary ? { profileSummary } : {}),
          },
          { status: 404, headers: noStore }
        );
        timing.finish({
          operation: "player_profile",
          mode,
          outcome: "not_found",
          status: 404,
          force,
          source,
          cache,
          storage,
          storeOpenMs,
          storeReadMs,
          profileMs,
        });
        return response;
      }
      const parseStarted = timing.now();
      const stats = parseProfileStats(profile, [...PLAYER_LEVELS_V2026_07_22]);
      parseMs = timing.elapsedMs(parseStarted);
      stats.profileUpdatedAt = Number(profile.updated) || 0;
      const achievementIds = profile.achievements ? Object.keys(profile.achievements) : [];
      const decision = pveProfileDecision(profile);
      let capture: { inserted: boolean; status: string };
      let capturedAt: number | null = null;
      if (decision.state === "store") {
        if (!store) throw new Error("player store unavailable");
        const pveSnapshot = makePlayerSnapshot(
          aid,
          stats,
          achievementIds,
          Number(stats.profileUpdatedAt),
        );
        capturedAt = pveSnapshot.capturedAt;
        // Не блокируем ответ PvE-профиля записью в SQLite: очередь как у regular.
        // Дедупликация остаётся внутри persistRegularProfileSnapshot, повторная
        // попытка произойдёт на следующем forced-обновлении с тем же upstreamUpdatedAt.
        capture = { inserted: false, status: "queued" };
        after(() => persistRegularProfileSnapshot(pveSnapshot, {
          mode: "pve",
          playerStore: store,
        }).catch((error) => {
          console.error("pve profile capture after response failed", error);
        }));
      } else {
        capture = { inserted: false, status: decision.state };
      }
      const response = await pveResponse({ profile, stats, achievementIds, capturedAt, capture });
      timing.setRequestContext({ nickname: stats.nickname });
      timing.finish({
        operation: "player_profile",
        mode,
        outcome: "success",
        status: 200,
        force,
        source,
        cache,
        storage,
        storeOpenMs,
        storeReadMs,
        storeWriteMs,
        profileMs,
        levelsMs,
        parseMs,
        baselineMs: enrichmentPhases.baselineMs,
        metadataMs: enrichmentPhases.metadataMs,
        masteryMs: enrichmentPhases.masteryMs,
      });
      return response;
    } catch (error) {
      console.error("mode profile load failed", error);
      const response = NextResponse.json({ error: "Failed to load player profile" }, { status: 503, headers: noStore });
      timing.finish({
        operation: "player_profile",
        mode,
        outcome: "error",
        status: 503,
        force,
        source,
        cache,
        storage,
        storeOpenMs,
        storeReadMs,
        storeWriteMs,
        profileMs,
        levelsMs,
        parseMs,
        baselineMs: enrichmentPhases.baselineMs,
        metadataMs: enrichmentPhases.metadataMs,
        masteryMs: enrichmentPhases.masteryMs,
      });
      return response;
    }
  }

  const storedStarted = timing.now();
  const progressionStore = await getProgressionStore("regular");
  const stored = progressionStore ? await progressionStore.latest(aid) : null;
  const storeReadMs = timing.elapsedMs(storedStarted);

  let profileMs: number | undefined;
  let levelsMs: number | undefined;
  let parseMs: number | undefined;
  const enrichmentPhases: ProfileEnrichmentPhases = {};
  let profileStarted: number | undefined;
  let source: "upstream" | "cache" = "upstream";
  let cache: "hit" | "miss" | "bypass" = force ? "bypass" : "miss";
  let fromCache = false;
  let fromEdgeCache = false;

  // Built as a closure so the forced path can fall back to the stored snapshot
  // when upstream is unreachable or reports the profile as missing. Arena and
  // pve already degrade to their stored row instead of claiming absence.
  const storedResponse = async (snapshot: NonNullable<typeof stored>) => {
    const storedEnrichmentPhases: ProfileEnrichmentPhases = {};
    const storedRisk = snapshot.stats.pvpStatsKnown === false
      ? null
      : await getRiskEvaluation({ aid, mode: "regular", cycleId }).catch(() => null);
    const riskIsFresh = storedRisk &&
      storedRisk.scoreVersion === riskScoreVersion("regular", cycleId) &&
      storedRisk.profileUpdatedAt >= Number(snapshot.stats.profileUpdatedAt) &&
      Date.now() - storedRisk.evaluatedAt < 5 * 60 * 60 * 1000;
    if (snapshot.stats.pvpStatsKnown !== false && !riskIsFresh) {
      after(async () => {
        // Match the upstream path: let the personal timeline load first.
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        await evaluateAndStoreRisk({
          aid, mode: "regular", cycleId,
          stats: snapshot.stats, achievementIds: snapshot.achievementIds,
        }).catch((error) => {
          console.error("regular stored profile risk evaluation failed", error);
        });
      });
    }
    const publicRisk = storedRisk?.scoreVersion === riskScoreVersion("regular", cycleId) || allowStaleRisk
      ? toPublicRiskView(storedRisk, { aid, mode: "regular", cycleId })
      : null;
    const viewModel = await enrichPersistentViewModel("regular", buildPersistentProfileViewModel({
      aid,
      mode: "regular",
      cycleId,
      stats: snapshot.stats,
      achievementIds: snapshot.achievementIds,
      capturedAt: snapshot.capturedAt,
    }, publicRisk), storedEnrichmentPhases);
    if (needsPvpStatsParserRefresh(snapshot.stats) ||
        Date.now() - snapshot.capturedAt >= STORED_PROFILE_REFRESH_MS) {
      after(() => refreshStoredRegularProfile(aid));
    }
    timing.setRequestContext({ nickname: snapshot.stats.nickname });
    timing.finish({
      operation: "player_profile",
      mode: "regular",
      outcome: "success",
      status: 200,
      force,
      source: "stored",
      cache: force ? "bypass" : "hit",
      storage: "sqlite",
      storeReadMs,
      profileMs: profileMs ?? (profileStarted === undefined ? undefined : timing.elapsedMs(profileStarted)),
      baselineMs: storedEnrichmentPhases.baselineMs,
      metadataMs: storedEnrichmentPhases.metadataMs,
      masteryMs: storedEnrichmentPhases.masteryMs,
    });
    return NextResponse.json({
      profile: null,
      stats: snapshot.stats,
      achievementIds: snapshot.achievementIds,
      profileUpdatedAt: Number(snapshot.stats.profileUpdatedAt) || snapshot.upstreamUpdatedAt,
      identity: { aid, mode: "regular", cycleId },
      risk: publicRisk,
      comparisonStats: buildPersistentComparisonStats(snapshot.stats),
      capture: { inserted: false, status: "stored" },
      freshness: viewModel.freshness,
      viewModel,
    }, { headers: profileHeaders });
  };

  if (stored && !force) return await storedResponse(stored);

  // Scoped to the upstream call, like the pve branch above. A throw from the
  // enrichment below has to surface as a failure, not be reported to the request
  // log as a 200 served from the store.
  let profile: PlayerProfile | null;
  try {
    profileStarted = timing.now();
    const result = await getPublicProfile(aid, { force });
    profile = result.profile;
    fromCache = result.fromCache === true;
    fromEdgeCache = result.fromEdgeCache === true;
    source = result.fromCache || result.fromEdgeCache ? "cache" : "upstream";
    cache = force ? "bypass" : result.fromCache || result.fromEdgeCache ? "hit" : "miss";
  } catch (error) {
    // getPublicProfile throws rather than returning null when upstream is
    // unreachable, and its stale fallback is skipped precisely because force is
    // set. Degrade to the stored snapshot instead of reporting a 502 for a
    // profile we already have.
    if (stored) return await storedResponse(stored);
    profileMs = timing.elapsedMs(profileStarted!);
    throw error;
  }
  profileMs = timing.elapsedMs(profileStarted!);
  try {
    if (!profile) {
      // A forced refresh can lose the upstream race while a perfectly good
      // snapshot sits in progression_snapshots. Serve that instead of a 404.
      if (stored) return await storedResponse(stored);
      const response = NextResponse.json(
        {
          error:
            "Profile not found. It may be private, or hasn't been viewed on tarkov.dev yet — open it there once to cache it, then retry.",
          identity: { aid, mode, cycleId },
        },
        { status: 404, headers: profileHeaders }
      );
      timing.finish({
        operation: "player_profile",
        mode,
        outcome: "not_found",
        status: 404,
        force,
        source,
        cache,
        profileMs,
      });
      return response;
    }

    const parseStarted = timing.now();
    const stats = parseProfileStats(profile, [...PLAYER_LEVELS_V2026_07_22]);
    parseMs = timing.elapsedMs(parseStarted);

    const achievementIds = profile.achievements ? Object.keys(profile.achievements) : [];
    const regularSnapshot = makePlayerSnapshot(
      aid,
      stats,
      achievementIds,
      Number(stats.profileUpdatedAt),
    );
    after(() => persistRegularProfileSnapshot(regularSnapshot, { upsertPlayer: !(fromCache || fromEdgeCache) }).catch((error) => {
      console.error("regular profile capture after response failed", error);
    }));

    const storedRisk = stats.pvpStatsKnown === false
      ? null
      : await getRiskEvaluation({ aid, mode: "regular", cycleId }).catch(() => null);
    const riskIsFresh = storedRisk &&
      storedRisk.scoreVersion === riskScoreVersion("regular", cycleId) &&
      storedRisk.profileUpdatedAt >= Number(stats.profileUpdatedAt) &&
      Date.now() - storedRisk.evaluatedAt < 5 * 60 * 60 * 1000;
    if (stats.pvpStatsKnown !== false && !riskIsFresh) {
      after(async () => {
        // Let the browser's personal-timeline request finish before the
        // population-wide achievement/risk baseline scan occupies node:sqlite.
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        await evaluateAndStoreRisk({ aid, mode, cycleId, stats, achievementIds }).catch((error) => {
          console.error("regular admin risk evaluation failed", error);
        });
      });
    }
    const publicRiskView = storedRisk?.scoreVersion === riskScoreVersion("regular", cycleId) || allowStaleRisk
      ? toPublicRiskView(storedRisk, { aid, mode: "regular", cycleId })
      : null;
    const regularViewModel = await enrichRegularViewModel(
      buildRegularProfileViewModel({
        aid,
        mode: "regular",
        cycleId,
        profile,
        stats,
      }, publicRiskView),
      enrichmentPhases,
    );
    const response = NextResponse.json(
      {
        profile,
        stats,
        achievementIds,
        profileUpdatedAt: Number(profile.updated) || null,
        identity: { aid, mode, cycleId },
        risk: publicRiskView,
        comparisonStats: buildRegularComparisonStats(stats),
        // viewModel: buildRegularProfileViewModel(...) is enriched above.
        viewModel: regularViewModel,
      },
      { headers: profileHeaders }
    );
    timing.setRequestContext({ nickname: stats.nickname });
    timing.finish({
      operation: "player_profile",
      mode,
      outcome: "success",
      status: 200,
      force,
      source,
      cache,
      profileMs,
      levelsMs,
      parseMs,
      baselineMs: enrichmentPhases.baselineMs,
      metadataMs: enrichmentPhases.metadataMs,
      masteryMs: enrichmentPhases.masteryMs,
    });
    return response;
  } catch {
    const response = NextResponse.json(
      { error: "Failed to fetch player profile", identity: { aid, mode, cycleId } },
      { status: 502, headers: noStore }
    );
    timing.finish({
      operation: "player_profile",
      mode,
      outcome: "error",
      status: 502,
      force,
      source,
      cache,
      profileMs,
      levelsMs,
      parseMs,
      baselineMs: enrichmentPhases.baselineMs,
      metadataMs: enrichmentPhases.metadataMs,
      masteryMs: enrichmentPhases.masteryMs,
    });
    return response;
  }
}
