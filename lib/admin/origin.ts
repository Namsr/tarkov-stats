function firstHeaderValue(value: string | null): string | null {
  const first = value?.split(",", 1)[0]?.trim();
  return first || null;
}

function normalizeOrigin(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * Accept same-site mutations when Next runs behind a trusted reverse proxy.
 * In that setup request.url can contain the internal web origin, while the
 * browser Origin and forwarded public host contain the real site origin.
 */
export function isValidMutationOrigin(request: Request): boolean {
  const origin = normalizeOrigin(request.headers.get("origin"));
  if (!origin) return false;

  const allowed = new Set<string>();
  const requestOrigin = normalizeOrigin(request.url);
  if (requestOrigin) allowed.add(requestOrigin);
  const configuredOrigin = normalizeOrigin(process.env.PUBLIC_BASE_URL ?? null);
  if (configuredOrigin) allowed.add(configuredOrigin);

  const forwardedHost = firstHeaderValue(request.headers.get("x-forwarded-host"))
    ?? firstHeaderValue(request.headers.get("host"));
  const forwardedProto = firstHeaderValue(request.headers.get("x-forwarded-proto"))?.replace(/:$/, "")
    ?? new URL(request.url).protocol.replace(/:$/, "");
  if (forwardedHost && (forwardedProto === "http" || forwardedProto === "https")) {
    allowed.add(`${forwardedProto}://${forwardedHost}`);
  }

  return allowed.has(origin);
}
