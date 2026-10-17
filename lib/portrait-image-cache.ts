const FRESH_MS = 10 * 60_000;
const STALE_MS = 60 * 60_000;
const RETRY_MS = 30_000;
const MAX_KEYS = 128;
const MAX_BYTES = 16 * 1024 * 1024;

type Entry = {
  image?: string;
  savedAt: number;
  retryAt: number;
  bytes: number;
  pending?: Promise<{ image: string; stale: boolean }>;
};
const cacheSymbol: unique symbol = Symbol.for("tarkov.portrait-images.v1");
const state = globalThis as typeof globalThis & { [cacheSymbol]?: Map<string, Entry> };
const entries = state[cacheSymbol] ??= new Map<string, Entry>();

export class PortraitCooldownError extends Error {
  readonly retryAfter: number;
  constructor(retryAfter = 30) {
    super("Portrait renderer is temporarily unavailable");
    this.retryAfter = retryAfter;
  }
}

function prune(now: number): void {
  let bytes = 0;
  for (const [key, entry] of entries) {
    if (!entry.pending && (entry.image ? now - entry.savedAt >= STALE_MS : now >= entry.retryAt)) entries.delete(key);
    else bytes += entry.bytes;
  }
  for (const [key, entry] of entries) {
    if (entries.size < MAX_KEYS && bytes <= MAX_BYTES) break;
    if (entry.pending) continue;
    entries.delete(key);
    bytes -= entry.bytes;
  }
}

/** Only the exact renderer URL (including equipment) may share bytes or work. */
export async function cachedPortraitImage(
  url: string,
  load: () => Promise<string>,
): Promise<{ image: string; stale: boolean }> {
  const now = Date.now();
  let entry = entries.get(url);
  if (entry?.pending) {
    if (entry.image && now - entry.savedAt < STALE_MS) return { image: entry.image, stale: true };
    return entry.pending;
  }
  if (entry?.image && now - entry.savedAt < FRESH_MS) return { image: entry.image, stale: false };
  if (entry && now < entry.retryAt) {
    if (entry.image && now - entry.savedAt < STALE_MS) return { image: entry.image, stale: true };
    throw new PortraitCooldownError(Math.max(1, Math.ceil((entry.retryAt - now) / 1000)));
  }
  prune(now);
  entry = entries.get(url);
  if (!entry) {
    const keyBytes = Buffer.byteLength(url);
    if (entries.size >= MAX_KEYS || keyBytes > 64 * 1024) throw new PortraitCooldownError(1);
    entry = { savedAt: 0, retryAt: 0, bytes: keyBytes };
    entries.set(url, entry);
  } else {
    entries.delete(url);
    entries.set(url, entry);
  }
  const target = entry;
  target.pending = Promise.resolve().then(load).then((image) => {
    const bytes = Buffer.byteLength(url) + Buffer.byteLength(image);
    if (bytes <= 2 * 1024 * 1024) {
      target.image = image;
      target.savedAt = Date.now();
      target.bytes = bytes;
      target.retryAt = 0;
    } else entries.delete(url);
    return { image, stale: false };
  }).catch((error: unknown) => {
    target.retryAt = Date.now() + RETRY_MS;
    if (target.image && Date.now() - target.savedAt < STALE_MS) return { image: target.image, stale: true };
    throw error;
  }).finally(() => {
    target.pending = undefined;
    prune(Date.now());
  });
  if (target.image && now - target.savedAt < STALE_MS) {
    // Keep a good portrait visible while exactly one refresh runs. The catch
    // also observes a failure if the stale age expires during that request.
    void target.pending.catch(() => {});
    return { image: target.image, stale: true };
  }
  return target.pending;
}

export function resetPortraitImageCacheForTests(): void { entries.clear(); }
