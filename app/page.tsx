import SearchBar from "@/components/SearchBar";

export default function Home() {
  return (
    <main className="flex-1 flex flex-col items-center justify-center px-4">
      <div className="flex flex-col items-center gap-8 max-w-xl w-full">
        <div className="text-center">
          <div className="text-6xl mb-4">☠</div>
          <h1 className="text-3xl font-bold text-[var(--accent)] tracking-tight">
            TARKOV STATS
          </h1>
          <p className="text-sm text-gray-500 mt-1 uppercase tracking-widest">
            Comparator
          </p>
        </div>

        <SearchBar autoFocus />

        <p className="text-xs text-gray-600 text-center max-w-sm">
          Look up any Escape from Tarkov player by account ID to view their
          stats and see how they compare against the average player for their
          playtime.
        </p>
      </div>
    </main>
  );
}
