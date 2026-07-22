export type ProfileSummaryMode = "regular" | "pve" | "arena";

export interface ProfileSummary {
  nickname: string;
  side?: string;
  prestige?: number;
}

const MODE_ORDER: readonly ProfileSummaryMode[] = ["regular", "pve", "arena"];

export async function findProfileSummary(
  aid: number,
  unavailableMode: ProfileSummaryMode,
  read: (mode: ProfileSummaryMode, aid: number) => Promise<ProfileSummary | null>,
): Promise<ProfileSummary | null> {
  for (const mode of MODE_ORDER) {
    if (mode === unavailableMode) continue;
    const summary = await read(mode, aid).catch(() => null);
    if (summary) return summary;
  }
  return null;
}
