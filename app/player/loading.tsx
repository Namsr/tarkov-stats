"use client";

import { usePathname } from "next/navigation";
import { ProfileShellLoading } from "@/components/ProfileShell";
import { parsePlayerId } from "@/lib/player-id";
import { gameModeFromAppRoute } from "@/types/seasonal";

export default function Loading() {
  const pathname = usePathname();
  const segments = pathname.split("/").filter(Boolean).slice(1);
  const routeMode = segments.length === 1 ? "regular" : segments[0];
  const aidValue = segments.length === 1 ? segments[0] : segments[1];
  const mode = gameModeFromAppRoute(routeMode) ?? "regular";
  const aid = aidValue ? parsePlayerId(aidValue) ?? undefined : undefined;

  return <ProfileShellLoading mode={mode} aid={aid} />;
}
