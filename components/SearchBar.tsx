"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { parsePlayerId } from "@/lib/player-id";

export default function SearchBar({ autoFocus = false }: { autoFocus?: boolean }) {
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const router = useRouter();

  function submit() {
    const aid = parsePlayerId(query);
    if (aid === null) {
      setError("Enter a numeric account ID or a tarkov.dev profile link.");
      return;
    }
    setError("");
    router.push(`/player/${aid}`);
  }

  return (
    <div className="w-full max-w-lg">
      <div className="flex gap-2">
        <input
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            if (error) setError("");
          }}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="Account ID or tarkov.dev profile link..."
          autoFocus={autoFocus}
          className="flex-1 px-4 py-3 bg-[var(--input-bg)] border border-[var(--card-border)] rounded-lg text-[var(--foreground)] placeholder:text-gray-500 focus:outline-none focus:border-[var(--accent)] transition-colors"
        />
        <button
          onClick={submit}
          className="px-5 py-3 bg-[var(--accent)] text-[var(--background)] rounded-lg font-medium hover:bg-[var(--accent-dim)] transition-colors"
        >
          View
        </button>
      </div>

      {error && <p className="mt-2 text-sm text-[var(--danger)]">{error}</p>}

      <p className="mt-3 text-xs text-gray-600">
        Don&apos;t know the ID? Find the player on{" "}
        <a
          href="https://tarkov.dev/players"
          target="_blank"
          rel="noopener noreferrer"
          className="text-[var(--accent)] hover:underline"
        >
          tarkov.dev/players
        </a>{" "}
        and paste the profile link or the number from its URL.
      </p>
    </div>
  );
}
