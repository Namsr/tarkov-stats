export function authSecretKey(secret: string | undefined, nodeEnv: string | undefined): Uint8Array {
  if (!secret) {
    throw new Error("AUTH_SECRET is not set. Generate one with: openssl rand -base64 32");
  }
  const key = new TextEncoder().encode(secret);
  if (nodeEnv === "production" && key.byteLength < 32) {
    throw new Error("AUTH_SECRET must be at least 32 bytes in production");
  }
  return key;
}
