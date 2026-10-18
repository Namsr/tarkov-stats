import { getArenaProfile } from "@/lib/arena/service";
import { getAxisLeagueStore } from "@/lib/admin/axis-league-db";
import { ADMIN_NO_STORE_HEADERS } from "@/lib/admin/mutation";
import { requireAxisKdaEditor } from "@/lib/axis-access";
import type { AxisOcrContext, AxisOcrParticipant } from "@/lib/axis-ocr";

export const runtime = "nodejs";

function readMatchNumber(request: Request): number | null {
  const params = new URL(request.url).searchParams;
  const raw = params.getAll("match");
  if (raw.length !== 1 || !/^[1-9]\d{0,8}$/.test(raw[0])) return null;
  return Number(raw[0]);
}

function isSupportedRoster(teams: readonly { players: readonly { id: string }[] }[]): boolean {
  if (teams.length !== 2 || teams.some((team) => team.players.length !== 5)) return false;
  const ids = new Set<string>();
  for (const team of teams) {
    for (const player of team.players) {
      if (!player.id || ids.has(player.id)) return false;
      ids.add(player.id);
    }
  }
  return ids.size === 10;
}

export async function GET(request: Request) {
  const access = await requireAxisKdaEditor();
  if (!access.ok) {
    return Response.json({ error: access.status === 401 ? "Unauthorized" : "Forbidden" }, {
      status: access.status,
      headers: ADMIN_NO_STORE_HEADERS,
    });
  }

  const matchNumber = readMatchNumber(request);
  if (matchNumber == null) {
    return Response.json({ error: "invalid_match" }, { status: 400, headers: ADMIN_NO_STORE_HEADERS });
  }

  try {
    const store = await getAxisLeagueStore();
    const match = store.readMatchHistory(matchNumber).matches[0];
    if (!match || match.number !== matchNumber) {
      return Response.json({ error: "match_not_found" }, { status: 404, headers: ADMIN_NO_STORE_HEADERS });
    }
    if (!isSupportedRoster(match.teams)) {
      return Response.json({ error: "unsupported_roster" }, { status: 422, headers: ADMIN_NO_STORE_HEADERS });
    }

    const linkedAids = new Set<number>();
    for (const team of match.teams) {
      for (const player of team.players) {
        if (player.profile && Number.isSafeInteger(player.profile.aid) && player.profile.aid > 0) {
          linkedAids.add(player.profile.aid);
        }
      }
    }

    const nicknameByAid = new Map<number, string | null>();
    await Promise.all([...linkedAids].map(async (aid) => {
      try {
        const profile = await getArenaProfile(aid);
        const nickname = profile?.nickname?.trim() ?? "";
        nicknameByAid.set(aid, nickname && nickname.toLowerCase() !== "unknown" ? nickname : null);
      } catch {
        // A missing stored profile should leave the history name usable for OCR matching.
        nicknameByAid.set(aid, null);
      }
    }));

    const participants: AxisOcrParticipant[] = match.teams.flatMap((team, teamIndex) => team.players.map((player) => ({
      discordId: player.id,
      teamIndex,
      historyName: player.name,
      arenaNickname: player.profile ? nicknameByAid.get(player.profile.aid) ?? null : null,
    })));
    const context: AxisOcrContext = { matchNumber, participants };
    return Response.json(context, { headers: ADMIN_NO_STORE_HEADERS });
  } catch {
    return Response.json({ error: "ocr_context_unavailable" }, { status: 503, headers: ADMIN_NO_STORE_HEADERS });
  }
}
