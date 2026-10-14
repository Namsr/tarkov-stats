import { cookies, headers } from "next/headers";
import type { Lang } from "./dictionary";

/** Resolve the request language for layouts and independently rendered fallbacks. */
export async function resolveLang(): Promise<Lang> {
  const cookieLang = (await cookies()).get("lang")?.value;
  if (cookieLang === "ru" || cookieLang === "en") return cookieLang;
  const accept = ((await headers()).get("accept-language") ?? "").toLowerCase();
  return accept.startsWith("ru") || /[ ,]ru\b/.test(accept) ? "ru" : "en";
}
