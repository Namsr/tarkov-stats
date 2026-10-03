// These unlocked achievements prove the account reached each prestige level,
// even when the Seasonal profile's info.prestigeLevel has been reset to zero.
const PRESTIGE_ACHIEVEMENTS = [
  "676091c0f457869a94017a23",
  "676094451fec2f7426093be6",
  "6842c25bd02bc07d70054019",
  "6842c27a38482d35ac0bd847",
  "68d3fe84757f8967ec09099b",
  "68d3ff840531ed76e808866c",
] as const;

export function seasonalPrestige(reported: number | null, achievementIds: readonly string[]): number | null {
  let prestige = reported;
  for (const [index, id] of PRESTIGE_ACHIEVEMENTS.entries()) {
    if (achievementIds.includes(id)) prestige = Math.max(prestige ?? 0, index + 1);
  }
  return prestige;
}
