/* eslint-disable @typescript-eslint/no-explicit-any -- node:sqlite is loaded dynamically because the project's Node types predate it. */
import type { LeaderboardSort } from "@/types/leaderboard";
// @ts-expect-error Node's direct TypeScript runner needs the explicit extension.
import { leaderboardScope, type LeaderboardScopeConfig } from "./config.ts";
// @ts-expect-error Node's direct TypeScript runner needs the explicit extension.
import { materializeCandidate, type MaterializedCandidate } from "./materialize.ts";
// @ts-expect-error Node's direct TypeScript runner needs the explicit extension.
import { leaderboardPublicationsEnabled, openLeaderboardDatabase } from "./publication.ts";
// @ts-expect-error Node's direct TypeScript runner needs the explicit extension.
import { createLeaderboardReader } from "./service.ts";
// @ts-expect-error Node's direct TypeScript runner needs the explicit extension.
import { leaderboardSourceRows } from "./source.ts";

const sourceDatabases = new Map<string, any>();

async function openSourceDatabase(config: LeaderboardScopeConfig): Promise<any> {
  const path = config.mode === "pvp-season"
    ? process.env.PROGRESSION_SQLITE_PATH || process.env.PROGRESSION_DB_PATH || "/data/progression.db"
    : process.env.SQLITE_PATH || "/data/players.db";
  const existing = sourceDatabases.get(path);
  if (existing) return existing;
  const sqlite = await import("node:sqlite" as string);
  const db = new sqlite.DatabaseSync(path, { readOnly: true });
  if (config.mode === "pvp-season") db.prepare("ATTACH DATABASE ? AS players_db")
    .run(process.env.SQLITE_PATH || "/data/players.db");
  sourceDatabases.set(path, db);
  return db;
}

async function attachExclusions(db: any, includeSeasonal: boolean): Promise<void> {
  const attached = db.prepare("PRAGMA database_list").all().some((row: any) => row.name === "players_db");
  if (!attached) db.prepare("ATTACH DATABASE ? AS players_db").run(process.env.SQLITE_PATH || "/data/players.db");
  const progressionAttached = db.prepare("PRAGMA database_list").all().some((row: any) => row.name === "progression_db");
  if (includeSeasonal && !progressionAttached) db.prepare("ATTACH DATABASE ? AS progression_db")
    .run(process.env.PROGRESSION_SQLITE_PATH || process.env.PROGRESSION_DB_PATH || "/data/progression.db");
}

export async function leaderboardRuntime(config?: LeaderboardScopeConfig): Promise<{
  reader: ReturnType<typeof createLeaderboardReader>;
} | null> {
  if (!leaderboardPublicationsEnabled()) return null;
  try {
    const publication = await openLeaderboardDatabase();
    await attachExclusions(publication, config?.mode === "pvp-season");
    const reader = createLeaderboardReader(publication);
    return { reader };
  } catch (error) {
    console.warn("leaderboard runtime unavailable: " + (error instanceof Error ? error.message : String(error)));
    return null;
  }
}

export async function prepareLeaderboardCandidate(
  reader: ReturnType<typeof createLeaderboardReader>,
  config: LeaderboardScopeConfig,
  aid: number,
): Promise<{ generation: number; generatedAt: number; candidate: MaterializedCandidate | null } | null> {
  const snap = reader.snapshot(config);
  if (!snap) return null;
  const source = await openSourceDatabase(config);
  const next = leaderboardSourceRows(source, config, aid)[Symbol.iterator]().next();
  return { generation: snap.generation, generatedAt: snap.generatedAt,
    candidate: next.done ? null : materializeCandidate(next.value, { config, formula: snap.params.formula ?? null }) };
}

export function parseLeaderboardRequest(searchParams: URLSearchParams): {
  config: LeaderboardScopeConfig;
  sort: LeaderboardSort;
  aid: number | null;
} {
  const mode = searchParams.get("mode") ?? "regular";
  if (mode !== "regular" && mode !== "pve" && mode !== "arena" && mode !== "pvp-season") throw new Error("invalid mode");
  const arenaModeRaw = searchParams.get("arenaMode") ?? (mode === "arena" ? "blastGang" : null);
  const arenaModes = ["teamFight", "lastHero", "checkpoint", "blastGang", "shootOutDuo"] as const;
  const arenaMode = mode === "arena" && arenaModes.includes(arenaModeRaw as typeof arenaModes[number])
    ? arenaModeRaw as typeof arenaModes[number] : null;
  if ((mode === "arena") !== (arenaMode != null)) throw new Error("arenaMode is required only for Arena");
  const config = leaderboardScope(mode, arenaMode);
  if (!config) throw new Error("unsupported leaderboard scope");
  const cycle = searchParams.get("cycle");
  if (cycle != null && !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(cycle)) throw new Error("invalid cycle");
  if (mode === "pvp-season" ? cycle != null && cycle !== config.cycleId : cycle != null) {
    throw new Error("cycle does not match the active leaderboard");
  }
  const sort = searchParams.get("sort") ?? "primary";
  if (sort !== "primary" && sort !== "kd" && sort !== "killsPerMatch" && sort !== "hours") {
    throw new Error("invalid sort");
  }
  const aidRaw = searchParams.get("aid");
  if (aidRaw != null && !/^[1-9]\d*$/.test(aidRaw)) throw new Error("invalid aid");
  const aid = aidRaw == null ? null : Number(aidRaw);
  if (aid != null && !Number.isSafeInteger(aid)) throw new Error("invalid aid");
  return { config, sort, aid };
}

export function resetLeaderboardRuntimeForTests(): void {
  for (const db of sourceDatabases.values()) db.close?.();
  sourceDatabases.clear();
}
