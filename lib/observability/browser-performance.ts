// Shared allowlists keep browser telemetry free of URLs, queries and identities.
export const BROWSER_METRICS = ["ttfb", "dns", "connect", "tls", "download", "dom_interactive", "load", "client_ready", "fcp", "lcp", "long_task", "api_total", "api_ttfb", "api_download", "api_server"] as const;
export const BROWSER_ENDPOINTS = ["profile", "search", "risk", "cohort", "average", "baseline", "progression", "leaderboard", "comparison"] as const;
export type BrowserMetric = typeof BROWSER_METRICS[number];
export type BrowserEndpoint = typeof BROWSER_ENDPOINTS[number];
export type BrowserSample = { metric: BrowserMetric; value: number; endpoint: BrowserEndpoint | null };

export function browserPage(path: string): string | null {
  const player = /^\/player\/(regular|pve|arena|pvp-season)\/(?:[^/]+)$/.exec(path);
  if (player) return `/player/${player[1]}/:account`;
  if (/^\/player\/[^/]+$/.test(path)) return "/player/:account";
  if (/^\/(?:population|average)\/(?:regular|pve|arena|pvp-season)$/.test(path)) return path;
  return ["/", "/population", "/average", "/leaderboard", "/compare"].includes(path) ? path : null;
}

export function browserEndpoint(path: string): BrowserEndpoint | null {
  if (path === "/api/player/risk") return "risk";
  if (/^\/api\/(?:average|seasonal)\/cohort(?:\/batch)?$/.test(path)) return "cohort";
  if (/^\/api\/(?:seasonal\/)?average$/.test(path)) return "average";
  if (/^\/api\/baseline(?:\/|$)/.test(path)) return "baseline";
  if (/^\/api\/(?:seasonal\/)?progression(?:\/|$)/.test(path)) return "progression";
  if (/^\/api\/leaderboard(?:\/|$)/.test(path)) return "leaderboard";
  if (/^\/api\/compare(?:\/|$)/.test(path)) return "comparison";
  if (/^\/api\/player\/search$/.test(path)) return "search";
  if (/^\/api\/(?:seasonal\/)?player\/[^/]+$/.test(path)) return "profile";
  return null;
}

export function parseBrowserSamples(value: unknown): BrowserSample[] | null {
  if (!Array.isArray(value) || !value.length || value.length > 20) return null;
  const samples: BrowserSample[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const { metric, value: duration, endpoint } = raw;
    if (!BROWSER_METRICS.includes(metric) || typeof duration !== "number" || !Number.isFinite(duration) || duration < 0 || duration > 300_000) return null;
    const api = metric.startsWith("api_");
    if (api ? !BROWSER_ENDPOINTS.includes(endpoint) : endpoint != null) return null;
    samples.push({ metric, value: Math.round(duration * 100) / 100, endpoint: api ? endpoint : null });
  }
  return samples;
}

export function resourceSamples(entry: PerformanceResourceTiming, origin: string): BrowserSample[] {
  let endpoint: BrowserEndpoint | null;
  try {
    const url = new URL(entry.name);
    if (url.origin !== origin) return [];
    endpoint = browserEndpoint(url.pathname);
  } catch { return []; }
  if (!endpoint || entry.responseEnd <= 0) return [];
  const samples: BrowserSample[] = [{ metric: "api_total", value: entry.duration, endpoint }];
  if (entry.requestStart > 0 && entry.responseStart > 0) samples.push({ metric: "api_ttfb", value: entry.responseStart - entry.requestStart, endpoint });
  if (entry.responseStart > 0) samples.push({ metric: "api_download", value: entry.responseEnd - entry.responseStart, endpoint });
  const server = entry.serverTiming?.find((item) => item.name === "total");
  if (server) samples.push({ metric: "api_server", value: server.duration, endpoint });
  return samples;
}
