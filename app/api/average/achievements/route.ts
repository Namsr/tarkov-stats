import { NextRequest, NextResponse } from "next/server";
import { getStore } from "@/lib/db";
import { getAchievements } from "@/lib/tarkov-api";
import { isGameMode } from "@/types/seasonal";
import type { CrossSectionMode } from "@/lib/db";

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

// Memoize ONLY the heavy json_each scan in-isolate. Names are merged fresh per
// request (getAchievements has its own 6h success-cache), so a transient
// GraphQL failure degrades a single response instead of poisoning a memoized
// payload with id-as-name / 0% for the whole TTL.
const memo = new Map<CrossSectionMode, { total: number; rows: BaselineRow[]; ts: number }>();
const MEMO_TTL_MS = 60 * 1000;

async function loadBaseline(mode: CrossSectionMode): Promise<{ total: number; rows: BaselineRow[] }> {
  const store = await getStore(mode);
  if (!store) return { total: 0, rows: [] };

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
  return { total, rows };
}

export async function GET(request: NextRequest) {
  try {
    const rawMode = request.nextUrl.searchParams.get("mode") ?? "regular";
    if (!isGameMode(rawMode) || rawMode === "seasonal") {
      return NextResponse.json({ error: "Invalid game mode" }, { status: 400 });
    }
    const now = Date.now();
    let cached = memo.get(rawMode);
    if (!cached || now - cached.ts >= MEMO_TTL_MS) {
      cached = { ...(await loadBaseline(rawMode)), ts: now };
      memo.set(rawMode, cached);
    }

    // Cheap (own 6h cache); failure falls back to id-as-name and recovers next request.
    const meta = await getAchievements().catch(() => new Map());

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
    return NextResponse.json(payload, {
      headers: { "Cache-Control": "public, max-age=300" },
    });
  } catch (e) {
    console.error("achievement baseline failed", e);
    return NextResponse.json({ error: "Failed to compute achievement baseline" }, { status: 500 });
  }
}
