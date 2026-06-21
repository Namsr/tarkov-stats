import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getFavoritesStore } from "@/lib/db";
import { getRateLimitHeaders } from "@/lib/rate-limiter";
import { getClientIp } from "@/lib/client-ip";
import { parsePlayerId } from "@/lib/player-id";

const NICK_MAX = 32;
const NOTE_MAX = 120;

/** Trim a free-text field to `max` chars; empty/non-string becomes null. */
function clean(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().slice(0, max);
  return s.length ? s : null;
}

type Guard =
  | { ok: true; sub: string; headers: Record<string, string> }
  | { ok: false; response: NextResponse };

// Shared gate for every favorites mutation: rate-limit by IP, then require a
// signed-in user. Returns the user's stable id (`sub`) or a ready response.
async function guard(request: NextRequest): Promise<Guard> {
  const { allowed, headers } = getRateLimitHeaders(getClientIp(request), { bucket: "favorites" });
  if (!allowed) {
    return { ok: false, response: NextResponse.json({ error: "Rate limit exceeded" }, { status: 429, headers }) };
  }
  const user = await getSession();
  if (!user) {
    return { ok: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401, headers }) };
  }
  return { ok: true, sub: user.sub, headers };
}

// List the signed-in user's pinned accounts.
export async function GET(request: NextRequest) {
  const g = await guard(request);
  if (!g.ok) return g.response;

  const store = await getFavoritesStore();
  if (!store) return NextResponse.json({ favorites: [] }, { headers: g.headers });

  const favorites = await store.list(g.sub);
  return NextResponse.json({ favorites }, { headers: { ...g.headers, "Cache-Control": "no-store" } });
}

// Pin an account. Body: { aid, nickname?, note? }.
export async function POST(request: NextRequest) {
  const g = await guard(request);
  if (!g.ok) return g.response;

  const body = (await request.json().catch(() => null)) as
    | { aid?: unknown; nickname?: unknown; note?: unknown }
    | null;
  if (!body) return NextResponse.json({ error: "Invalid body" }, { status: 400, headers: g.headers });

  const aid = parsePlayerId(String(body.aid ?? ""));
  if (aid === null) {
    return NextResponse.json({ error: "Invalid account ID" }, { status: 400, headers: g.headers });
  }

  const store = await getFavoritesStore();
  if (!store) return NextResponse.json({ error: "Storage unavailable" }, { status: 503, headers: g.headers });

  const result = await store.add(g.sub, aid, clean(body.nickname, NICK_MAX), clean(body.note, NOTE_MAX));
  if (result === "limit") return NextResponse.json({ error: "limit" }, { status: 409, headers: g.headers });
  if (result === "exists") return NextResponse.json({ ok: true, already: true }, { headers: g.headers });
  return NextResponse.json({ ok: true }, { status: 201, headers: g.headers });
}

// Unpin an account. Query: ?aid=
export async function DELETE(request: NextRequest) {
  const g = await guard(request);
  if (!g.ok) return g.response;

  const aid = parsePlayerId(request.nextUrl.searchParams.get("aid") ?? "");
  if (aid === null) {
    return NextResponse.json({ error: "Invalid account ID" }, { status: 400, headers: g.headers });
  }

  const store = await getFavoritesStore();
  if (store) await store.remove(g.sub, aid);
  return NextResponse.json({ ok: true }, { headers: g.headers });
}

// Update a pin. Body: { aid, note?, main?: true }.
export async function PATCH(request: NextRequest) {
  const g = await guard(request);
  if (!g.ok) return g.response;

  const body = (await request.json().catch(() => null)) as
    | { aid?: unknown; note?: unknown; main?: unknown }
    | null;
  if (!body) return NextResponse.json({ error: "Invalid body" }, { status: 400, headers: g.headers });

  const aid = parsePlayerId(String(body.aid ?? ""));
  if (aid === null) {
    return NextResponse.json({ error: "Invalid account ID" }, { status: 400, headers: g.headers });
  }

  const store = await getFavoritesStore();
  if (!store) return NextResponse.json({ error: "Storage unavailable" }, { status: 503, headers: g.headers });

  if (body.main === true) await store.setMain(g.sub, aid);
  // Only touch the note when the field is present (distinguishes "clear" from "absent").
  if ("note" in body) await store.setNote(g.sub, aid, clean(body.note, NOTE_MAX));

  return NextResponse.json({ ok: true }, { headers: g.headers });
}
