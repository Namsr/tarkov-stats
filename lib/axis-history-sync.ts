import { AXIS_HISTORY_API_URL, AXIS_HISTORY_PAGE_SIZE, AXIS_ARCHIVE_PAGE_SIZE, parseAxisHistory, advanceAxisArchiveState, type AxisHistoryPage } from "./axis-history.ts";
import { getAxisLeagueStore, type AxisLeagueStore } from "./admin/axis-league-db.ts";

export async function loadAxisHistory(page: number, defer?: (task: () => Promise<void>) => void) {
  // Compatibility URL uses the same archive as the season selector, without a second upstream sync.
  return loadAxisSeasonHistory(page, "all", defer);
}

const pendingArchives = new WeakMap<AxisLeagueStore, Promise<void>>();
const ARCHIVE_TIMEOUT_MS = 12_000;
// NeatQueue sometimes stalls or drops the connection mid-body from the VPS. A
// stall surfaces as a TimeoutError once the signal fires; a reset surfaces as
// `TypeError: terminated` with a socket error cause even though the headers
// already arrived. Both are worth one retry on a fresh connection; HTTP errors
// and malformed payloads are not.
function archiveRequestRetryable(error: unknown) {
  if (typeof error !== "object" || error === null) return false;
  const { name, message, cause } = error as { name?: unknown; message?: unknown; cause?: unknown };
  if (name === "TimeoutError") return true;
  if (name === "TypeError" && message === "terminated") return true;
  const code = typeof cause === "object" && cause !== null ? (cause as { code?: unknown }).code : null;
  return code === "UND_ERR_SOCKET" || code === "ECONNRESET" || code === "EPIPE";
}
export async function refreshAxisArchive(store: AxisLeagueStore, request: typeof fetch = fetch, now = Date.now(), headOnly = false, retries = 1) {
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
      const read = async (page: number, pageSize = AXIS_ARCHIVE_PAGE_SIZE) => {
        const url = new URL(AXIS_HISTORY_API_URL);
        url.search = new URLSearchParams({ page: String(page), page_size: String(pageSize), order: "desc" }).toString();
        // Every attempt gets its own budget: a slow head page must not starve the
        // reconciliation reads, and a dropped connection gets a clean retry.
        for (let attempt = 0; ; attempt++) {
          try {
            const response = await request(url, { cache: "no-store", signal: AbortSignal.timeout(ARCHIVE_TIMEOUT_MS) });
            if (!response.ok) throw new Error(`NeatQueue archive HTTP ${response.status}`);
            const data = parseAxisHistory(await response.json(), page, pageSize);
            pages.push(data);
            for (const match of data.matches) numbers.add(match.number);
            progress = advanceAxisArchiveState(progress, data, numbers.size);
            return data;
          } catch (error) {
            if (attempt >= retries || !archiveRequestRetryable(error)) throw error;
          }
        }
      };
      const complete = Boolean(progress.complete);
      const first = await read(1, headOnly && !complete ? AXIS_HISTORY_PAGE_SIZE : AXIS_ARCHIVE_PAGE_SIZE);
      if (!headOnly || complete) {
        // Revisit completed archives too: old results can be cancelled or corrected.
        // HTTP fallbacks participate once imported, so their shared lease cannot
        // starve reconciliation. Keep the initial HTTP bootstrap head-only.
        const reconcile = complete && Boolean(progress.complete);
        for (let i = 0; i < 2 && (!progress.complete || reconcile); i++) {
          const page = progress.next_page;
          if (page > first.pages) break;
          await read(page);
          // The persisted cursor wraps to page 2; resume there on the next tick.
          if (page === first.pages) break;
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
  // Bootstrap only a small head page; never delay the first response for older
  // seasons. No retry here: the visitor waits on this, so keep one 12 s budget.
  if (store.archiveState().updated_at == null) await refreshAxisArchive(store, fetch, Date.now(), true, 0);
  // Also recover when the dedicated worker is absent. The shared lease prevents duplicate syncs.
  else defer?.(() => refreshAxisArchive(store, fetch, Date.now(), true));
  return matchNumber == null ? store.readSeasonHistory(page, season, undefined, map) : store.readMatchHistory(matchNumber);
}
