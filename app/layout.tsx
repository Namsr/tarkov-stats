import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import Link from "next/link";
import AuthButton from "@/components/AuthButton";
import AverageNavButton from "@/components/AverageNavButton";
import LanguageToggle from "@/components/LanguageToggle";
import FaqWidget from "@/components/FaqWidget";
import { LanguageProvider } from "@/lib/i18n/context";
import { FavoritesProvider } from "@/lib/favorites/context";
import { dict, type Lang } from "@/lib/i18n/dictionary";
import "./globals.css";

/** Resolve the UI language from the cookie, else the browser's Accept-Language. */
async function resolveLang(): Promise<Lang> {
  const cookieLang = (await cookies()).get("lang")?.value;
  if (cookieLang === "ru" || cookieLang === "en") return cookieLang;
  const accept = ((await headers()).get("accept-language") ?? "").toLowerCase();
  return accept.startsWith("ru") || /[ ,]ru\b/.test(accept) ? "ru" : "en";
}

export async function generateMetadata(): Promise<Metadata> {
  const lang = await resolveLang();
  return {
    title: dict[lang]["meta.title"],
    description: dict[lang]["meta.description"],
  };
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const lang = await resolveLang();

  return (
    <html lang={lang} className="h-full antialiased">
      <body className="min-h-full flex flex-col bg-[var(--background)] text-[var(--foreground)]">
        <LanguageProvider initialLang={lang}>
          <FavoritesProvider>
            <header className="flex items-center justify-between px-4 py-3 border-b border-[var(--card-border)]">
              <Link href="/" className="font-bold tracking-tight text-[var(--accent)]">
                TARKOV STATS
              </Link>
              <div className="flex items-center gap-3">
                <AverageNavButton />
                <AuthButton />
                <LanguageToggle />
              </div>
            </header>
            {children}
            <FaqWidget />
          </FavoritesProvider>
        </LanguageProvider>
      </body>
    </html>
  );
}
