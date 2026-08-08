import { after, NextRequest, NextResponse } from "next/server";
import {
  getPublicProfile,
  getPlayerLevels,
  getAchievements,
  parseArenaProfileStats,
  parseProfileStats,
  pveProfileDecision,
} from "@/lib/tarkov-api";
import { getRateLimitHeaders } from "@/lib/rate-limiter";
import { getClientIp } from "@/lib/client-ip";
import { parsePlayerId } from "@/lib/player-id";
import { getStore } from "@/lib/db";
import { isGameMode, normalizeCycleId } from "@/types/seasonal";
import { resolveSeasonalProfile } from "@/lib/seasonal/profile-service";
import { getSeasonalStore } from "@/lib/seasonal/storage";
import { getSeasonalAchievementBaseline } from "@/lib/seasonal/average-db";
import { isSeasonalRolloutReady, loadSeasonalCycleConfig } from "@/lib/seasonal/config";
import { validateSeasonalProfile } from "@/lib/seasonal-upstream";
import { fetchSeasonalPayload } from "@/lib/seasonal/fetch";
import { recordSeasonalCaptureLifecycle } from "@/lib/seasonal/scanner";
import { refreshProgressionAfterCapture } from "@/lib/seasonal/daily-aggregates";
import type { PlayerProfile } from "@/types/tarkov";
import { createRequestTiming } from "@/lib/observability/request-timing";
import { findProfileSummary } from "@/lib/profile-summary";
import { makePlayerSnapshot } from "@/lib/ban-db";
import { persistRegularProfileSnapshot } from "@/lib/regular-profile-capture";
import { evaluateAndStoreRisk, evaluateAndStoreSeasonalRisk } from "@/lib/admin/risk-service";
import { getRiskEvaluation } from "@/lib/admin/moderation-db";
import {
  buildRegularProfileViewModel,
  buildSeasonalProfileViewModel,
  toPublicRiskView,
} from "@/lib/player-profile-view";

async function enrichSeasonalViewModel(
  profile: import("@/types/seasonal").SeasonalProfile,
  viewModel: ReturnType<typeof buildSeasonalProfileViewModel>,
) {
  const [baseline, metadata] = await Promise.all([
    getSeasonalAchievementBaseline(profile.cycleId).catch(() => null),
    getAchievements().catch(() => new Map()),
  ]);
  const baselineById = new Map((baseline?.achievements ?? []).map((entry) => [entry.ach_id, entry]));
  const achievements = (viewModel.seasonalAchievements ?? []).map((achievement) => {
    const meta = metadata.get(achievement.id);
    const row = baselineById.get(achievement.id);
    const eligibleN = row?.eligibleN ?? baseline?.eligibleN ?? null;
    return {
      ...achievement,
      name: meta?.nameEn ?? meta?.name ?? achievement.name ?? achievement.id,
      nameRu: meta?.nameRu ?? achievement.nameRu ?? null,
      rarity: meta?.rarity ?? achievement.rarity ?? "common",
      owners: row?.owners ?? null,
      eligibleN,
      percentage: row && eligibleN !== null && eligibleN >= 30 ? row.prevalencePct : null,
    };
  });
  return {
    ...viewModel,
    seasonalAchievements: achievements,
    skills: { ...viewModel.skills, achievements },
  };
}

