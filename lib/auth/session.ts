import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";

/** Minimal user identity stored inside the signed session cookie. */
export interface SessionUser {
  sub: string; // Google account id (stable, unique per user)
  email: string;
  name: string;
  picture: string;
}

export const SESSION_COOKIE = "session";
export const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

type CookieOptions = {
  httpOnly: boolean;
  secure: boolean;
  sameSite: "lax";
  path: string;
  maxAge: number;
};

/** Cookie flags shared by every auth-related cookie we set. */
export function sessionCookieOptions(maxAge: number = SESSION_MAX_AGE): CookieOptions {
  return {
    httpOnly: true,
    // localhost runs over http in dev, where Secure cookies are never stored.
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge,
  };
}

function getKey(): Uint8Array {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error(
      "AUTH_SECRET is not set. Generate one with: openssl rand -base64 32"
    );
  }
  return new TextEncoder().encode(secret);
}

/** Sign the user identity into a compact JWT used as the session value. */
export async function encryptSession(user: SessionUser): Promise<string> {
  return new SignJWT({
    email: user.email,
    name: user.name,
    picture: user.picture,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.sub)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE}s`)
    .sign(getKey());
}

/** Verify a session token and return the user, or null if invalid/expired. */
export async function decryptSession(
  token: string | undefined
): Promise<SessionUser | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, getKey(), {
      algorithms: ["HS256"],
    });
    if (!payload.sub) return null;
    return {
      sub: payload.sub,
      email: typeof payload.email === "string" ? payload.email : "",
      name: typeof payload.name === "string" ? payload.name : "",
      picture: typeof payload.picture === "string" ? payload.picture : "",
    };
  } catch {
    return null;
  }
}

/** Read and verify the session from the request cookies (server-side only). */
export async function getSession(): Promise<SessionUser | null> {
  const cookieStore = await cookies();
  return decryptSession(cookieStore.get(SESSION_COOKIE)?.value);
}
