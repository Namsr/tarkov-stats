function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Build the same character render used by tarkov.dev from a mode's public profile. */
export function profilePortraitUrl(profile: unknown, aid: number): string | null {
  if (!Number.isSafeInteger(aid) || aid <= 0 || !record(profile) || profile.aid !== aid) return null;
  if (!record(profile.customization) || !record(profile.equipment) || !Array.isArray(profile.equipment.Items)) return null;

  // Arena uses suit IDs; the renderer expects the base clothing IDs used by tarkov.dev.
  const customization = profile.customization.upperSuitId ? {
    head: "5cc084dd14c02e000b0550a3",
    body: "5cc0858d14c02e000c6bea66",
    feet: "5cc085bb14c02e000e67a5c5",
    hands: "5cc0876314c02e000c6bea6b",
  } : profile.customization;
  if (!["head", "body", "feet", "hands"].every((key) =>
    typeof customization[key] === "string" && /^[a-f0-9]{24}$/i.test(customization[key]),
  )) return null;

  const url = new URL(`https://imagemagic.tarkov.dev/player/${aid}.webp`);
  url.searchParams.set("data", JSON.stringify({ aid, customization, equipment: profile.equipment }));
  return url.toString();
}
