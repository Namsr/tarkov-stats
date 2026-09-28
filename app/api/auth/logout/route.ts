import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth/session";

// Nothing from this route is cacheable. It is the credential-clearing response,
// and a shared cache in front of the app (Cloudflare / Caddy — the documented
// deploy) was free to store and replay `{"ok":true}` to the next caller.
const noStore = { "Cache-Control": "no-store" };

// Clear the session cookie. Client reloads after calling this.
export async function POST() {
  const res = NextResponse.json({ ok: true }, { headers: noStore });
  res.cookies.delete(SESSION_COOKIE);
  return res;
}
