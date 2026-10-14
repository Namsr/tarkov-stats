"use client";

import type { PublicRiskView } from "../types/profile-view";
import type { GameMode } from "../types/seasonal";

/** Read a completed background evaluation without refetching the profile. */
export function schedulePlayerRiskPoll(
  input: { aid: number; mode: Exclude<GameMode, "arena">; cycleId: string; profileUpdatedAt: number },
  onRisk: (risk: PublicRiskView) => void,
): () => void {
  const controller = new AbortController();
  const delays = [0, 500, 1_000, 2_000, 4_000, 8_000];
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout>;
  const schedule = () => {
    if (controller.signal.aborted || attempt >= delays.length) return;
    timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ aid: String(input.aid), mode: input.mode, cycle: input.cycleId });
        const response = await fetch(`/api/player/risk?${params}`, { cache: "no-store", signal: controller.signal });
        if (response.ok) {
          const body = await response.json() as {
            identity?: { aid?: number; mode?: string; cycleId?: string };
            risk?: PublicRiskView | null;
          };
          if (controller.signal.aborted) return;
          if (body.identity?.aid !== input.aid || body.identity.mode !== input.mode || body.identity.cycleId !== input.cycleId) return;
          const risk = body.risk;
          if (risk && risk.score != null && Number.isFinite(risk.score) && risk.available !== false
            && risk.availability !== "unavailable" && (risk.profileUpdatedAt ?? 0) >= input.profileUpdatedAt) {
            onRisk(risk);
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
