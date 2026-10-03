import { AXIS_HISTORY_API_URL, AXIS_HISTORY_PAGE_SIZE, parseAxisHistory } from "./axis-history.ts";
import { getAxisLeagueStore, type AxisLeagueStore } from "./admin/axis-league-db.ts";

export async function fetchAxisHistory(page: number, request: typeof fetch = fetch) {
  const url = new URL(AXIS_HISTORY_API_URL);
  url.search = new URLSearchParams({ page: String(page), page_size: String(AXIS_HISTORY_PAGE_SIZE), order: "desc" }).toString();
  const response = await request(url, { cache: "no-store", signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw new Error(`NeatQueue history HTTP ${response.status}`);
  return parseAxisHistory(await response.json(), page);
}

const pendingRefreshes = new WeakMap<AxisLeagueStore, Map<number, Promise<void>>>();
export async function refreshAxisHistory(store: AxisLeagueStore, page = 1, request: typeof fetch = fetch, now = Date.now()) {
  let pages = pendingRefreshes.get(store);
  if (!pages) { pages = new Map(); pendingRefreshes.set(store, pages); }
  const pending = pages.get(page);
  if (pending) return pending;
  if (!store.claimHistoryRefresh(page, now)) return;
  const refresh = (async () => {
    try { store.publishHistory(await fetchAxisHistory(page, request)); }
    catch (error) {
      store.failHistoryRefresh(page);
      console.warn("AXIS history refresh failed: " + (error instanceof Error ? error.message : String(error)));
    }
  })();
  pages.set(page, refresh);
  try { await refresh; } finally { pages.delete(page); }
}

export async function loadAxisHistory(page: number) {
  const store = await getAxisLeagueStore();
  await refreshAxisHistory(store, page);
  return store.readHistory(page);
}
