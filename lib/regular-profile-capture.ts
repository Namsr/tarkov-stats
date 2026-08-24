import type { PlayerSnapshotInput } from "@/lib/ban-db";
import { getStore, type PlayerStore } from "@/lib/db";
import {
  captureSnapshot,
  type CaptureSnapshotResult,
} from "@/lib/progression-db";
import type { PersistentProgressionMode } from "@/lib/regular-progression";

export interface PersistRegularProfileOptions {
  /** Regular remains the default for legacy callers. */
  mode?: PersistentProgressionMode;
  upsertPlayer?: boolean;
  strict?: boolean;
  playerStore?: PlayerStore | null;
}

/** Capture the version before allowing the primary player row to advance. */
export async function persistRegularProfileSnapshot(
  snapshot: PlayerSnapshotInput,
  options: PersistRegularProfileOptions = {},
): Promise<CaptureSnapshotResult | null> {
  const mode = options.mode ?? "regular";
  let capture: CaptureSnapshotResult | null = null;
  try {
    capture = await captureSnapshot(snapshot, mode);
  } catch (error) {
    if (options.strict) throw error;
    console.error("persistent progression capture failed", error);
  }

  if (options.upsertPlayer !== false) {
    const store = options.playerStore === undefined ? await getStore(mode) : options.playerStore;
    if (!store) {
      if (options.strict) throw new Error("player store unavailable");
    } else {
      await store.upsert(snapshot.aid, snapshot.stats, snapshot.achievementIds);
    }
  }
  return capture;
}
