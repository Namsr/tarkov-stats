import { setTimeout as delay } from "node:timers/promises";

/** Retry a complete operation after its transaction has rolled back, yielding to HTTP. */
export async function retrySqliteBusy<T>(operation: () => T | Promise<T>, maxWaitMs = 30_000): Promise<T> {
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    try { return await operation(); }
    catch (error) {
      const code = error as { code?: string; errcode?: number; message?: string };
      const busy = code?.code === "SQLITE_BUSY" || code?.code === "SQLITE_LOCKED" ||
        (code?.errcode != null && [5, 6].includes(code.errcode & 255)) ||
        /database (?:is )?(?:locked|busy)/i.test(code?.message ?? "");
      if (!busy || Date.now() >= deadline) throw error;
      await delay(Math.min(100, Math.max(1, deadline - Date.now())));
    }
  }
}

export function retrySqliteStore<T extends object>(store: T): T {
  return Object.fromEntries(Object.entries(store).map(([key, method]) => [key,
    typeof method === "function" ? (...args: unknown[]) => retrySqliteBusy(() => method.apply(store, args)) : method,
  ])) as T;
}
