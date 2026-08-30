export const ADMIN_PERIODS = ["15m", "24h", "7d", "30d", "90d"] as const;
export type AdminPeriod = (typeof ADMIN_PERIODS)[number];
export type AdminDomain = "all" | "tarkovstats.ru" | "tarkovstats.online";

export const ADMIN_DOMAINS = ["tarkovstats.ru", "tarkovstats.online"] as const;

export function parseAdminPeriod(value: string | null): AdminPeriod | null {
  if (value == null || value === "") return "7d";
  return ADMIN_PERIODS.includes(value as AdminPeriod) ? value as AdminPeriod : null;
}

export function parseAdminDomain(value: string | null): AdminDomain | null {
  if (value == null || value === "") return "all";
  if (value === "all" || ADMIN_DOMAINS.includes(value as (typeof ADMIN_DOMAINS)[number])) return value as AdminDomain;
  return null;
}

export function periodMilliseconds(period: AdminPeriod): number {
  if (period === "15m") return 15 * 60_000;
  return period === "24h" ? 86_400_000 : Number.parseInt(period, 10) * 86_400_000;
}

export function canonicalAdminHost(value: string | null | undefined): string | null {
  const host = value?.split(",", 1)[0].trim().toLowerCase().replace(/:\d+$/, "").replace(/^www\./, "");
  return ADMIN_DOMAINS.includes(host as (typeof ADMIN_DOMAINS)[number]) ? host! : null;
}

export const ADMIN_NO_STORE_HEADERS = {
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex",
};
