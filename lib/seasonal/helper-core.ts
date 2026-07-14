import { SignJWT, jwtVerify } from "jose";

export const HELPER_COOKIE = "seasonal_helper";
export const HELPER_SESSION_MAX_AGE = 60 * 60 * 24 * 30;

type HelperEnvironment = Record<string, string | undefined>;

export interface HelperTaskLease {
  id: number;
  mode: "seasonal";
  cycleId: string;
  aid: number;
  state: "leased" | string;
  leaseOwner: string | null;
  leasedUntil: number | null;
  previousProfileUpdatedAt: number | null;
}

export interface VerifiedHelperProfile {
  mode: "seasonal";
  cycleId: string;
  aid: number;
  profileUpdatedAt: number;
}

export type HelperCompletionDecision =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "feature_disabled"
        | "invalid_session"
        | "invalid_lease"
        | "lease_expired"
        | "identity_mismatch"
        | "stale_profile"
        | "invalid_timestamp";
    };

export function parseHelperTaskId(body: unknown): number | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== "taskId") return null;
  const id = (body as { taskId?: unknown }).taskId;
  return Number.isSafeInteger(id) && Number(id) > 0 ? Number(id) : null;
}

export function helperCookieOptions(maxAge = HELPER_SESSION_MAX_AGE) {
  return {
    httpOnly: true as const,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge,
  };
}

function helperKey(env: HelperEnvironment): Uint8Array | null {
  const secret = env.HELPER_COOKIE_SECRET?.trim();
  return secret && secret.length >= 32 ? new TextEncoder().encode(secret) : null;
}

/** Create an anonymous token containing only the random helper id. */
export async function signHelperSession(
  helperId: string,
  env: HelperEnvironment = process.env,
): Promise<string> {
  const key = helperKey(env);
  if (!key) throw new Error("HELPER_COOKIE_SECRET must contain at least 32 characters");
  if (!/^[0-9a-f-]{36}$/i.test(helperId)) throw new Error("invalid helper id");
  return new SignJWT({ scope: "seasonal-helper" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(helperId)
    .setIssuedAt()
    .setExpirationTime(`${HELPER_SESSION_MAX_AGE}s`)
    .sign(key);
}

/** Invalid, expired, or misconfigured cookies deliberately resolve to no session. */
export async function verifyHelperSession(
  token: string | undefined,
  env: HelperEnvironment = process.env,
): Promise<string | null> {
  const key = helperKey(env);
  if (!token || !key) return null;
  try {
    const { payload } = await jwtVerify(token, key, { algorithms: ["HS256"] });
    return payload.scope === "seasonal-helper" &&
      typeof payload.sub === "string" &&
      /^[0-9a-f-]{36}$/i.test(payload.sub)
      ? payload.sub
      : null;
  } catch {
    return null;
  }
}

/**
 * Authorize completion from trusted task and server-fetched profile records.
 * Client-supplied profile JSON is intentionally not part of this contract.
 */
export function verifyHelperCompletion(input: {
  enabled: boolean;
  helperId: string | null;
  task: HelperTaskLease;
  profile: VerifiedHelperProfile;
  cycleStartsAt: number;
  cycleEndsAt: number | null;
  now?: number;
}): HelperCompletionDecision {
  if (!input.enabled) return { ok: false, reason: "feature_disabled" };
  if (!input.helperId) return { ok: false, reason: "invalid_session" };

  const { task, profile } = input;
  const now = input.now ?? Date.now();
  if (task.state !== "leased" || task.leaseOwner !== input.helperId || task.leasedUntil === null) {
    return { ok: false, reason: "invalid_lease" };
  }
  if (task.leasedUntil <= now) return { ok: false, reason: "lease_expired" };
  if (
    task.mode !== "seasonal" ||
    profile.mode !== task.mode ||
    profile.cycleId !== task.cycleId ||
    profile.aid !== task.aid
  ) {
    return { ok: false, reason: "identity_mismatch" };
  }
  if (!Number.isSafeInteger(profile.aid) || profile.aid <= 0 || !Number.isFinite(profile.profileUpdatedAt)) {
    return { ok: false, reason: "invalid_timestamp" };
  }
  if (
    profile.profileUpdatedAt < input.cycleStartsAt ||
    (input.cycleEndsAt !== null && profile.profileUpdatedAt > input.cycleEndsAt) ||
    profile.profileUpdatedAt > now + 5 * 60_000
  ) {
    return { ok: false, reason: "invalid_timestamp" };
  }
  if (
    task.previousProfileUpdatedAt !== null &&
    profile.profileUpdatedAt <= task.previousProfileUpdatedAt
  ) {
    return { ok: false, reason: "stale_profile" };
  }
  return { ok: true };
}
