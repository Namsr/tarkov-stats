import type { AdminDomain, AdminPeriod } from "./types.ts";
// @ts-expect-error Node's strip-types test runner requires the extension; Next accepts it.
import { canonicalAdminHost, periodMilliseconds } from "./types.ts";

const ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";

export const CLOUDFLARE_TRAFFIC_QUERY = `
query AdminTraffic($accountTag: string!, $filter: AccountRumPageloadEventsAdaptiveGroupsFilter_InputObject!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      domains: rumPageloadEventsAdaptiveGroups(filter: $filter, limit: 100, orderBy: [count_DESC]) {
        count avg { sampleInterval } sum { visits } dimensions { requestHost }
      }
      series: rumPageloadEventsAdaptiveGroups(filter: $filter, limit: 10000, orderBy: [datetimeHour_ASC]) {
        count avg { sampleInterval } sum { visits } dimensions { datetimeHour requestHost requestPath }
      }
      pages: rumPageloadEventsAdaptiveGroups(filter: $filter, limit: 10000, orderBy: [count_DESC]) {
        count avg { sampleInterval } sum { visits } dimensions { requestHost requestPath }
      }
      referrers: rumPageloadEventsAdaptiveGroups(filter: $filter, limit: 1000, orderBy: [count_DESC]) {
        count avg { sampleInterval } sum { visits } dimensions { requestHost refererHost }
      }
      countries: rumPageloadEventsAdaptiveGroups(filter: $filter, limit: 1000, orderBy: [count_DESC]) {
        count avg { sampleInterval } sum { visits } dimensions { requestHost countryName }
      }
      devices: rumPageloadEventsAdaptiveGroups(filter: $filter, limit: 100, orderBy: [count_DESC]) {
        count avg { sampleInterval } sum { visits } dimensions { requestHost deviceType }
      }
      browsers: rumPageloadEventsAdaptiveGroups(filter: $filter, limit: 1000, orderBy: [count_DESC]) {
        count avg { sampleInterval } sum { visits } dimensions { requestHost userAgentBrowser }
      }
    }
  }
}`;

type Group = {
  count?: unknown;
  avg?: { sampleInterval?: unknown } | null;
  sum?: { visits?: unknown } | null;
  dimensions?: Record<string, unknown> | null;
};

type TrafficAccount = Record<string, Group[] | undefined>;

export interface TrafficRank {
  key: string;
  pageviews: number;
  visits: number;
}

export interface CloudflareTraffic {
  available: boolean;
  reason?: "not_configured" | "upstream_error" | "invalid_response";
  from: string;
  to: string;
  pageviews: number;
  visits: number;
  sampled: boolean;
  domains: TrafficRank[];
  series: Array<{ at: string; domains: Record<string, { pageviews: number; visits: number }> }>;
  pages: TrafficRank[];
  referrers: TrafficRank[];
  countries: TrafficRank[];
  devices: TrafficRank[];
  browsers: TrafficRank[];
}

function emptyTraffic(from: number, to: number, reason?: CloudflareTraffic["reason"]): CloudflareTraffic {
  return {
    available: reason === undefined, ...(reason ? { reason } : {}),
    from: new Date(from).toISOString(), to: new Date(to).toISOString(),
    pageviews: 0, visits: 0, sampled: to - from > 7 * 86_400_000,
    domains: [], series: [], pages: [], referrers: [], countries: [], devices: [], browsers: [],
  };
}

function n(value: unknown): number {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
}

export function normalizeTrafficPath(value: unknown): string {
  const path = typeof value === "string" && value.startsWith("/") ? value : "/";
  if (path === "/admin" || path.startsWith("/admin/")) return "/admin";
  if (path === "/player" || path.startsWith("/player/")) return "/player/:account";
  return path.split("?", 1)[0].replace(/\/{2,}/g, "/");
}

function accepted(group: Group, domain: AdminDomain): { host: string; dimensions: Record<string, unknown> } | null {
  const dimensions = group.dimensions ?? {};
  const host = canonicalAdminHost(typeof dimensions.requestHost === "string" ? dimensions.requestHost : null);
  if (!host || (domain !== "all" && host !== domain)) return null;
  if (normalizeTrafficPath(dimensions.requestPath) === "/admin") return null;
  return { host, dimensions };
}

