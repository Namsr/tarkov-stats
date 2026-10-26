import type { Metadata } from "next";
import { headers } from "next/headers";
import Script from "next/script";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import NavigationPendingTracker from "@/components/NavigationPendingTracker";
import SkipLink from "@/components/SkipLink";
import FaqWidget from "@/components/FaqWidget";
import PageviewBeacon from "@/components/PageviewBeacon";
import PerformanceBeacon from "@/components/PerformanceBeacon";
import { LanguageProvider } from "@/lib/i18n/context";
import { FavoritesProvider } from "@/lib/favorites/context";
import { NativeRoutesProvider } from "@/lib/native-routes-context";
import { dict } from "@/lib/i18n/dictionary";
import { resolveLang } from "@/lib/i18n/server";
import "./globals.css";

const analyticsTokens: Record<string, string> = {
  "tarkovstats.ru": "3b0a180bb0d94635af5a11156c923676",
  "www.tarkovstats.ru": "3b0a180bb0d94635af5a11156c923676",
  "tarkovstats.online": "f7051c60efbf4d67985f5ae11292f196",
  "www.tarkovstats.online": "f7051c60efbf4d67985f5ae11292f196",
};

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
  const hostname = ((await headers()).get("host") ?? "")
    .split(":")[0]
    .toLowerCase();
  const analyticsToken = analyticsTokens[hostname];
  const nativeArena = process.env.ARENA_UI_UPSTREAM === "web:3001";

  return (
    <html lang={lang} className="h-full antialiased">
      {/* suppressHydrationWarning: browser extensions (Bitdefender etc.) inject
          attributes like bis_register / __processed_…__ into <body> before React
          hydrates. This only ignores attribute/text diffs on <body> itself —
          real hydration mismatches in the content tree still surface. */}
      <body
        className="min-h-full flex flex-col bg-[var(--background)] text-[var(--foreground)]"
        suppressHydrationWarning
      >
        <LanguageProvider initialLang={lang}>
          <NativeRoutesProvider arena={nativeArena}>
            <FavoritesProvider>
              <SkipLink />
              <SiteHeader />
              <NavigationPendingTracker />
              <div id="main-content" className="site-main" tabIndex={-1}>
                {children}
              </div>
              <SiteFooter />
              <FaqWidget />
              <PageviewBeacon />
              <PerformanceBeacon />
            </FavoritesProvider>
          </NativeRoutesProvider>
        </LanguageProvider>
        {analyticsToken ? (
          <Script
            id="cloudflare-web-analytics"
            type="module"
            strategy="afterInteractive"
            src="https://static.cloudflareinsights.com/beacon.min.js"
            data-cf-beacon={JSON.stringify({ token: analyticsToken })}
          />
        ) : null}
      </body>
    </html>
  );
}
