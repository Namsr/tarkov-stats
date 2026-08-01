// @ts-expect-error Node's strip-types test runner requires the extension; Next accepts it.
import { canonicalAdminHost } from "./types.ts";
// @ts-expect-error Node's strip-types test runner requires the extension; Next accepts it.
import { getAnalyticsStore, type RequestEvent } from "./analytics-db.ts";
import { createHmac } from "node:crypto";

export type RequestEventInput = Omit<RequestEvent, "host"> & { host?: string | null };

export async function recordRequestEvent(input: RequestEventInput): Promise<void> {
  try {
    const store = await getAnalyticsStore();
    store?.record({ ...input, host: canonicalAdminHost(input.host) });
  } catch (error) {
    // Never include AID or other request context in operational logs.
    console.warn("admin analytics write failed: " + (error as Error).message);
  }
}

async function recordAuth(sub: string, kind: "sign_in" | "activity"): Promise<void> {
  const secret = process.env.ANALYTICS_HASH_SECRET;
  if (!secret || !sub || sub === process.env.ADMIN_GOOGLE_SUB) return;
  try {
    const subjectHash = createHmac("sha256", secret).update(sub).digest("hex");
    const store = await getAnalyticsStore();
    store?.recordAuth(subjectHash, kind);
  } catch (error) {
    console.warn("admin auth analytics write failed: " + (error as Error).message);
  }
}

export function recordAuthSignIn(sub: string): Promise<void> {
  return recordAuth(sub, "sign_in");
}

export function recordAuthActivity(sub: string): Promise<void> {
  return recordAuth(sub, "activity");
}
