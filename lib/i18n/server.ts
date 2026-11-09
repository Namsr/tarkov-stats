import { cookies, headers } from "next/headers";
import type { Lang } from "./dictionary";

/** Resolve the request language for layouts and independently rendered fallbacks. */
export async function resolveLang(): Promise<Lang> {
  const cookieLang = (await cookies()).get("lang")?.value;
  if (cookieLang === "ru" || cookieLang === "en") return cookieLang;
  const requestHeaders = await headers();
  const host = (requestHeaders.get("host") ?? "").toLowerCase().split(":")[0];
  if (host === "tarkovstats.online" || host === "www.tarkovstats.online") return "en";
  if (host === "tarkovstats.ru" || host === "www.tarkovstats.ru") return "ru";
  const accept = (requestHeaders.get("accept-language") ?? "").toLowerCase();
  return accept.startsWith("ru") || /[ ,]ru\b/.test(accept) ? "ru" : "en";
}