export async function GET(request: NextRequest) {
  const timing = createRequestTiming();
  const ip = getClientIp(request);

  // Строгий лимит: роут делает upstream-fetch к tarkov.dev и пишет строку в БД
  // (датасет /average), поэтому жёстче общего лимита.
  const { allowed, headers } = getRateLimitHeaders(ip, { bucket: "profile", max: 10 });
  // Профиль не кэшируем у браузера/CDN — иначе «Обновить»/F5 показывал бы старое.
  const noStore = { ...headers, "Cache-Control": "no-store" };
  if (!allowed) {
    timing.finish({ operation: "player_profile", outcome: "rate_limited", status: 429 });
    return NextResponse.json(
      { error: "Rate limit exceeded" },
      { status: 429, headers: noStore }
    );
  }

  const aid = parsePlayerId(request.nextUrl.searchParams.get("aid") ?? "");
  if (aid === null) {
    timing.finish({ operation: "player_profile", outcome: "invalid", status: 400 });
    return NextResponse.json(
      { error: "Invalid account ID. Paste a numeric id or a tarkov.dev profile link." },
      { status: 400, headers: noStore }
    );
  }

  const rawMode = request.nextUrl.searchParams.get("mode");
  const mode = rawMode === null || rawMode === "" ? "regular" : rawMode;
  if (!isGameMode(mode)) {
    timing.finish({ operation: "player_profile", outcome: "invalid", status: 400 });
    return NextResponse.json({ error: "Invalid game mode" }, { status: 400, headers: noStore });
  }
  const cycleId = normalizeCycleId(request.nextUrl.searchParams.get("cycle"), mode);
  if (cycleId === null) {
    timing.finish({ operation: "player_profile", mode, outcome: "invalid", status: 400 });
    return NextResponse.json({ error: "Invalid or missing cycle" }, { status: 400, headers: noStore });
  }

  timing.setRequestContext({
    aid,
    cycleId,
    host: request.headers.get("x-forwarded-host") ?? request.headers.get("host"),
  });

  // ?refresh=1 (кнопка «Обновить» / перезагрузка) обходит наш 5-мин in-process кэш.
  const force = request.nextUrl.searchParams.get("refresh") === "1";
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
          await recordSeasonalCaptureLifecycle(cycle, profile, capture, "profile_open", observedAt);
          if (capture.inserted) {
            await refreshProgressionAfterCapture("seasonal", cycle.cycleId, profile.counters.pmcRaids, { force: true });
          }
        },
      }
    );
    if (result.ok) {
      after(() => evaluateAndStoreSeasonalRisk(result.profile).catch((error) => {
        console.error("seasonal admin risk evaluation failed", error);
      }));
    }
    const storedRisk = result.ok
      ? await getRiskEvaluation({ aid, mode: "seasonal", cycleId }).catch(() => null)
      : null;
    const publicRisk = result.ok
      ? toPublicRiskView(storedRisk, { aid, mode: "seasonal", cycleId })
      : null;
    const response = NextResponse.json(
      result.ok
        ? {
            profile: result.profile,
            capture: result.capture,
            identity: { aid, mode, cycleId },
            risk: publicRisk,
            viewModel: await enrichSeasonalViewModel(
              result.profile,
              buildSeasonalProfileViewModel({ profile: result.profile }, publicRisk),
            ),
          }
        : result.status === 404
          ? { identity: { aid, mode, cycleId }, code: "mode_profile_unavailable", error: result.error }
          : { identity: { aid, mode, cycleId }, error: result.error },
      { status: result.ok ? 200 : result.status, headers: noStore }
    );
    timing.finish({
      operation: "player_profile",
      mode,
      outcome: result.ok ? "success" : result.status === 404 ? "not_found" : "error",
      status: result.ok ? 200 : result.status,
      force,
      source: "upstream",
      seasonalMs: timing.elapsedMs(seasonalStarted),
    });
    return response;
  }
  if (mode === "pve" || mode === "arena") {
    let storeOpenMs: number | undefined;
    let storeReadMs: number | undefined;
    let storeWriteMs: number | undefined;
    let profileMs: number | undefined;
    let levelsMs: number | undefined;
    let parseMs: number | undefined;
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
      const storedResponse = (snapshot: NonNullable<typeof stored>) => {
        after(() => evaluateAndStoreRisk({ aid, mode, cycleId, ...snapshot }).catch((error) => {
          console.error("stored admin risk evaluation failed", error);
        }));
        timing.setRequestContext({ nickname: snapshot.stats.nickname });
        const response = NextResponse.json(
          {
            ...snapshot,
            profileUpdatedAt: Number(snapshot.stats.profileUpdatedAt) || null,
          },
          { headers: noStore }
        );
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
        });
        return response;
      };
      if (stored && !force) {
        return storedResponse(stored);
      }

      let profile: PlayerProfile | null;
      profileStarted = timing.now();
      try {
        const result = await getPublicProfile(aid, { force, mode });
        profile = result.profile;
        source = result.fromCache ? "cache" : "upstream";
        cache = force ? "bypass" : result.fromCache ? "hit" : "miss";
      } catch (error) {
        if (stored) return storedResponse(stored);
        profileMs = timing.elapsedMs(profileStarted);
        throw error;
      }
      profileMs = timing.elapsedMs(profileStarted);
      if (!profile) {
        if (stored) return storedResponse(stored);
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
      const levelsStarted = timing.now();
      const levels = mode === "pve" ? await getPlayerLevels().catch(() => []) : [];
      levelsMs = mode === "pve" ? timing.elapsedMs(levelsStarted) : undefined;
      const parseStarted = timing.now();
      const stats = mode === "arena"
        ? parseArenaProfileStats(profile)
        : parseProfileStats(profile, levels);
      parseMs = timing.elapsedMs(parseStarted);
      stats.profileUpdatedAt = Number(profile.updated) || 0;
      const achievementIds = profile.achievements ? Object.keys(profile.achievements) : [];
      after(() => evaluateAndStoreRisk({ aid, mode, cycleId, stats, achievementIds }).catch((error) => {
        console.error("mode admin risk evaluation failed", error);
      }));
      const shouldStore = mode === "arena" || pveProfileDecision(profile).state === "store";
      if (shouldStore) {
        if (!store) throw new Error("player store unavailable");
        const storeWriteStarted = timing.now();
        try {
          await store.upsert(aid, stats, achievementIds);
        } finally {
          storeWriteMs = timing.elapsedMs(storeWriteStarted);
        }
      }
      const response = NextResponse.json(
        {
          profile,
          stats,
          achievementIds,
          profileUpdatedAt: Number(profile.updated) || null,
        },
        { headers: noStore }
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
        storage,
        storeOpenMs,
        storeReadMs,
        storeWriteMs,
        profileMs,
        levelsMs,
        parseMs,
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
      });
      return response;
    }
  }

  let profileMs: number | undefined;
  let levelsMs: number | undefined;
  let parseMs: number | undefined;
  let profileStarted: number | undefined;
  let storeOpenMs: number | undefined;
  let storeWriteMs: number | undefined;
  let storage: "sqlite" | "unavailable" | undefined;
  let source: "upstream" | "cache" = "upstream";
  let cache: "hit" | "miss" | "bypass" = force ? "bypass" : "miss";
  try {
    profileStarted = timing.now();
    const { profile, fromCache, fromEdgeCache } = await getPublicProfile(aid, { force });
    profileMs = timing.elapsedMs(profileStarted);
    source = fromCache || fromEdgeCache ? "cache" : "upstream";
    cache = force ? "bypass" : fromCache || fromEdgeCache ? "hit" : "miss";
    if (!profile) {
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

    const levelsStarted = timing.now();
    const levels = await getPlayerLevels().catch(() => []);
    levelsMs = timing.elapsedMs(levelsStarted);
    const parseStarted = timing.now();
    const stats = parseProfileStats(profile, levels);
    parseMs = timing.elapsedMs(parseStarted);

    const achievementIds = profile.achievements ? Object.keys(profile.achievements) : [];
    if (stats.pvpStatsKnown !== false) {
      after(() => evaluateAndStoreRisk({ aid, mode, cycleId, stats, achievementIds }).catch((error) => {
        console.error("regular admin risk evaluation failed", error);
      }));
    }
    let store: Awaited<ReturnType<typeof getStore>> = null;
    if (!fromCache) {
      const storeOpenStarted = timing.now();
      store = await getStore();
      storeOpenMs = timing.elapsedMs(storeOpenStarted);
      storage = store ? "sqlite" : "unavailable";
    }
    const storeWriteStarted = !fromCache ? timing.now() : undefined;
    try {
      await persistRegularProfileSnapshot(
        makePlayerSnapshot(aid, stats, achievementIds, Number(stats.profileUpdatedAt)),
        { upsertPlayer: !fromCache, playerStore: store },
      );
    } catch (error) {
      console.error("player store failed", error);
    } finally {
      if (storeWriteStarted !== undefined) storeWriteMs = timing.elapsedMs(storeWriteStarted);
    }

    const publicRisk = stats.pvpStatsKnown === false
      ? null
      : await getRiskEvaluation({ aid, mode: "regular", cycleId }).catch(() => null);
    const publicRiskView = toPublicRiskView(publicRisk, { aid, mode: "regular", cycleId });
    const response = NextResponse.json(
      {
        profile,
        stats,
        achievementIds,
        profileUpdatedAt: Number(profile.updated) || null,
        identity: { aid, mode, cycleId },
        risk: publicRiskView,
        viewModel: buildRegularProfileViewModel({
          aid,
          mode: "regular",
          cycleId,
          profile,
          stats,
        }, publicRiskView),
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
      storage,
      profileMs,
      levelsMs,
      parseMs,
      storeOpenMs,
      storeWriteMs,
    });
    return response;
  } catch {
    if (profileMs === undefined && profileStarted !== undefined) {
      profileMs = timing.elapsedMs(profileStarted);
    }
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
      storage,
      profileMs,
      levelsMs,
      parseMs,
      storeOpenMs,
      storeWriteMs,
    });
    return response;
  }
}
