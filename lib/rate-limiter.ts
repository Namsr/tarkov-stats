const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX = 30;

// Best-effort, in-process limiter. На одном Node-инстансе Map живёт в процессе
// (сбрасывается при рестарте); на Cloudflare Workers — в пределах изолята.
// Ключ = "<bucket>:<ip>", так что разные эндпоинты лимитируются раздельно.
// Cleanup ленивый — top-level setInterval в Workers-скоупе запрещён.
const store = new Map<string, number[]>();

function prune(now: number, windowMs: number) {
  for (const [key, timestamps] of store) {
    const filtered = timestamps.filter((t) => now - t < windowMs);
    if (filtered.length === 0) store.delete(key);
    else store.set(key, filtered);
  }
}

export interface RateLimitOptions {
  /** Окно в мс (по умолчанию 60_000). */
  windowMs?: number;
  /** Максимум запросов в окне (по умолчанию 30). */
  max?: number;
  /** Namespace ключа, чтобы лимиты эндпоинтов не пересекались. */
  bucket?: string;
}

export function checkRateLimit(
  ip: string,
  opts: RateLimitOptions = {}
): { allowed: boolean; remaining: number; limit: number; windowMs: number } {
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const max = opts.max ?? DEFAULT_MAX;
  const key = `${opts.bucket ?? "default"}:${ip}`;
  const now = Date.now();

  // Opportunistic cleanup так, чтобы Map не рос бесконечно.
  if (store.size > 5000) prune(now, windowMs);

  const timestamps = (store.get(key) ?? []).filter((t) => now - t < windowMs);

  if (timestamps.length >= max) {
    store.set(key, timestamps);
    return { allowed: false, remaining: 0, limit: max, windowMs };
  }

  timestamps.push(now);
  store.set(key, timestamps);
  return { allowed: true, remaining: max - timestamps.length, limit: max, windowMs };
}

// Раньше отдавали X-RateLimit-Limit/Remaining/Reset, но это раскрывало точные
// пороги лимитера (подсказка злоумышленнику, как подстроиться под обход) и ничего
// не давало фронту — он их не читает. Прячем: наружу уходит только решение
// allowed, без заголовков. Сигнатура сохранена, чтобы роуты не трогать.
export function getRateLimitHeaders(ip: string, opts: RateLimitOptions = {}) {
  const { allowed } = checkRateLimit(ip, opts);
  return { allowed, headers: {} as Record<string, string> };
}
