import { NextRequest, NextResponse } from "next/server";
import { loadDynamicAverage, statisticsCacheHeaders } from "@/lib/average-dynamic-cache";
import { getStore, type PlayerStore } from "@/lib/db";
import { isSeasonalRolloutReady, loadSeasonalCycleConfig } from "@/lib/seasonal/config";
import { getPublishedSeasonalAchievementBaseline } from "@/lib/seasonal/progression-db";
import { getAchievements } from "@/lib/tarkov-api";
import { isGameMode } from "@/types/seasonal";
import { createRequestTiming } from "@/lib/observability/request-timing";
import { fakeAverageAchievements, isLocalFakeAverageEnabled } from "@/lib/local-fake-average";

export const runtime = "nodejs";

// One row per achievement: how it looks in OUR sample (owners, prevalence,
// typical unlock hours ± std) merged with tarkov.dev metadata (name, rarity,
// BSG's official completion %). meanHours/stdHours are the baseline the client
// uses for the per-player early-unlock z-score.
export interface AchievementRow {
  id: string;
  name: string;
  nameRu: string | null;
  description: string | null;
  descriptionRu: string | null;
  imageUrl: string | null;
  side: string;
  rarity: string;
  owners: number;
  samplePct: number;
  officialPct: number;
  meanHours: number;
  stdHours: number;
  earlyHours: number;
  unlockHours: number;
}

interface Payload {
  total: number;
  achievements: AchievementRow[];
}

// Sample-side baseline (id/owners/prevalence/hours) — no names yet.
interface BaselineRow {
  id: string;
  owners: number;
  samplePct: number;
  meanHours: number;
  stdHours: number;
  earlyHours: number;
  unlockHours: number;
}

interface BaselineCache {
  total: number;
  rows: BaselineRow[];
  ts: number;
  storage: "sqlite" | "unavailable";
}

// Memoize ONLY the heavy json_each scan in-isolate. Names are merged fresh per
// request (getAchievements has its own 6h success-cache), so a transient
// Reference-data failure degrades a single response instead of poisoning a memoized
// payload with id-as-name / 0% for the whole TTL.
const MEMO_TTL_MS = 5 * 60 * 1000;
class AchievementBaselineUnavailableError extends Error {}

// The client requests this URL with cache: "default", so a cacheable 404 would
// be pinned in the browser and CDN after one transient failure. This is a
// rollout gate, so a pinned 404 would outlive the gate opening.
const noStore = { "Cache-Control": "no-store" };

async function loadBaseline(store: PlayerStore | null): Promise<Omit<BaselineCache, "ts">> {
  if (!store) throw new AchievementBaselineUnavailableError("Achievement storage is unavailable");

  const baseline = await store.achievementBaseline();
  if (!baseline) throw new AchievementBaselineUnavailableError("Achievement baseline is unavailable");
  const total = baseline.total;
  const rows: BaselineRow[] = baseline.achievements.map((a) => ({
    id: a.ach_id,
    owners: a.owners,
    samplePct: total > 0 ? (a.owners / total) * 100 : 0,
    meanHours: a.meanHours,
    stdHours: a.stdHours,
    earlyHours: a.earlyHours,
    unlockHours: a.unlockHours,
  }));
  // Most-owned first: the rows with the firmest baseline lead.
  rows.sort((x, y) => y.owners - x.owners);
  return { total, rows, storage: "sqlite" };
}

