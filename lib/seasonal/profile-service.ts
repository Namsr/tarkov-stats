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

  let store: SeasonalStore | null | undefined;
  type StoredProfile = Awaited<ReturnType<SeasonalStore["getProfile"]>>;
  let storedProfile: StoredProfile = null;
  const loadStore = async (): Promise<{ store: SeasonalStore | null; profile: StoredProfile }> => {
    if (store !== undefined) return { store: store ?? null, profile: storedProfile };
    try {
      store = await dependencies.getStore();
      if (store) {
        try {
          storedProfile = await store.getProfile({ mode: "seasonal", cycleId: input.cycleId, aid: input.aid });
        } catch {
          // A failed read must not prevent a fresh upstream profile from being
          // captured; the write path below will still surface storage failures.
          storedProfile = null;
        }
      }
    } catch {
      store = null;
    }
    return { store: store ?? null, profile: storedProfile };
  };

  const storedResult = async () => {
    const loaded = await loadStore();
    const profile = loaded.profile;
    if (!profile || profile.confirmedBanned || input.expectedUpdatedAt !== undefined) return null;
    return {
      ok: true as const,
      profile,
      capture: { inserted: false, status: "stored" },
    };
  };

  if (!input.force && input.expectedUpdatedAt === undefined) {
    const stored = await storedResult();
    if (stored) return stored;
  }

  let payload: unknown;
  try {
    payload = await dependencies.fetchPayload(input);
  } catch (error) {
    const fallback = await storedResult();
    if (fallback) return fallback;
    const status = typeof error === "object" && error !== null &&
      Number((error as { status?: unknown }).status) === 404 ? 404 : 502;
    return { ok: false, status, error: status === 404 ? "Seasonal profile not found" : "Failed to fetch Seasonal profile" };
  }

  const validated = dependencies.validatePayload(payload, cycle);
  if (!validated.ok) {
    const fallback = await storedResult();
    if (fallback) return fallback;
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

  const loaded = await loadStore();
  if (loaded.profile && !loaded.profile.confirmedBanned &&
      loaded.profile.profileUpdatedAt > validated.profile.profileUpdatedAt) {
    const fallback = await storedResult();
    if (fallback) return fallback;
  }

  if (!loaded.store) {
    return { ok: false, status: 503, error: "Seasonal profile storage unavailable" };
  }

  const observedAt = dependencies.now?.() ?? Date.now();
  try {
    const upsertedProfile = await loaded.store.upsertProfile(validated.profile, observedAt);
    if (upsertedProfile.profileUpdatedAt > validated.profile.profileUpdatedAt &&
        !upsertedProfile.confirmedBanned && input.expectedUpdatedAt === undefined) {
      return {
        ok: true,
        profile: upsertedProfile,
        capture: { inserted: false, status: "stored" },
      };
    }
    // Keep the validated Seasonal object (including its non-enumerable own
    // achievement/stat payload) and hydrate only this account-wide field from
    // the identity-scoped stored profile. No Seasonal combat counter is copied.
    validated.profile.lifetimePvpHours = upsertedProfile.lifetimePvpHours;
    validated.profile.pvpEnrichment = upsertedProfile.pvpEnrichment;
    const capture = await loaded.store.captureSnapshot(validated.profile, observedAt);
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
