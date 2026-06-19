const windowMs = 60_000;
const maxRequests = 30;

const store = new Map<string, number[]>();

// Note: this is a best-effort, per-isolate limiter. On Cloudflare Workers each
// isolate keeps its own Map, so it caps bursts per instance rather than globally.
// Cleanup is done lazily on access — a top-level setInterval is disallowed in
// the Workers global scope.
function prune(now: number) {
  for (const [ip, timestamps] of store) {
    const filtered = timestamps.filter((t) => now - t < windowMs);
    if (filtered.length === 0) store.delete(ip);
    else store.set(ip, filtered);
  }
}

export function checkRateLimit(ip: string): { allowed: boolean; remaining: number } {
  const now = Date.now();
  // Opportunistic cleanup so the Map can't grow unbounded.
  if (store.size > 5000) prune(now);

  const timestamps = (store.get(ip) ?? []).filter((t) => now - t < windowMs);

  if (timestamps.length >= maxRequests) {
    store.set(ip, timestamps);
    return { allowed: false, remaining: 0 };
  }

  timestamps.push(now);
  store.set(ip, timestamps);
  return { allowed: true, remaining: maxRequests - timestamps.length };
}

export function getRateLimitHeaders(ip: string) {
  const { allowed, remaining } = checkRateLimit(ip);
  return {
    allowed,
    headers: {
      "X-RateLimit-Limit": String(maxRequests),
      "X-RateLimit-Remaining": String(remaining),
      "X-RateLimit-Reset": String(Math.ceil(Date.now() / 1000) + 60),
    },
  };
}
