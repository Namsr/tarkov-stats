import { getAxisLeagueStore } from "@/lib/admin/axis-league-db";
import { ADMIN_NO_STORE_HEADERS } from "@/lib/admin/mutation";
import { requireAxisKdaEditor } from "@/lib/axis-access";
import { axisOcrContextForMatch, AxisOcrMatchMismatchError } from "@/lib/axis-server-match-validation";

export const runtime = "nodejs";

function readMatchNumber(request: Request): number | null {
  const params = new URL(request.url).searchParams;
  const raw = params.getAll("match");
  if (raw.length !== 1 || !/^[1-9]\d{0,8}$/.test(raw[0])) return null;
  return Number(raw[0]);
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
    return Response.json(await axisOcrContextForMatch(match), { headers: ADMIN_NO_STORE_HEADERS });
  } catch (error) {
    if (error instanceof AxisOcrMatchMismatchError) {
      return Response.json({ error: "unsupported_roster" }, { status: 422, headers: ADMIN_NO_STORE_HEADERS });
    }
    return Response.json({ error: "ocr_context_unavailable" }, { status: 503, headers: ADMIN_NO_STORE_HEADERS });
  }
}
