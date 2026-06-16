import { PlayerSearchResult, PlayerProfile } from "@/types/tarkov";

const API_BASE = "https://player.tarkov.dev";

export async function searchPlayerDirect(
  nickname: string,
  turnstileToken: string
): Promise<PlayerSearchResult[]> {
  const url = `${API_BASE}/name/${encodeURIComponent(nickname)}?token=${encodeURIComponent(turnstileToken)}`;

  const res = await fetch(url);
  if (!res.ok) {
    if (res.status === 404) return [];
    if (res.status === 401) throw new Error("Turnstile verification failed. Please complete the CAPTCHA.");
    if (res.status === 429) throw new Error("Rate limit exceeded. Please wait a moment.");
    throw new Error(`Search failed (${res.status})`);
  }
  return res.json();
}

export async function getProfileDirect(
  aid: number,
  turnstileToken: string
): Promise<PlayerProfile> {
  const url = `${API_BASE}/account/${aid}?token=${encodeURIComponent(turnstileToken)}`;

  const res = await fetch(url);
  if (!res.ok) {
    if (res.status === 401) throw new Error("Turnstile verification failed. Please complete the CAPTCHA.");
    if (res.status === 429) throw new Error("Rate limit exceeded. Please wait a moment.");
    throw new Error(`Profile fetch failed (${res.status})`);
  }
  return res.json();
}
