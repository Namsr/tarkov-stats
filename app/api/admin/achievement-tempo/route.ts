import { requireAdmin } from "@/lib/admin-auth";
import { ADMIN_NO_STORE_HEADERS } from "@/lib/admin/mutation";
import { readTempoReport } from "@/lib/achievement-tempo-store";
import { loadSeasonalCycleConfig } from "@/lib/seasonal/config";
import { parsePlayerId } from "@/lib/player-id";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const access = await requireAdmin();
  if (!access.ok) return Response.json({ error: "admin_access_denied" }, { status: access.status, headers: ADMIN_NO_STORE_HEADERS });
  const params = new URL(request.url).searchParams;
  const mode = params.get("mode") ?? "regular";
  const aidInput = params.get("aid");
  const aid = aidInput === null ? null : /^\d{1,15}$/.test(aidInput) ? parsePlayerId(aidInput) : null;
  if ((mode !== "regular" && mode !== "seasonal") || (aidInput !== null && aid === null)) {
    return Response.json({ error: "invalid_request" }, { status: 400, headers: ADMIN_NO_STORE_HEADERS });
  }
  const cycle = loadSeasonalCycleConfig();
  if (mode === "seasonal" && !cycle?.enabled) return Response.json({ available: false, reason: "season_unavailable" }, { headers: ADMIN_NO_STORE_HEADERS });
  const scope = mode === "regular" ? { mode, cycleId: "persistent", startsAt: 0, endsAt: null } as const
    : { mode, cycleId: cycle!.cycleId, startsAt: cycle!.startsAt, endsAt: cycle!.endsAt } as const;
  const sourcePath = process.env.PROGRESSION_SQLITE_PATH || process.env.PROGRESSION_DB_PATH || "/data/progression.db";
  let source: DatabaseSync | undefined, output: DatabaseSync | undefined;
  try {
    source = new DatabaseSync(sourcePath, { readOnly: true });
    output = new DatabaseSync(process.env.ACHIEVEMENT_TEMPO_SQLITE_PATH || join(dirname(sourcePath), "achievement-tempo.db"), { readOnly: true });
    source.exec("PRAGMA busy_timeout=250");
    output.exec("PRAGMA busy_timeout=250");
    // Pin exclusion state and generation while assembling the private response.
    source.exec("BEGIN");
    output.exec("BEGIN");
    return Response.json(readTempoReport(source, output, scope, aid), { headers: ADMIN_NO_STORE_HEADERS });
  } catch (error) {
    console.error("admin achievement tempo unavailable", error);
    return Response.json({ available: false, reason: "storage_unavailable" }, { status: 503, headers: ADMIN_NO_STORE_HEADERS });
  } finally { output?.close(); source?.close(); }
}
