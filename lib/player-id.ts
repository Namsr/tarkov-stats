export type ParsedPlayerInput = {
  aid: number;
  mode: "regular" | "pve" | "arena" | "seasonal";
};

/** Extracts the mode and account id from a numeric id or tarkov.dev profile URL. */
export function parsePlayerInput(input: string): ParsedPlayerInput | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // tarkov.dev/players/<mode>/<aid> with optional protocol, query or hash.
  const urlMatch = trimmed.match(/players\/(regular|pve|arena|seasonal)\/(\d{1,15})(?:[/?#]|$)/i);
  if (urlMatch) {
    const aid = toAid(urlMatch[2]);
    return aid === null
      ? null
      : { aid, mode: urlMatch[1].toLowerCase() as ParsedPlayerInput["mode"] };
  }

  // Bare numeric id.
  if (/^\d{1,15}$/.test(trimmed)) {
    const aid = toAid(trimmed);
    return aid === null ? null : { aid, mode: "regular" };
  }

  return null;
}

/** Backward-compatible id-only parser for API validation and comparisons. */
export function parsePlayerId(input: string): number | null {
  return parsePlayerInput(input)?.aid ?? null;
}

function toAid(digits: string): number | null {
  const n = Number(digits);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
