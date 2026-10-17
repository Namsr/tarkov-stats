import { getCachedPlayerProfileResponse, loadPlayerProfileResponse } from "./client-profile-request.ts";
import type { AxisPlayerProfileResponse } from "./axis-player-profile";

export function axisPlayerRequest(aid: number, season: string, page: number, result: string): string {
  return `/api/axis-league/player?${new URLSearchParams({ aid: String(aid), season, page: String(page), result })}`;
}
export function cachedAxisPlayer(url: string): AxisPlayerProfileResponse | null {
  const response = getCachedPlayerProfileResponse<AxisPlayerProfileResponse>(url);
  return response?.ok && validPlayer(response.body, url) ? response.body : null;
}
function validPlayer(body: AxisPlayerProfileResponse | null, url: string): body is AxisPlayerProfileResponse {
  const query = new URL(url, "https://local").searchParams;
  return body?.aid === Number(query.get("aid")) && body.season === query.get("season")
    && body.history?.page === Number(query.get("page")) && Array.isArray(body.history.matches)
    && body.identity != null && body.stats != null && body.averages != null && body.highlights != null && body.story != null
    && Array.isArray(body.recent) && Array.isArray(body.teammates) && Array.isArray(body.opponents) && Array.isArray(body.maps);
}
export async function loadAxisPlayer(url: string, signal: AbortSignal, force = false): Promise<AxisPlayerProfileResponse> {
  const response = await loadPlayerProfileResponse<AxisPlayerProfileResponse>(url, { signal, force });
  if (!response.ok || !validPlayer(response.body, url)) throw new Error("Axis player unavailable");
  return response.body;
}
