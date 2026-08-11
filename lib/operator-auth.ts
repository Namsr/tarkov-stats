/**
 * Authentication for the local profile-refresh runner.
 *
 * The runner talks to production over HTTPS, so the secret is deliberately
 * server-only (never NEXT_PUBLIC_*) and accepted only as a Bearer token.
 */
export async function isOperatorRequest(request: Request): Promise<boolean> {
  const expected = process.env.PROFILE_REFRESH_SECRET;
  if (!expected || expected.length < 32) return false;

  const authorization = request.headers.get("authorization") ?? "";
  const prefix = "Bearer ";
  if (!authorization.startsWith(prefix)) return false;

  const supplied = authorization.slice(prefix.length);
  const encoder = new TextEncoder();
  const [expectedHash, suppliedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
    crypto.subtle.digest("SHA-256", encoder.encode(supplied)),
  ]);

  const a = new Uint8Array(expectedHash);
  const b = new Uint8Array(suppliedHash);
  let difference = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    difference |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return difference === 0;
}

export function operatorNoStoreHeaders(): Record<string, string> {
  return {
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  };
}
