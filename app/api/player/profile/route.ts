import { NextRequest, NextResponse } from "next/server";
import {
  getPublicProfile,
  getPlayerLevels,
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
import { isSeasonalRolloutReady, loadSeasonalCycleConfig } from "@/lib/seasonal/config";
import { validateSeasonalProfile } from "@/lib/seasonal-upstream";
import { fetchSeasonalPayload } from "@/lib/seasonal/fetch";
import { recordSeasonalCaptureLifecycle } from "@/lib/seasonal/scanner";

export async function GET(request: NextRequest) {
  const ip = getClientIp(request);

  // Строгий лимит: роут делает upstream-fetch к tarkov.dev и пишет строку в БД
  // (датасет /average), поэтому жёстче общего лимита.
  const { allowed, headers } = getRateLimitHeaders(ip, { bucket: "profile", max: 10 });
  // Профиль не кэшируем у браузера/CDN — иначе «Обновить»/F5 показывал бы старое.
  const noStore = { ...headers, "Cache-Control": "no-store" };
  if (!allowed) {
    return NextResponse.json(
      { error: "Rate limit exceeded" },
      { status: 429, headers: noStore }
    );
  }

  const aid = parsePlayerId(request.nextUrl.searchParams.get("aid") ?? "");
  if (aid === null) {
    return NextResponse.json(
      { error: "Invalid account ID. Paste a numeric id or a tarkov.dev profile link." },
      { status: 400, headers: noStore }
    );
  }

  const rawMode = request.nextUrl.searchParams.get("mode");
  const mode = rawMode === null || rawMode === "" ? "regular" : rawMode;
  if (!isGameMode(mode)) {
    return NextResponse.json({ error: "Invalid game mode" }, { status: 400, headers: noStore });
  }
  const cycleId = normalizeCycleId(request.nextUrl.searchParams.get("cycle"), mode);
  if (cycleId === null) {
    return NextResponse.json({ error: "Invalid or missing cycle" }, { status: 400, headers: noStore });
  }

  // ?refresh=1 (кнопка «Обновить» / перезагрузка) обходит наш 5-мин in-process кэш.
  const force = request.nextUrl.searchParams.get("refresh") === "1";

  if (mode === "seasonal") {
    if (!isSeasonalRolloutReady()) {
      return NextResponse.json({ error: "Seasonal profile unavailable" }, { status: 404, headers: noStore });
    }
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
        fetchPayload: ({ aid: seasonalAid }) => fetchSeasonalPayload(seasonalAid),
        afterCapture: ({ cycle, profile, capture, observedAt }) =>
          recordSeasonalCaptureLifecycle(cycle, profile, capture, "profile_open", observedAt).then(() => undefined),
      }
    );
    return NextResponse.json(
      result.ok ? { profile: result.profile, capture: result.capture } : { error: result.error },
      { status: result.ok ? 200 : result.status, headers: noStore }
    );
  }
  if (mode === "pve" || mode === "arena") {
    try {
      const store = await getStore(mode);
      const stored = await store?.stored(aid);
      if (stored && !force) {
        return NextResponse.json(
          { ...stored, profileUpdatedAt: Number(stored.stats.profileUpdatedAt) || null },
          { headers: noStore }
        );
      }

      const { profile } = await getPublicProfile(aid, { force, mode });
      if (!profile) {
        return NextResponse.json(
          { error: "Profile mode is not available in the public cache" },
          { status: 404, headers: noStore }
        );
      }
      const levels = mode === "pve" ? await getPlayerLevels().catch(() => []) : [];
      const stats = mode === "arena"
        ? parseArenaProfileStats(profile)
        : parseProfileStats(profile, levels);
      stats.profileUpdatedAt = Number(profile.updated) || 0;
      const achievementIds = profile.achievements ? Object.keys(profile.achievements) : [];
      const shouldStore = mode === "arena" || pveProfileDecision(profile).state === "store";
      if (shouldStore) {
        if (!store) throw new Error("player store unavailable");
        await store.upsert(aid, stats, achievementIds);
      }
      return NextResponse.json(
        { profile, stats, profileUpdatedAt: Number(profile.updated) || null },
        { headers: noStore }
      );
    } catch (error) {
      console.error("mode profile load failed", error);
      return NextResponse.json({ error: "Failed to load player profile" }, { status: 503, headers: noStore });
    }
  }

  try {
    const { profile, fromCache } = await getPublicProfile(aid, { force });
    if (!profile) {
      return NextResponse.json(
        {
          error:
            "Profile not found. It may be private, or hasn't been viewed on tarkov.dev yet — open it there once to cache it, then retry.",
        },
        { status: 404, headers: noStore }
      );
    }

    const levels = await getPlayerLevels().catch(() => []);
    const stats = parseProfileStats(profile, levels);

    // Пишем в БД только при свежем upstream-ответе (не из нашего кэша) — снижаем
    // дисковую нагрузку и повторные upsert одного и того же профиля.
    if (!fromCache) {
      const store = await getStore();
      if (store) {
        const achievementIds = profile.achievements
          ? Object.keys(profile.achievements)
          : [];
        try {
          await store.upsert(aid, stats, achievementIds);
        } catch (e) {
          console.error("player store failed", e);
        }
      }
    }

    return NextResponse.json(
      { profile, stats, profileUpdatedAt: Number(profile.updated) || null },
      { headers: noStore }
    );
  } catch {
    return NextResponse.json(
      { error: "Failed to fetch player profile" },
      { status: 502, headers: noStore }
    );
  }
}
