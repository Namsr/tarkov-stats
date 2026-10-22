import { AXIS_HISTORY_API_URL, AXIS_HISTORY_PAGE_SIZE, AXIS_ARCHIVE_PAGE_SIZE, parseAxisHistory, advanceAxisArchiveState, type AxisHistoryPage } from "./axis-history.ts";
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
    const pages: AxisHistoryPage[] = [];
    let fetchFailed = false;
    let fetchError: unknown;
    try {
      let progress = store.archiveState();
      const numbers = new Set(store.archiveMatchNumbers());
      const signal = AbortSignal.timeout(12_000);
      const read = async (page: number, pageSize = AXIS_ARCHIVE_PAGE_SIZE) => {
        const url = new URL(AXIS_HISTORY_API_URL);
        url.search = new URLSearchParams({ page: String(page), page_size: String(pageSize), order: "desc" }).toString();
        const response = await request(url, { cache: "no-store", signal });
        if (!response.ok) throw new Error(`NeatQueue archive HTTP ${response.status}`);
        const data = parseAxisHistory(await response.json(), page, pageSize);
        pages.push(data);
        for (const match of data.matches) numbers.add(match.number);
        progress = advanceAxisArchiveState(progress, data, numbers.size);
        return data;
      };
      const complete = Boolean(progress.complete);
      let first = await read(1, complete || headOnly ? AXIS_HISTORY_PAGE_SIZE : AXIS_ARCHIVE_PAGE_SIZE);
      if (!headOnly) {
        // A normal refresh needs only the newest 25. Catch up after longer outages without gaps.
        if (complete && !progress.complete) first = await read(1);
        // Bounded initial import: two older pages per worker tick.
        for (let i = 0; i < 2 && !progress.complete; i++) {
          const page = progress.next_page;
          if (page > first.pages) break;
          await read(page);
        }
      }
    } catch (error) {
      fetchFailed = true;
      fetchError = error;
    }
    try {
      // Keep successful pages even if a later fetch failed. Never hold a SQLite
      // transaction across network I/O; publish archive + forecasts atomically once.
      store.publishArchiveBatch(pages, now);
      if (fetchFailed) throw fetchError;
    } catch (error) {
      store.failArchiveRefresh();
      console.warn("AXIS archive refresh failed: " + (error instanceof Error ? error.message : String(error)));
    }
  })();
  pendingArchives.set(store, refresh);
  try { await refresh; } finally { pendingArchives.delete(store); }
}

export async function loadAxisSeasonHistory(page: number, season: string, defer?: (task: () => Promise<void>) => void, matchNumber?: number, map?: string) {
  const store = await getAxisLeagueStore();
  // Bootstrap only a small head page; never delay the first response for older seasons.
  if (store.archiveState().updated_at == null) await refreshAxisArchive(store, fetch, Date.now(), true);
  // Also recover when the dedicated worker is absent. The shared lease prevents duplicate syncs.
  else defer?.(() => refreshAxisArchive(store, fetch, Date.now(), true));
  return matchNumber == null ? store.readSeasonHistory(page, season, undefined, map) : store.readMatchHistory(matchNumber);
}
