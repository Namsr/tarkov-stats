import { NextResponse } from "next/server";

// RFC 9116 security.txt — стандартный, обнаружимый канал, по которому
// исследователи безопасности сообщают об уязвимостях. Отдаётся по адресу
// /.well-known/security.txt через rewrite в next.config.ts (App Router не умеет
// держать папку с точкой в начале). Expires ОБЯЗАТЕЛЕН по RFC, чтобы было видно
// протухшие контакты — обновить дату до её наступления.
const SECURITY_TXT = [
  "Contact: mailto:namsrr@protonmail.com",
  "Expires: 2027-06-25T00:00:00.000Z",
  "Preferred-Languages: en, ru",
  "Canonical: https://tarkovstats.ru/.well-known/security.txt",
  "Canonical: https://tarkovstats.online/.well-known/security.txt",
  "",
].join("\n");

export function GET() {
  return new NextResponse(SECURITY_TXT, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=86400",
    },
  });
}
