import { AXIS_API_URL, parseAxisPage, type AxisPlayer } from "./axis-league.ts";
import { getAxisLeagueStore, type AxisLeagueStore } from "./admin/axis-league-db.ts";

export async function fetchAxisPlayers(request: typeof fetch = fetch): Promise<AxisPlayer[]> {
  const players: AxisPlayer[] = [];
  let expectedTotal: number | null = null;
  let expectedPages: number | null = null;
  // One bounded sync, including pagination, stays inside the web request timeout.
  const signal = AbortSignal.timeout(12_000);
  for (let page = 1; page <= 20; page++) {
    const url = new URL(AXIS_API_URL);
    url.search = new URLSearchParams({ display: "players", month: "alltime", page: String(page), page_size: "500" }).toString();
    const response = await request(url, { cache: "no-store", signal });
    if (!response.ok) throw new Error(`NeatQueue HTTP ${response.status}`);
    const parsed = parseAxisPage(await response.json());
    if (expectedTotal != null && (parsed.total !== expectedTotal || parsed.pages !== expectedPages)) throw new Error("Leaderboard changed during pagination");
    expectedTotal = parsed.total;
    expectedPages = parsed.pages;
    if (parsed.pages > 20) throw new Error("Leaderboard is too large");
    players.push(...parsed.players);
    if (page === parsed.pages) break;
  }
  if (players.length !== expectedTotal || new Set(players.map((player) => player.id)).size !== players.length) {
    throw new Error("Incomplete leaderboard");
  }
  return players;
}

const pendingRefreshes = new WeakMap<AxisLeagueStore, Promise<void>>();
export async function refreshAxisLeague(store: AxisLeagueStore, request: typeof fetch = fetch, now = Date.now()): Promise<void> {
  const pending = pendingRefreshes.get(store);
  if (pending) return pending;
  if (!store.claimRefresh(now)) return;
  const refresh = (async () => {
    try { store.publish(await fetchAxisPlayers(request)); }
    catch (error) {
      store.failRefresh();
      console.warn("AXIS League refresh failed: " + (error instanceof Error ? error.message : String(error)));
    }
  })();
  pendingRefreshes.set(store, refresh);
  try { await refresh; }
  finally { pendingRefreshes.delete(store); }
}

export async function loadAxisLeague() {
  const store = await getAxisLeagueStore();
  await refreshAxisLeague(store);
  return store.read();
}
