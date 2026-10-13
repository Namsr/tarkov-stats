import { NextRequest, NextResponse } from "next/server";
import { getAnalyticsStore } from "@/lib/admin/analytics-db";
import { isBotUserAgent, isValidPageviewPath } from "@/lib/admin/pageviews";
import { ADMIN_NO_STORE_HEADERS, canonicalAdminHost } from "@/lib/admin/types";
import { browserPage, parseBrowserSamples } from "@/lib/observability/browser-performance";
import { checkRateLimit } from "@/lib/rate-limiter";
import { getClientIp } from "@/lib/client-ip";

export const runtime = "nodejs";
const empty = () => new NextResponse(null, { status: 204, headers: ADMIN_NO_STORE_HEADERS });

export async function POST(request: NextRequest) {
  if (request.headers.get("dnt") === "1" || isBotUserAgent(request.headers.get("user-agent"))) return empty();
  const host = canonicalAdminHost(request.headers.get("x-forwarded-host") ?? request.headers.get("host"));
  if (!host) return empty();
  const origin = request.headers.get("origin");
  if (!origin || !["https://tarkovstats.ru", "https://tarkovstats.online", "https://www.tarkovstats.ru", "https://www.tarkovstats.online"].includes(origin)
    || canonicalAdminHost(new URL(origin).host) !== host || request.headers.get("sec-fetch-site") === "cross-site") return empty();
  if (!checkRateLimit(getClientIp(request), { bucket: "browser-performance", max: 20 }).allowed) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: ADMIN_NO_STORE_HEADERS });
  }
  // Bound the streamed body, including clients omitting Content-Length.
  const reader = request.body?.getReader();
  if (!reader) return empty();
  let text = "";
  let bytes = 0;
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 8192) { await reader.cancel(); return empty(); }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    const body = JSON.parse(text);
    if (!body || !isValidPageviewPath(body.path)) return empty();
    const path = browserPage(body.path);
    if (!path) return empty();
    const samples = parseBrowserSamples(body.samples);
    if (!samples) return empty();
    const store = await getAnalyticsStore();
    store?.recordBrowserPerformance(host, path, samples);
  } catch { /* Telemetry must not affect page rendering. */ }
  return empty();
}
