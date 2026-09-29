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

export type HelperSessionCheck =
  | { status: "valid"; helperId: string }
  | { status: "absent" }
  | { status: "invalid" };

/**
 * Tell a first visit apart from a cookie the client sent but cannot prove.
 *
 * `absent` may mint a new identity; `invalid` (corrupted, expired, forged, or
 * signed with a different key) must not, because handing out a fresh identity
 * in answer to a broken cookie silently moves the helper to a new vote key and
 * the queue resets behind them.
 *
 * A missing signing key is reported as `absent`, not `invalid`: it is a server
 * misconfiguration rather than a client fault, and no client can be at fault
 * for a cookie the server can no longer check. `claim` never observes this
 * branch, because `isCommunityReviewEnabled` rejects the request with 404
 * first on the same `HELPER_COOKIE_SECRET` length threshold; it is here for
 * the callers that no such gate covers.
 *
 * An empty value counts as `absent` for the same reason as no cookie at all:
 * minting is already free for a client that sends no `Cookie` header, so
 * `seasonal_helper=` opens nothing new. The only thing that stops it from
 * being read as tampering is that a browser which dropped the cookie sends
 * nothing, so treating an empty value as `invalid` would turn ordinary cookie
 * clearing into a permanent 401.
 */
export async function classifyHelperSession(
  token: string | undefined,
  env: HelperEnvironment = process.env,
): Promise<HelperSessionCheck> {
  const key = helperKey(env);
  if (!token || !key) return { status: "absent" };
  try {
    const { payload } = await jwtVerify(token, key, { algorithms: ["HS256"] });
    return payload.scope === "seasonal-helper" &&
      typeof payload.sub === "string" &&
      /^[0-9a-f-]{36}$/i.test(payload.sub)
      ? { status: "valid", helperId: payload.sub }
      : { status: "invalid" };
  } catch {
    return { status: "invalid" };
  }
}

/**
 * Session id for callers that only need to know whether one exists.
 *
 * Invalid, expired, or misconfigured cookies still deliberately resolve to no
 * session here; see {@link classifyHelperSession} for the case this collapses.
 */
export async function verifyHelperSession(
  token: string | undefined,
  env: HelperEnvironment = process.env,
): Promise<string | null> {
  const session = await classifyHelperSession(token, env);
  return session.status === "valid" ? session.helperId : null;
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
