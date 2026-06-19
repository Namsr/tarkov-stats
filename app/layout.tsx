import type { Metadata } from "next";
import Link from "next/link";
import AuthButton from "@/components/AuthButton";
import "./globals.css";

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
      <body className="min-h-full flex flex-col bg-[var(--background)] text-[var(--foreground)]">
        <header className="flex items-center justify-between px-4 py-3 border-b border-[var(--card-border)]">
          <Link href="/" className="font-bold tracking-tight text-[var(--accent)]">
            TARKOV STATS
          </Link>
          <div className="flex items-center gap-3">
            <Link
              href="/average"
              className="px-3 py-1.5 text-sm rounded bg-[var(--input-bg)] border border-[var(--card-border)] text-gray-300 hover:text-[var(--accent)] hover:border-[var(--accent)] transition-colors"
            >
              Average Player Statistics
            </Link>
            <AuthButton />
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
