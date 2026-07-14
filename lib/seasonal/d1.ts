// Minimal D1 surface used by Seasonal stores. Keeping this local avoids a
// dependency on generated Worker types in the self-hosted Node build.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type D1DatabaseLike = any;

export async function getSeasonalD1(): Promise<D1DatabaseLike | null> {
  try {
    const mod = await import("@opennextjs/cloudflare");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (mod.getCloudflareContext().env as any).DB ?? null;
  } catch {
    return null;
  }
}

export function d1Rows(result: { results?: unknown[] } | null | undefined): Record<string, unknown>[] {
  return (result?.results ?? []) as Record<string, unknown>[];
}

export function d1Changes(result: { meta?: { changes?: number } } | null | undefined): number {
  return Number(result?.meta?.changes ?? 0);
}