function ranks(groups: Group[] | undefined, domain: AdminDomain, field: string, normalize?: (value: unknown) => string): TrafficRank[] {
  const values = new Map<string, { pageviews: number; visits: number }>();
  for (const group of groups ?? []) {
    const row = accepted(group, domain);
    if (!row) continue;
    const raw = row.dimensions[field];
    const key = normalize ? normalize(raw) : typeof raw === "string" && raw ? raw : "(unknown)";
    const current = values.get(key) ?? { pageviews: 0, visits: 0 };
    current.pageviews += n(group.count);
    current.visits += n(group.sum?.visits);
    values.set(key, current);
  }
  return [...values].map(([key, value]) => ({ key, ...value }))
    .sort((a, b) => b.pageviews - a.pageviews || a.key.localeCompare(b.key)).slice(0, 50);
}

export function parseCloudflareTraffic(account: TrafficAccount, domain: AdminDomain, from: number, to: number): CloudflareTraffic {
  const result = emptyTraffic(from, to);
  result.domains = ranks(account.domains, domain, "requestHost", (value) => canonicalAdminHost(String(value)) ?? "(unknown)");
  result.pages = ranks(account.pages, domain, "requestPath", normalizeTrafficPath);
  result.referrers = ranks(account.referrers, domain, "refererHost");
  result.countries = ranks(account.countries, domain, "countryName");
  result.devices = ranks(account.devices, domain, "deviceType");
  result.browsers = ranks(account.browsers, domain, "userAgentBrowser");
  result.pageviews = result.domains.reduce((sum, item) => sum + item.pageviews, 0);
  result.visits = result.domains.reduce((sum, item) => sum + item.visits, 0);

  const buckets = new Map<string, Record<string, { pageviews: number; visits: number }>>();
  for (const group of account.series ?? []) {
    const row = accepted(group, domain);
    if (!row) continue;
    const at = typeof row.dimensions.datetimeHour === "string" ? row.dimensions.datetimeHour : "";
    if (!at) continue;
    const domains = buckets.get(at) ?? {};
    const value = domains[row.host] ?? { pageviews: 0, visits: 0 };
    value.pageviews += n(group.count);
    value.visits += n(group.sum?.visits);
    domains[row.host] = value;
    buckets.set(at, domains);
  }
  result.series = [...buckets].sort(([a], [b]) => a.localeCompare(b)).map(([at, domains]) => ({ at, domains }));
  result.sampled ||= Object.values(account).some((groups) => groups?.some((group) => n(group.avg?.sampleInterval) > 1));
  return result;
}

export async function fetchCloudflareTrafficRange(
  from: number,
  to: number,
  domain: AdminDomain,
  options: { fetch?: typeof fetch; accountId?: string; token?: string } = {},
): Promise<CloudflareTraffic> {
  const accountId = options.accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = options.token ?? process.env.CLOUDFLARE_ANALYTICS_API_TOKEN;
  if (!accountId || !token) return emptyTraffic(from, to, "not_configured");
  try {
    const response = await (options.fetch ?? fetch)(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        query: CLOUDFLARE_TRAFFIC_QUERY,
        variables: {
          accountTag: accountId,
          filter: {
            AND: [
              { datetime_geq: new Date(from).toISOString(), datetime_leq: new Date(to).toISOString(), bot: 0 },
              { OR: [
                { requestHost: "tarkovstats.ru" }, { requestHost: "www.tarkovstats.ru" },
                { requestHost: "tarkovstats.online" }, { requestHost: "www.tarkovstats.online" },
              ] },
            ],
          },
        },
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return emptyTraffic(from, to, "upstream_error");
    const payload = await response.json() as {
      data?: { viewer?: { accounts?: TrafficAccount[] } };
      errors?: unknown[] | null;
    };
    if (payload.errors?.length) return emptyTraffic(from, to, "upstream_error");
    const account = payload.data?.viewer?.accounts?.[0];
    return account ? parseCloudflareTraffic(account, domain, from, to) : emptyTraffic(from, to, "invalid_response");
  } catch {
    return emptyTraffic(from, to, "upstream_error");
  }
}

export function fetchCloudflareTraffic(period: AdminPeriod, domain: AdminDomain, now = Date.now()) {
  return fetchCloudflareTrafficRange(now - periodMilliseconds(period), now, domain);
}
