import type { NextRequest } from "next/server";

/**
 * Доверенный IP клиента для rate-limit.
 *
 * БЕЗОПАСНОСТЬ: IP — это ключ корзины rate-limit, поэтому клиент, который может
 * выбрать свой IP, обходит лимит, просто перебирая значение заголовка. Значит
 * читать можно ТОЛЬКО тот заголовок, который выставляет НАШ доверенный прокси, —
 * никогда заголовок, который мог прислать клиент. Один и тот же билд крутится за
 * разными прокси, поэтому доверенный заголовок задаётся явно через env:
 *
 *   TRUSTED_IP_HEADER=x-real-ip        (по умолчанию) — за Caddy, который делает
 *     `header_up X-Real-IP {remote_host}` и перезаписывает любое клиентское
 *     значение реальным TCP-пиром.
 *   TRUSTED_IP_HEADER=cf-connecting-ip                — за Cloudflare (Tunnel или
 *     Workers): заголовок ставит сам Cloudflare из реального edge-пира и
 *     вырезает клиентские копии.
 *
 * Раньше код брал cf-connecting-ip → x-real-ip → последний элемент XFF по
 * очереди. За Caddy (наш прод) cf-connecting-ip и XFF клиент подделывает
 * свободно, поэтому такой fallback = обход лимита. Теперь читаем РОВНО один
 * настроенный заголовок; если его нет — возвращаем "unknown" (общая корзина),
 * а не доверяем подделываемому запасному варианту. Fail closed, не open.
 */
const TRUSTED_IP_HEADER = (process.env.TRUSTED_IP_HEADER || "x-real-ip")
  .trim()
  .toLowerCase();

export function getClientIp(request: NextRequest): string {
  const ip = request.headers.get(TRUSTED_IP_HEADER)?.trim();
  return ip || "unknown";
}
