import { NextResponse } from "next/server";
import { getSupportStore, type SupportConfig, type SupportSiteLanguage } from "@/lib/admin/support-db";

export const runtime = "nodejs";

const EMPTY: SupportConfig = { notifications: [], goal: null };

// Notifications and the donation goal are public and carry no per-user data, so
// every response this route can produce — including the storage-missing fallback —
// gets this one cache policy. Failing open on an empty config hides the block
// instead of breaking the support page.
const PUBLIC_CACHE = { "Cache-Control": "public, max-age=30, s-maxage=60", Vary: "Accept-Language" };

function requestedLanguage(request?: Request): SupportSiteLanguage | undefined {
  const header = request?.headers.get("accept-language");
  // No header keeps the old all-audiences response for direct API consumers.
  if (!header) return undefined;
  const preferences = header
    .split(",")
    .map((part) => {
      const [tag, ...params] = part.trim().toLowerCase().split(";");
      const q = params.map((param) => param.trim()).find((param) => param.startsWith("q="));
      const quality = q ? Number(q.slice(2)) : 1;
      return { tag: tag.trim(), quality: Number.isFinite(quality) ? quality : 0 };
    })
    .filter(({ tag, quality }) => tag !== "" && quality > 0)
    .sort((left, right) => right.quality - left.quality);
  for (const { tag } of preferences) {
    if (tag === "en" || tag.startsWith("en-")) return "en";
    if (tag === "ru" || tag.startsWith("ru-")) return "ru";
  }
  return "ru";
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
