// First-party pageview counter helpers (own alternative to Cloudflare RUM).
//
// Privacy design: the server stores only an anonymous client-generated visitor
// id, a normalized path and a referrer *host*. No IP addresses, no full URLs,
// no user-agent strings. Clients with `DNT: 1` / `navigator.doNotTrack` are
// skipped before anything is sent.

export const PAGEVIEW_SESSION_GAP_MS = 30 * 60_000;
export const PAGEVIEW_VISITOR_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
export const PAGEVIEW_MAX_PATH_LENGTH = 500;
export const PAGEVIEW_MAX_HOST_LENGTH = 253;

const BOT_PATTERN =
  /bot|crawl|spider|slurp|mediapartners|baidu|sogou|exabot|facebot|ia_archiver|semrush|ahrefs|mj12|dotbot|petal|bytespider|gptbot|claudebot|ccbot|perplexity|facebookexternalhit|twitterbot|linkedinbot|embedly|slackbot|telegrambot|discordbot|whatsapp|google-inspection|adsbot|lighthouse|headless|phantom|puppeteer|playwright|selenium|httpclient|curl|wget|python-requests|go-http-client/i;

export function isBotUserAgent(value: string | null | undefined): boolean {
  if (!value) return false;
  return BOT_PATTERN.test(value);
}

export function isValidVisitorId(value: unknown): value is string {
  return typeof value === "string" && PAGEVIEW_VISITOR_PATTERN.test(value);
}

export function isValidPageviewPath(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("/") && value.length <= PAGEVIEW_MAX_PATH_LENGTH;
}

/** Keep only the hostname of a referrer (full URL or bare hostname); null when unusable. */
export function normalizeReferrerHost(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  const trimmed = value.trim().toLowerCase().replace(/\.$/, "");
  if (!trimmed || trimmed.length > PAGEVIEW_MAX_HOST_LENGTH || trimmed.includes(" ")) return null;
  if (trimmed.includes("://")) {
    try {
      const host = new URL(trimmed).hostname.trim().toLowerCase().replace(/\.$/, "");
      return isBareHostname(host) ? host : null;
    } catch {
      return null;
    }
  }
  if (trimmed.includes("/")) return null;
  return isBareHostname(trimmed) ? trimmed : null;
}

const BARE_HOSTNAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

function isBareHostname(value: string): boolean {
  return BARE_HOSTNAME.test(value);
}
