import { NextResponse } from "next/server";
import { getSupportStore, type SupportConfig, type SupportSiteLanguage } from "@/lib/admin/support-db";

export const runtime = "nodejs";

const EMPTY: SupportConfig = { notifications: [], goal: null };

// Notifications and the donation goal are public and carry no per-user data, so
// every response this route can produce — including the storage-missing fallback —
// gets this one cache policy. Failing open on an empty config hides the block
// instead of breaking the support page.
const PUBLIC_CACHE = { "Cache-Control": "public, max-age=30, s-maxage=60", Vary: "Accept-Language" };

function requestedLanguage(request?: Request): SupportSiteLanguage {
  const header = request?.headers.get("accept-language")?.split(",", 1)[0]?.trim().toLowerCase();
  return header === "en" || header?.startsWith("en-") ? "en" : "ru";
}

function respond(config: SupportConfig) {
  return NextResponse.json(config, { headers: PUBLIC_CACHE });
}

export async function GET(request?: Request) {
  try {
    const store = await getSupportStore();
    if (!store) return respond(EMPTY);
    return respond(store.getActive(requestedLanguage(request)));
  } catch (error) {
    console.warn("support content read failed", error);
    return respond(EMPTY);
  }
}
