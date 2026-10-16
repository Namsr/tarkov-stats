import { AXIS_HISTORY_API_URL, AXIS_HISTORY_PAGE_SIZE, AXIS_ARCHIVE_PAGE_SIZE, parseAxisHistory } from "./axis-history.ts";
import { getAxisLeagueStore, type AxisLeagueStore } from "./admin/axis-league-db.ts";

export async function loadAxisHistory(page: number, defer?: (task: () => Promise<void>) => void) {
  // Compatibility URL uses the same archive as the season selector, without a second upstream sync.
  return loadAxisSeasonHistory(page, "all", defer);
}

const pendingArchives = new WeakMap<AxisLeagueStore, Promise<void>>();
export async function refreshAxisArchive(store: AxisLeagueStore, request: typeof fetch = fetch, now = Date.now(), headOnly = false) {
  const pending = pendingArchives.get(store);
  if (pending) return pending;
  if (!store.claimArchiveRefresh(now, headOnly)) return;
  const refresh = (async () => {
    try {
      const signal = AbortSignal.timeout(12_000);
      const read = async (page: number, pageSize = AXIS_ARCHIVE_PAGE_SIZE) => {
        const url = new URL(AXIS_HISTORY_API_URL);
        url.search = new URLSearchParams({ page: String(page), page_size: String(pageSize), order: "desc" }).toString();
        const response = await request(url, { cache: "no-store", signal });
        if (!response.ok) throw new Error(`NeatQueue archive HTTP ${response.status}`);
        const data = parseAxisHistory(await response.json(), page, pageSize);
        store.publishArchive(data, now);
        return data;
      };
      const complete = Boolean(store.archiveState().complete);
      let first = await read(1, complete || headOnly ? AXIS_HISTORY_PAGE_SIZE : AXIS_ARCHIVE_PAGE_SIZE);
      if (headOnly) return;
      // A normal refresh needs only the newest 25. Catch up after longer outages without gaps.
      if (complete && !store.archiveState().complete) first = await read(1);
      // Bounded initial import: two older pages per worker tick.
      for (let i = 0; i < 2 && !store.archiveState().complete; i++) {
        const page = store.archiveState().next_page;
        if (page > first.pages) break;
        await read(page);
      }
    } catch (error) {
      store.failArchiveRefresh();
      console.warn("AXIS archive refresh failed: " + (error instanceof Error ? error.message : String(error)));
    }
  })();
  pendingArchives.set(store, refresh);
  try { await refresh; } finally { pendingArchives.delete(store); }
}

export async function loadAxisSeasonHistory(page: number, season: string, defer?: (task: () => Promise<void>) => void) {
  const store = await getAxisLeagueStore();
  // Bootstrap only a small head page; never delay the first response for older seasons.
  if (store.archiveState().updated_at == null) await refreshAxisArchive(store, fetch, Date.now(), true);
  // Also recover when the dedicated worker is absent. The shared lease prevents duplicate syncs.
  else defer?.(() => refreshAxisArchive(store, fetch, Date.now(), true));
  return store.readSeasonHistory(page, season);
}
