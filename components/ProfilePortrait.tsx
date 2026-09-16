"use client";

import Image from "next/image";
import { useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import type { GameMode } from "@/types/seasonal";

export default function ProfilePortrait({ aid, mode, cycleId, nickname }: {
  aid: number;
  mode: GameMode;
  cycleId?: string;
  nickname: string;
}) {
  const { t } = useI18n();
  const [status, setStatus] = useState<"loading" | "loaded" | "error">("loading");
  const params = new URLSearchParams({ aid: String(aid), mode });
  if (mode === "seasonal" && cycleId) params.set("cycle", cycleId);

  return (
    <div className="profile-portrait" role="img" aria-label={t(
      status === "error" ? "profile.portraitUnavailable" : "profile.portrait", { nickname },
    )}>
      {status !== "loaded" && (
        <svg className="profile-portrait__placeholder" viewBox="0 0 100 100" aria-hidden="true">
          <circle cx="50" cy="36" r="18" fill="currentColor" />
          <path d="M16 100V88c0-22 15-34 34-34s34 12 34 34v12Z" fill="currentColor" />
        </svg>
      )}
      {status !== "error" && (
        <Image
          className="profile-portrait__image"
          data-loaded={status === "loaded"}
          src={`/api/player/portrait?${params}`}
          alt=""
          width={120}
          height={120}
          unoptimized
          loading="eager"
          referrerPolicy="no-referrer"
          onLoad={() => setStatus("loaded")}
          onError={() => setStatus("error")}
        />
      )}
    </div>
  );
}
