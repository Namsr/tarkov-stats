"use client";

import type { ArenaProfileRisk } from "../../types/arena";

/** Read the background result without reloading the cached profile or upstream. */
export function scheduleArenaRiskPoll(
  aid: number,
  profileUpdatedAt: number,
  onRisk: (risk: ArenaProfileRisk) => void,
): () => void {
  const controller = new AbortController();
  const delays = [1_500, 3_000, 5_000];
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout>;
  const schedule = () => {
    if (controller.signal.aborted || attempt >= delays.length) return;
    timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ aid: String(aid), mode: "arena" });
        const response = await fetch(`/api/player/risk?${params}`, { cache: "no-store", signal: controller.signal });
        if (response.ok) {
          const body = await response.json() as {
            identity?: { aid?: number; mode?: string; cycleId?: string };
            risk?: ArenaProfileRisk | null;
          };
          if (controller.signal.aborted) return;
          if (body.identity?.aid !== aid || body.identity.mode !== "arena" || body.identity.cycleId !== "persistent") return;
          if (body.risk?.aid === aid && typeof body.risk.version?.upstream === "number" && body.risk.version.upstream >= profileUpdatedAt) {
            onRisk(body.risk);
            return;
          }
        }
      } catch {
        // A transient failure can use the remaining attempts.
      }
      schedule();
    }, delays[attempt++]);
  };
  schedule();
  return () => {
    controller.abort();
    clearTimeout(timer);
  };
}
