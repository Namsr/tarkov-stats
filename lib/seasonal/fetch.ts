import { fetchTarkovJson } from "@/lib/tarkov-api";

/** The real endpoint is configured only after the upstream fixture is confirmed. */
export function seasonalProfileUrl(aid: number, template = process.env.SEASONAL_PROFILE_URL_TEMPLATE): string | null {
  if (!Number.isSafeInteger(aid) || aid <= 0 || !template || !template.includes("{aid}")) return null;
  const value = template.replaceAll("{aid}", String(aid));
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "players.tarkov.dev" ? url.toString() : null;
  } catch {
    return null;
  }
}

export async function fetchSeasonalPayload(aid: number): Promise<unknown> {
  const url = seasonalProfileUrl(aid);
  if (!url) throw new Error("Seasonal upstream endpoint is not configured");
  const response = await fetchTarkovJson(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`Seasonal upstream failed: ${response.status}`);
  return response.json();
}
