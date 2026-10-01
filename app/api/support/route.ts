import { NextResponse } from "next/server";
import { getSupportStore, type SupportConfig } from "@/lib/admin/support-db";

export const runtime = "nodejs";

const EMPTY: SupportConfig = { notifications: [], goal: null };

// Notifications and the donation goal are public and carry no per-user data, so
// every response this route can produce — including the storage-missing fallback —
// gets this one cache policy. Failing open on an empty config hides the block
// instead of breaking the support page.
const PUBLIC_CACHE = { "Cache-Control": "public, max-age=30, s-maxage=60" };

function respond(config: SupportConfig) {
  return NextResponse.json(config, { headers: PUBLIC_CACHE });
}

export async function GET() {
  try {
    const store = await getSupportStore();
    if (!store) return respond(EMPTY);
    return respond(store.getActive());
  } catch (error) {
    console.warn("support content read failed", error);
    return respond(EMPTY);
  }
}
