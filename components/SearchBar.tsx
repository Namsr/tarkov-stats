"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { parsePlayerId } from "@/lib/player-id";
import { useI18n } from "@/lib/i18n/context";

export default function SearchBar({ autoFocus = false }: { autoFocus?: boolean }) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const router = useRouter();

  function submit() {
    const aid = parsePlayerId(query);
    if (aid === null) {
      setError(t("search.error"));
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
          placeholder={t("search.placeholder")}
          autoFocus={autoFocus}
          className="flex-1 px-4 py-3 bg-[var(--input-bg)] border border-[var(--card-border)] rounded-lg text-[var(--foreground)] placeholder:text-gray-500 focus:outline-none focus:border-[var(--accent)] transition-colors"
        />
        <button
          onClick={submit}
          className="px-5 py-3 bg-[var(--accent)] text-[var(--background)] rounded-lg font-medium hover:bg-[var(--accent-dim)] transition-colors"
        >
          {t("search.view")}
        </button>
      </div>

      {error && <p className="mt-2 text-sm text-[var(--danger)]">{error}</p>}

      <p className="mt-3 text-xs text-gray-600">
        {t("search.helpBefore")}{" "}
        <a
          href="https://tarkov.dev/players"
          target="_blank"
          rel="noopener noreferrer"
          className="text-[var(--accent)] hover:underline"
        >
          tarkov.dev/players
        </a>{" "}
        {t("search.helpAfter")}
      </p>
    </div>
  );
}