export async function GET(request: NextRequest) {
  const timing = createRequestTiming();
  timing.setRequestContext({ host: request.headers.get("x-forwarded-host") ?? request.headers.get("host") });
  let memoStatus: "hit" | "miss" | undefined;
  let baselineMs: number | undefined;
  let storeOpenMs: number | undefined;
  let metadataMs: number | undefined;
  let storage: "sqlite" | "unavailable" | undefined;
  try {
    const rawMode = request.nextUrl.searchParams.get("mode") ?? "regular";
    if (!isGameMode(rawMode)) {
      timing.finish({ operation: "average_achievements", outcome: "invalid", status: 400 });
      return NextResponse.json({ error: "Invalid game mode" }, { status: 400, headers: noStore });
    }
    if (isLocalFakeAverageEnabled() && (rawMode === "regular" || rawMode === "pve")) {
      return NextResponse.json(fakeAverageAchievements());
    }
    const cycleId = rawMode === "seasonal" ? request.nextUrl.searchParams.get("cycle") : null;
    if (rawMode === "seasonal") {
      const cycle = loadSeasonalCycleConfig();
      // A season that has not rolled out is absent, not a client mistake: the
      // same 404 app/api/seasonal/average answers for its own gate. Only a
      // malformed or stale `cycle` stays a 400.
      if (!isSeasonalRolloutReady() || !cycle) {
        timing.finish({ operation: "average_achievements", mode: rawMode, outcome: "not_found", status: 404 });
        return NextResponse.json({ error: "Seasonal average unavailable" }, { status: 404, headers: noStore });
      }
      if (cycleId !== cycle.cycleId || request.nextUrl.searchParams.getAll("cycle").length !== 1) {
        timing.finish({ operation: "average_achievements", mode: rawMode, outcome: "invalid", status: 400 });
        return NextResponse.json({ error: "Invalid Seasonal cycle" }, { status: 400, headers: noStore });
      }
    }
    const now = Date.now();
    const memoKey = rawMode === "seasonal" ? `${rawMode}:${cycleId}` : rawMode;
    const baselineStarted = timing.now();
    const loaded = await loadDynamicAverage(`achievement-baseline:${memoKey}`, async () => {
          if (rawMode === "seasonal") {
            const baseline = await getPublishedSeasonalAchievementBaseline(cycleId!);
            if (!baseline) throw new AchievementBaselineUnavailableError("Seasonal achievement baseline is unavailable");
            return {
              total: baseline?.eligibleN ?? 0,
              rows: (baseline?.achievements ?? []).map((a) => ({
                id: a.id,
                owners: a.owners,
                samplePct: a.samplePct,
                meanHours: a.meanHours,
                stdHours: a.stdHours,
                earlyHours: a.earlyHours,
                unlockHours: a.unlockHours,
              })),
              ts: now,
              storage: baseline ? "sqlite" as const : "unavailable" as const,
            };
          }
          const storeOpenStarted = timing.now();
          const store = await getStore(rawMode);
          storeOpenMs = timing.elapsedMs(storeOpenStarted);
          return { ...(await loadBaseline(store)), ts: now };
    }, now, { ttlMs: MEMO_TTL_MS });
    const cached: BaselineCache = loaded.value;
    memoStatus = loaded.cache;
    baselineMs = timing.elapsedMs(baselineStarted);
    storage = cached.storage;

    // Cheap (own 6h cache); failure falls back to id-as-name and recovers next request.
    const metadataStarted = timing.now();
    const metadata = await loadDynamicAverage(`achievement-metadata:${rawMode === "seasonal" ? memoKey : "regular"}`, async () =>
      [...await getAchievements(rawMode === "seasonal" ? "seasonal" : "regular")], Date.now(), {
        ttlMs: 6 * 60 * 60_000, accept: (entries) => entries.length > 0,
      }).catch(() => null).finally(() => {
      metadataMs = timing.elapsedMs(metadataStarted);
    });
    const meta = new Map(metadata?.value ?? []);

    const achievements: AchievementRow[] = cached.rows.map((r) => {
      const m = meta.get(r.id);
      return {
        id: r.id,
        name: m?.name ?? r.id,
        nameRu: m?.nameRu ?? null,
        description: m?.descriptionEn ?? null,
        descriptionRu: m?.descriptionRu ?? null,
        imageUrl: m?.imageUrl ?? null,
        side: m?.side ?? "",
        rarity: m?.rarity ?? "",
        owners: r.owners,
        samplePct: r.samplePct,
        officialPct: m?.playersCompletedPercent ?? 0,
        meanHours: r.meanHours,
        stdHours: r.stdHours,
        earlyHours: r.earlyHours,
        unlockHours: r.unlockHours,
      };
    });

    const payload: Payload = { total: cached.total, achievements };
    const response = NextResponse.json(payload, {
      headers: statisticsCacheHeaders({ stale: loaded.stale || metadata === null || metadata.stale, generatedAt: loaded.generatedAt }),
    });
    timing.finish({
      operation: "average_achievements", mode: rawMode, outcome: "success", status: 200,
      storage, memo: memoStatus, storeOpenMs, baselineMs, metadataMs,
    });
    return response;
  } catch (e) {
    console.error("achievement baseline failed", e);
    timing.finish({
      operation: "average_achievements", outcome: "error", status: 500,
      storage, memo: memoStatus, storeOpenMs, baselineMs, metadataMs,
    });
    return NextResponse.json({ error: "Failed to compute achievement baseline" }, {
      status: e instanceof AchievementBaselineUnavailableError ? 503 : 500, headers: noStore,
    });
  }
}
