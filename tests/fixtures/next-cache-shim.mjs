const entries = new Map();

export function unstable_cache(fn, keyParts = [], options = {}) {
  const ttlMs = Number.isFinite(options.revalidate) ? options.revalidate * 1000 : 0;
  return async (...args) => {
    const key = JSON.stringify([keyParts, args]);
    const entry = entries.get(key);
    if (entry && (ttlMs <= 0 || entry.expiresAt > Date.now())) return entry.value;
    const value = await fn(...args);
    entries.set(key, { value, expiresAt: Date.now() + ttlMs });
    return value;
  };
}
