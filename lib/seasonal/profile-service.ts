import type { SeasonalProfile, SeasonalStore, SeasonCycle } from "../../types/seasonal";

export interface SeasonalProfileDependencies {
  loadCycle: () => SeasonCycle | null;
  allowDisabledCycle?: boolean;
  validatePayload: (
    payload: unknown,
    cycle: SeasonCycle
  ) => { ok: true; profile: SeasonalProfile } | { ok: false; code: string };
  fetchPayload?: (input: {
    aid: number;
    cycleId: string;
    force: boolean;
    expectedUpdatedAt?: number;
  }) => Promise<unknown>;
  getStore: () => Promise<SeasonalStore | null>;
  afterCapture?: (input: {
    cycle: SeasonCycle;
    profile: SeasonalProfile;
    capture: Awaited<ReturnType<SeasonalStore["captureSnapshot"]>>;
    observedAt: number;
  }) => Promise<void>;
  now?: () => number;
}

export type SeasonalProfileResult =
  | {
      ok: true;
      profile: SeasonalProfile;
      capture: { inserted: boolean; status: string };
    }
  | { ok: false; status: 404 | 409 | 502 | 503; error: string };

/**
 * Canonical Seasonal profile pipeline. The network adapter is deliberately
 * injected: no production endpoint is assumed until the real upstream URL is
 * confirmed alongside its payload fixture.
 */
export async function resolveSeasonalProfile(
  input: { aid: number; cycleId: string; force: boolean; expectedUpdatedAt?: number },
  dependencies: SeasonalProfileDependencies
): Promise<SeasonalProfileResult> {
  const cycle = dependencies.loadCycle();
  if (!cycle || (!cycle.enabled && !dependencies.allowDisabledCycle) ||
      cycle.cycleId !== input.cycleId || !cycle.upstreamContract) {
    return { ok: false, status: 503, error: "Seasonal profile unavailable" };
  }
  if (!dependencies.fetchPayload) {
    return { ok: false, status: 503, error: "Seasonal upstream endpoint is not configured" };
  }

  let payload: unknown;
  try {
    payload = await dependencies.fetchPayload(input);
  } catch (error) {
    const status = typeof error === "object" && error !== null &&
      Number((error as { status?: unknown }).status) === 404 ? 404 : 502;
    return { ok: false, status, error: status === 404 ? "Seasonal profile not found" : "Failed to fetch Seasonal profile" };
  }

  const validated = dependencies.validatePayload(payload, cycle);
  if (!validated.ok) {
    const status = validated.code === "no_completed_raids" ? 404 : 502;
    return { ok: false, status, error: "Invalid Seasonal profile payload" };
  }
  if (validated.profile.aid !== input.aid) {
    return { ok: false, status: 502, error: "Seasonal profile account mismatch" };
  }
  if (input.expectedUpdatedAt !== undefined &&
      (!Number.isSafeInteger(input.expectedUpdatedAt) || input.expectedUpdatedAt <= 0)) {
    return { ok: false, status: 409, error: "Invalid Seasonal profile version" };
  }
  if (input.expectedUpdatedAt !== undefined && validated.profile.profileUpdatedAt < input.expectedUpdatedAt) {
    return { ok: false, status: 409, error: "Seasonal profile is older than requested version" };
  }

  const store = await dependencies.getStore();
  if (!store) {
    return { ok: false, status: 503, error: "Seasonal profile storage unavailable" };
  }

  const observedAt = dependencies.now?.() ?? Date.now();
  try {
    await store.upsertProfile(validated.profile, observedAt);
    const capture = await store.captureSnapshot(validated.profile, observedAt);
    await dependencies.afterCapture?.({ cycle, profile: validated.profile, capture, observedAt });
    return {
      ok: true,
      profile: validated.profile,
      capture: { inserted: capture.inserted, status: capture.status },
    };
  } catch {
    return { ok: false, status: 503, error: "Seasonal profile storage unavailable" };
  }
}
