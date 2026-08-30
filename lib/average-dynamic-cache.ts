const TTL_MS = 5 * 60_000;
const MAX_KEYS = 512;

type Entry<T> = { promise: Promise<T>; expiresAt: number };
const entries = new Map<string, Entry<unknown>>();

function prune(now: number): void {
  for (const [key, entry] of entries) {
    if (entry.expiresAt <= now) entries.delete(key);
  }
  while (entries.size >= MAX_KEYS) entries.delete(entries.keys().next().value!);
}

export async function loadDynamicAverage<T>(
  key: string,
  load: () => Promise<T>,
  now = Date.now(),
): Promise<{ value: T; cache: "hit" | "miss" }> {
  const existing = entries.get(key) as Entry<T> | undefined;
  if (existing && existing.expiresAt > now) {
    entries.delete(key);
    entries.set(key, existing);
    return { value: await existing.promise, cache: "hit" };
  }
  prune(now);
  const entry: Entry<T> = {
    promise: load(),
    expiresAt: now + TTL_MS,
  };
  entries.set(key, entry);
  try {
    return { value: await entry.promise, cache: "miss" };
  } catch (error) {
    if (entries.get(key) === entry) entries.delete(key);
    throw error;
  }
}

export function resetDynamicAverageCacheForTests(): void {
  entries.clear();
}
