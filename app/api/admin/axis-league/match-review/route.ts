import { ADMIN_NO_STORE_HEADERS } from "@/lib/admin/mutation";
import { getAxisLeagueStore } from "@/lib/admin/axis-league-db";
import { requireAxisModerator } from "@/lib/axis-access";

export const runtime = "nodejs";

function readMatchNumbers(request: Request): number[] | null {
  const params = new URL(request.url).searchParams;
  const values = params.get("matches")?.split(",") ?? params.getAll("match");
  if (!values.length || values.length > 25) return null;
  const numbers = values.map((value) => Number(value));
  if (numbers.some((value) => !Number.isSafeInteger(value) || value <= 0)) return null;
  return [...new Set(numbers)];
}

export async function GET(request: Request) {
  const access = await requireAxisModerator();
  if (!access.ok) return Response.json({ error: access.status === 401 ? "Unauthorized" : "Forbidden" }, { status: access.status, headers: ADMIN_NO_STORE_HEADERS });
  const numbers = readMatchNumbers(request);
  if (!numbers) return Response.json({ error: "invalid_matches" }, { status: 400, headers: ADMIN_NO_STORE_HEADERS });
  try {
    const store = await getAxisLeagueStore();
    const reviews = numbers.map((matchNumber) => {
      const history = store.readMatchHistory(matchNumber).matches[0];
      if (!history || history.number !== matchNumber) return null;
      const review = store.readAxisMatchReview(matchNumber);
      // Legacy moderator uploads predate the evidence table. They still need
      // to surface missing KDA, but the metadata read must stay BLOB-free.
      const hasPhoto = Boolean(store.readMatchPhotoMetadata(matchNumber));
      return review && (review.submissions.length > 0 || hasPhoto) ? review : null;
    }).filter((review): review is NonNullable<typeof review> => review !== null);
    return Response.json({ reviews }, { headers: ADMIN_NO_STORE_HEADERS });
  } catch { return Response.json({ error: "match_review_unavailable" }, { status: 503, headers: ADMIN_NO_STORE_HEADERS }); }
}
