const windowMs = 60_000;
const maxRequests = 30;

const store = new Map<string, number[]>();

setInterval(() => {
  const now = Date.now();
  for (const [ip, timestamps] of store) {
    const filtered = timestamps.filter((t) => now - t < windowMs);
    if (filtered.length === 0) store.delete(ip);
    else store.set(ip, filtered);
  }
}, 60_000);

export function checkRateLimit(ip: string): { allowed: boolean; remaining: number } {
  const now = Date.now();
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
