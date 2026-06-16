import { Streamer } from "@/types/tarkov";

interface StreamerListProps {
  streamers: Streamer[];
  onSelect: (streamer: Streamer) => void;
  loading?: boolean;
}

export default function StreamerList({
  streamers,
  onSelect,
  loading,
}: StreamerListProps) {
  if (streamers.length === 0) return null;

  return (
    <div>
      <h3 className="text-xs uppercase tracking-wider text-gray-500 mb-2">
        Compare with Streamer
      </h3>
      <div className="flex flex-wrap gap-2">
        {streamers.map((s) => (
          <button
            key={s.nickname}
            onClick={() => onSelect(s)}
            disabled={loading}
            className="px-3 py-1.5 text-sm bg-[var(--card-bg)] border border-[var(--card-border)] rounded hover:border-[var(--accent)] hover:text-[var(--accent)] transition-colors disabled:opacity-50"
          >
            {s.name}
          </button>
        ))}
      </div>
    </div>
  );
}
