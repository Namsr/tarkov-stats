import { type NextRequest, NextResponse } from "next/server";

function localPath(value: string | null): string | null {
  if (!value?.startsWith("/") || value.startsWith("//") || value.includes("\\")) return null;
  if ([...value].some((char) => char <= " " || char === "\u007f")) return null;
  const parsed = new URL(value, "https://local.invalid");
  if (parsed.pathname.startsWith("//") || parsed.pathname.replace(/\/$/, "") === "/api/language") return null;
  return parsed.pathname + parsed.search + parsed.hash;
}

function referredPath(request: NextRequest): string | null {
  const referrer = request.headers.get("referer");
  const url = referrer ? URL.parse(referrer) : null;
  if (!url || !["http:", "https:"].includes(url.protocol) || url.host !== request.headers.get("host")) return null;
  return localPath(url.pathname + url.search);
}

export function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const lang = params.get("lang");
  if (lang !== "en" && lang !== "ru") return new NextResponse(null, { status: 400 });

  const response = new NextResponse(null, {
    status: 303,
    headers: {
      Location: localPath(params.get("returnTo")) ?? referredPath(request) ?? "/",
      "Cache-Control": "private, no-store",
    },
  });
  response.cookies.set("lang", lang, { path: "/", maxAge: 31_536_000, sameSite: "lax" });
  return response;
}
