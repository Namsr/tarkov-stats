import type { NextRequest } from "next/server";

/**
 * Доверенный IP клиента для rate-limit.
 * Порядок: cf-connecting-ip (Cloudflare) → x-real-ip → последний элемент XFF.
 *
 * ВАЖНО: за Caddy мы выставляем `header_up X-Real-IP {remote_host}` — Caddy
 * перезаписывает заголовок реальным адресом TCP-пира, клиент его подделать не
 * может. X-Forwarded-For НЕ берём как [0] (его спуфит клиент); как fallback
 * берём ПОСЛЕДНИЙ элемент — он добавлен ближайшим (доверенным) прокси.
 */
export function getClientIp(request: NextRequest): string {
  const cf = request.headers.get("cf-connecting-ip")?.trim();
  if (cf) return cf;

  const real = request.headers.get("x-real-ip")?.trim();
  if (real) return real;

  const xff = request.headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }

  return "unknown";
}
