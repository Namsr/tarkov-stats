import { ADMIN_NO_STORE_HEADERS } from "@/lib/admin/mutation";
import { getAxisLeagueStore } from "@/lib/admin/axis-league-db";
import { requireAxisScreenshotSubmitter } from "@/lib/axis-access";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const metadata = new URL(request.url).searchParams.get("meta") === "1";
  const auth = await requireAxisScreenshotSubmitter();
  if (!auth.ok) return Response.json({ error: auth.status === 401 ? "Unauthorized" : "Forbidden" }, { status: auth.status, headers: ADMIN_NO_STORE_HEADERS });
  const params = new URL(request.url).searchParams;
  const number = Number(params.get("match")), revision = params.get("v");
  if (!Number.isSafeInteger(number) || number <= 0 || !metadata && (!revision || !/^[a-f0-9]{64}$/.test(revision))) {
    return Response.json({ error: "invalid_match_photo" }, { status: 400, headers: ADMIN_NO_STORE_HEADERS });
  }
  try {
    const store = await getAxisLeagueStore();
    if (metadata) return Response.json({ matchNumber: number, photo: store.readMatchPhotoMetadata(number) }, { headers: ADMIN_NO_STORE_HEADERS });
    if (!revision) return new Response(null, { status: 404, headers: ADMIN_NO_STORE_HEADERS });
    const photo = store.readAxisMatchSubmissionPhoto(number, revision) ?? store.readMatchPhoto(number);
    if (!photo || photo.revision !== revision) return new Response(null, { status: 404, headers: ADMIN_NO_STORE_HEADERS });
    return new Response(new Uint8Array(photo.data), { headers: { ...ADMIN_NO_STORE_HEADERS,
      "Content-Type": "image/png", "Content-Length": String(photo.data.byteLength),
      "Content-Disposition": `inline; filename="axis-match-${number}.png"`, "X-Content-Type-Options": "nosniff" } });
  } catch { return Response.json({ error: "photo_unavailable" }, { status: 503, headers: ADMIN_NO_STORE_HEADERS }); }
}
