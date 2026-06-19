/**
 * Extracts an Escape from Tarkov account id from user input.
 * Accepts a bare numeric id ("7062102") or a tarkov.dev profile URL
 * ("https://tarkov.dev/players/regular/7062102", "/players/pve/7062102", ...).
 * Returns null when no valid id can be parsed.
 */
export function parsePlayerId(input: string): number | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // tarkov.dev/players/<mode>/<aid> with optional protocol, query or hash.
  const urlMatch = trimmed.match(/players\/[a-z]+\/(\d{1,15})(?:[/?#]|$)/i);
  if (urlMatch) return toAid(urlMatch[1]);

  // Bare numeric id.
  if (/^\d{1,15}$/.test(trimmed)) return toAid(trimmed);

  return null;
}

function toAid(digits: string): number | null {
  const n = Number(digits);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
