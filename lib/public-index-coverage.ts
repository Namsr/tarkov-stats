/** Coverage figures for the public nickname index, read from the metadata the
 *  index sync already writes at swap time.
 *
 *  `scripts/sync-player-index.mjs` streams the whole upstream index, swaps it
 *  into `player_index` and records `row_count` plus `synced_at` in
 *  `player_index_meta` inside that same transaction. So the served number costs
 *  two primary-key lookups on a table that holds ~10 rows, with no COUNT(*) over
 *  a multi-million row table and nothing for a visitor to trigger. It moves only
 *  when an index sync actually succeeds, which is the intent: it is a statement
 *  about the last completed sync, not a live count.
 *
 *  A missing or unparsable row yields null rather than a guess, so the home page
 *  can hide the figure instead of publishing a fabricated one. */

const TOTAL_KEY = "row_count";
const SYNCED_KEY = "synced_at";

export interface PublicIndexCoverage {
  /** Accounts in the public index at the last completed sync, or null if the
   *  index has never synced on this deployment. */
  total: number | null;
  /** Epoch ms of that same sync, so callers can show or compare the as-of date. */
  syncedAt: number | null;
}

function parseCount(raw: unknown): number | null {
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function parseTimestamp(raw: unknown): number | null {
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function readMeta(db: any): PublicIndexCoverage {
  const rows = db
    .prepare("SELECT key, value FROM player_index_meta WHERE key IN (?, ?)")
    .all(TOTAL_KEY, SYNCED_KEY) as { key: string; value: string }[];
  const meta = new Map(rows.map((row) => [row.key, row.value]));
  return { total: parseCount(meta.get(TOTAL_KEY)), syncedAt: parseTimestamp(meta.get(SYNCED_KEY)) };
}

export async function getPublicIndexCoverage(): Promise<PublicIndexCoverage> {
  const store = await import("@/lib/db").then((m) => m.getPublicIndexMetaReader());
  if (!store) return { total: null, syncedAt: null };
  try {
    return readMeta(store);
  } catch {
    // No `player_index_meta` yet (fresh deployment before the first sync).
    return { total: null, syncedAt: null };
  }
}