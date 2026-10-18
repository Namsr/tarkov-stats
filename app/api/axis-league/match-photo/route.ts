import { ADMIN_NO_STORE_HEADERS, rejectInvalidAdminMutation } from "@/lib/admin/mutation";
import { getAxisLeagueStore } from "@/lib/admin/axis-league-db";
import { requireAxisKdaEditor } from "@/lib/axis-access";
import { AxisKdaConflict } from "@/lib/axis-kda";
import { AxisPhotoInputError } from "@/lib/axis-match-photo";
import { normalizeAxisPhoto, readAxisPhotoBody } from "@/lib/axis-photo-upload";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const auth = await requireAxisKdaEditor();
  if (!auth.ok) return Response.json({ error: auth.status === 401 ? "Unauthorized" : "Forbidden" }, { status: auth.status, headers: ADMIN_NO_STORE_HEADERS });
  const params = new URL(request.url).searchParams;
  const number = Number(params.get("match")), revision = params.get("v");
  const metadata = params.get("meta") === "1";
  if (!Number.isSafeInteger(number) || number <= 0 || !metadata && (!revision || !/^[a-f0-9]{64}$/.test(revision))) {
    return Response.json({ error: "invalid_match_photo" }, { status: 400, headers: ADMIN_NO_STORE_HEADERS });
  }
  try {
    const store = await getAxisLeagueStore();
    if (metadata) return Response.json({ matchNumber: number, photo: store.readMatchPhotoMetadata(number) }, { headers: ADMIN_NO_STORE_HEADERS });
    const photo = store.readMatchPhoto(number);
    if (!photo || photo.revision !== revision) return new Response(null, { status: 404, headers: ADMIN_NO_STORE_HEADERS });
    return new Response(new Uint8Array(photo.data), { headers: { ...ADMIN_NO_STORE_HEADERS,
      "Content-Type": "image/png", "Content-Length": String(photo.data.byteLength),
      "Content-Disposition": `inline; filename="axis-match-${number}.png"`, "X-Content-Type-Options": "nosniff" } });
  } catch { return Response.json({ error: "photo_unavailable" }, { status: 503, headers: ADMIN_NO_STORE_HEADERS }); }
}

export async function POST(request: Request) {
  const rejected = await rejectInvalidAdminMutation(request, requireAxisKdaEditor);
  if (rejected) return rejected;
  try {
    const body = await readAxisPhotoBody(request) as { matchNumber?: unknown; expected?: unknown; data?: unknown } | null;
    if (!body || !Number.isSafeInteger(body.matchNumber) || Number(body.matchNumber) <= 0
      || body.expected !== null && (typeof body.expected !== "string" || !/^[a-f0-9]{64}$/.test(body.expected))
      || body.data !== null && typeof body.data !== "string") throw new AxisPhotoInputError();
    const photo = body.data === null ? null : await normalizeAxisPhoto(body.data);
    const store = await getAxisLeagueStore();
    // Recheck after decoding: a role may have been revoked while the image was processed.
    const auth = await requireAxisKdaEditor();
    if (!auth.ok) return Response.json({ error: "Forbidden" }, { status: auth.status, headers: ADMIN_NO_STORE_HEADERS });
    const saved = store.setMatchPhoto(Number(body.matchNumber), body.expected as string | null, photo);
    return Response.json({ ok: true, matchNumber: body.matchNumber, photo: saved }, { headers: ADMIN_NO_STORE_HEADERS });
  } catch (error) {
    const status = error instanceof AxisKdaConflict ? 409 : error instanceof AxisPhotoInputError ? error.status
      : error instanceof TypeError || error instanceof RangeError || error instanceof SyntaxError ? 400 : 503;
    return Response.json({ error: status === 409 ? "photo_conflict" : status === 413 ? "photo_too_large" : status === 400 ? "invalid_match_photo" : "photo_unavailable" }, { status, headers: ADMIN_NO_STORE_HEADERS });
  }
}
