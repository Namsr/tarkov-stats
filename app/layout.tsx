import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import AuthButton from "@/components/AuthButton";

export const metadata: Metadata = {
  title: "Tarkov Stats Comparator",
  description:
    "Look up Escape from Tarkov player statistics and compare against benchmarks or other players.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body
        suppressHydrationWarning
        className="min-h-full flex flex-col bg-[var(--background)] text-[var(--foreground)]"
      >
        <header className="flex items-center justify-between px-4 py-3 border-b border-[var(--card-border)]">
          <Link
            href="/"
            className="text-sm font-bold text-[var(--accent)] tracking-widest hover:text-[var(--accent-dim)] transition-colors"
          >
            ☠ TARKOV STATS
          </Link>
          <AuthButton />
        </header>
        {children}
      </body>
    </html>
  );
}
