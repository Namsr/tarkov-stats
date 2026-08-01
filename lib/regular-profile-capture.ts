import type { PlayerSnapshotInput } from "@/lib/ban-db";
import { getStore, type PlayerStore } from "@/lib/db";
import { captureSnapshot, type CaptureSnapshotResult } from "@/lib/progression-db";

interface PersistRegularProfileOptions {
  upsertPlayer?: boolean;
  strict?: boolean;
  playerStore?: PlayerStore | null;
}

/** Capture the version before allowing the primary player row to advance. */
export async function persistRegularProfileSnapshot(
  snapshot: PlayerSnapshotInput,
  options: PersistRegularProfileOptions = {},
): Promise<CaptureSnapshotResult | null> {
  let capture: CaptureSnapshotResult | null = null;
  try {
    capture = await captureSnapshot(snapshot);
  } catch (error) {
    if (options.strict) throw error;
    console.error("regular progression capture failed", error);
  }

  if (options.upsertPlayer !== false) {
    const store = options.playerStore === undefined ? await getStore() : options.playerStore;
    if (!store) {
      if (options.strict) throw new Error("player store unavailable");
    } else {
      await store.upsert(snapshot.aid, snapshot.stats, snapshot.achievementIds);
    }
  }
  return capture;
}
