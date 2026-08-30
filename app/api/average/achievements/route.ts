import { NextRequest, NextResponse } from "next/server";
import { getStore, type PlayerStore } from "@/lib/db";
import { getSeasonalAchievementBaseline } from "@/lib/seasonal/average-db";
import { isSeasonalRolloutReady, loadSeasonalCycleConfig } from "@/lib/seasonal/config";
import { getAchievements } from "@/lib/tarkov-api";
import { isGameMode } from "@/types/seasonal";
import { createRequestTiming } from "@/lib/observability/request-timing";

// One row per achievement: how it looks in OUR sample (owners, prevalence,
// typical unlock hours ± std) merged with tarkov.dev metadata (name, rarity,
// BSG's official completion %). meanHours/stdHours are the baseline the client
// uses for the per-player early-unlock z-score.
export interface AchievementRow {
  id: string;
  name: string;
  side: string;
  rarity: string;
  owners: number;
  samplePct: number;
  officialPct: number;
  meanHours: number;
  stdHours: number;
  earlyHours: number;
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
const memo = new Map<string, BaselineCache>();
const baselineLoads = new Map<string, Promise<BaselineCache>>();
const MEMO_TTL_MS = 5 * 60 * 1000;

async function loadBaseline(store: PlayerStore | null): Promise<Omit<BaselineCache, "ts">> {
  if (!store) return { total: 0, rows: [], storage: "unavailable" };

  const baseline = await store.achievementBaseline();
  const total = baseline.total;
  const rows: BaselineRow[] = baseline.achievements.map((a) => ({
    id: a.ach_id,
    owners: a.owners,
    samplePct: total > 0 ? (a.owners / total) * 100 : 0,
    meanHours: a.meanHours,
    stdHours: a.stdHours,
    earlyHours: a.earlyHours,
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
      return NextResponse.json({ error: "Invalid game mode" }, { status: 400 });
    }
    const cycleId = rawMode === "seasonal" ? request.nextUrl.searchParams.get("cycle") : null;
    if (rawMode === "seasonal") {
      const cycle = loadSeasonalCycleConfig();
      if (!isSeasonalRolloutReady() || !cycle || cycleId !== cycle.cycleId || request.nextUrl.searchParams.getAll("cycle").length !== 1) {
        timing.finish({ operation: "average_achievements", mode: rawMode, outcome: "invalid", status: 400 });
        return NextResponse.json({ error: "Invalid Seasonal cycle" }, { status: 400 });
      }
    }
    const now = Date.now();
    const memoKey = rawMode === "seasonal" ? `${rawMode}:${cycleId}` : rawMode;
    let cached = memo.get(memoKey);
    if (!cached || now - cached.ts >= MEMO_TTL_MS) {
      memoStatus = "miss";
      const baselineStarted = timing.now();
      let load = baselineLoads.get(memoKey);
      if (!load) {
        load = (async () => {
          if (rawMode === "seasonal") {
            const baseline = await getSeasonalAchievementBaseline(cycleId!);
            return {
              total: baseline?.total ?? 0,
              rows: (baseline?.achievements ?? []).map((a) => ({
                id: a.ach_id,
                owners: a.owners,
                samplePct: baseline && baseline.total > 0 ? (a.owners / baseline.total) * 100 : 0,
                meanHours: a.meanHours,
                stdHours: a.stdHours,
                earlyHours: a.earlyHours,
              })),
              ts: now,
              storage: baseline ? "sqlite" as const : "unavailable" as const,
            };
          }
          const storeOpenStarted = timing.now();
          const store = await getStore(rawMode);
          storeOpenMs = timing.elapsedMs(storeOpenStarted);
          return { ...(await loadBaseline(store)), ts: now };
        })();
        baselineLoads.set(memoKey, load);
      }
      try {
        cached = await load;
      } finally {
        if (baselineLoads.get(memoKey) === load) baselineLoads.delete(memoKey);
      }
      baselineMs = timing.elapsedMs(baselineStarted);
      memo.set(memoKey, cached);
    } else {
      memoStatus = "hit";
    }
    storage = cached.storage;

    // Cheap (own 6h cache); failure falls back to id-as-name and recovers next request.
    const metadataStarted = timing.now();
    const meta = await getAchievements(rawMode === "seasonal" ? "seasonal" : "regular").catch(() => new Map()).finally(() => {
      metadataMs = timing.elapsedMs(metadataStarted);
    });

    const achievements: AchievementRow[] = cached.rows.map((r) => {
      const m = meta.get(r.id);
      return {
        id: r.id,
        name: m?.name ?? r.id,
        side: m?.side ?? "",
        rarity: m?.rarity ?? "",
        owners: r.owners,
        samplePct: r.samplePct,
        officialPct: m?.playersCompletedPercent ?? 0,
        meanHours: r.meanHours,
        stdHours: r.stdHours,
        earlyHours: r.earlyHours,
      };
    });

    const payload: Payload = { total: cached.total, achievements };
    const response = NextResponse.json(payload, {
      headers: { "Cache-Control": "public, max-age=300, s-maxage=300, stale-while-revalidate=3600" },
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
    return NextResponse.json({ error: "Failed to compute achievement baseline" }, { status: 500 });
  }
}
