/* eslint-disable @typescript-eslint/no-explicit-any -- node:sqlite is loaded dynamically because the project's Node types predate it. */
import type {
  ArenaLeaderboardTab,
  LeaderboardMeta,
  LeaderboardPageResponse,
  LeaderboardPublicationStatus,
  LeaderboardRankResponse,
  LeaderboardRow,
  LeaderboardSort,
  LeaderboardStats,
} from "@/types/leaderboard";
// @ts-expect-error Node's direct TypeScript runner needs the explicit extension.
import { leaderboardScope, type LeaderboardScopeConfig } from "./config.ts";
// @ts-expect-error Node's direct TypeScript runner needs the explicit extension.
import { LEADERBOARD_STALE_MS } from "./publication.ts";
import type { MaterializedCandidate } from "./materialize";
// @ts-expect-error Node's direct TypeScript runner needs the explicit extension.
import { compareOrderKeys, type OrderKey } from "./ranking.ts";

interface Snapshot {
  scope: string;
  generation: number;
  generatedAt: number;
  formulaVersion: number;
  rankedCount: number;
  groupCount: number;
  params: any;
  tabs: ArenaLeaderboardTab[] | null;
  status: LeaderboardPublicationStatus;
}

interface OrderRow extends Record<string, unknown> {
  aid: number;
  nickname: string;
  ordinal: number;
  primary_ordinal: number | null;
  status: string;
  score: number | null;
  stats_json: string;
  k1: number; k2: number; k3: number; k4: number; k5: number; stable_key: number;
  pk1: number | null; pk2: number | null; pk3: number | null; pk4: number | null; pk5: number | null; pstable_key: number | null;
}

const EMPTY_STATS: LeaderboardStats = {
  raidsOrMatches: null, kills: null, deaths: null, kd: null, deathless: false,
  killsPerMatch: null, hours: null, arp: null, currentArp: null, bestArp: null, arpSource: null,
};

function countAtOrBefore(sorted: number[], ordinal: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (sorted[middle] <= ordinal) low = middle + 1;
    else high = middle;
  }
  return low;
}

function keyFrom(row: OrderRow, prefix = ""): OrderKey | null {
  const keys = [row[`${prefix}k1`], row[`${prefix}k2`], row[`${prefix}k3`], row[`${prefix}k4`], row[`${prefix}k5`], row[`${prefix}stable_key`]];
  return keys.every((value) => typeof value === "number") ? keys as unknown as OrderKey : null;
}

export function createLeaderboardReader(db: any, exclusionTable = "players_db.excluded_players",
  seasonalExclusionTable = "progression_db.excluded_players",
  seasonalProfilesTable = "progression_db.player_profiles") {
  function excludedAidSql(config: LeaderboardScopeConfig): string {
    const sources = [`SELECT aid FROM ${exclusionTable}`];
    if (config.mode === "pvp-season" && config.cycleId) {
      const cycle = config.cycleId.replaceAll("'", "''");
      sources.push(`SELECT aid FROM ${seasonalExclusionTable}`);
      sources.push(`SELECT aid FROM ${seasonalProfilesTable} WHERE mode='seasonal'
        AND cycle_id='${cycle}' AND confirmed_banned=1`);
    }
    return sources.join(" UNION ");
  }

  function excludedSql(config: LeaderboardScopeConfig, alias: string): string {
    return `EXISTS (SELECT 1 FROM (${excludedAidSql(config)}) x WHERE x.aid=${alias}.aid)`;
  }

  function eligibleSql(config: LeaderboardScopeConfig, alias: string): string {
    return `NOT ${excludedSql(config, alias)}`;
  }

  function excluded(config: LeaderboardScopeConfig, aid: number): boolean {
    return Boolean(db.prepare(`SELECT 1 FROM (${excludedAidSql(config)}) x WHERE x.aid=? LIMIT 1`).get(aid));
  }

  function snapshot(config: LeaderboardScopeConfig, now = Date.now(), expectedGeneration?: number,
    expectedGeneratedAt?: number): Snapshot | null {
    const row = db.prepare(`SELECT c.generation,c.generated_at,g.formula_version,g.ranked_count,g.group_count,
      g.params_json,g.meta_json,s.last_started_at,s.last_completed_at,s.last_error
      FROM leaderboard_current c JOIN leaderboard_generations g ON g.scope=c.scope AND g.generation=c.generation
      LEFT JOIN leaderboard_state s ON s.scope=c.scope WHERE c.scope=?`).get(config.scope);
    if (!row) return null;
    if (expectedGeneration != null && Number(row.generation) !== expectedGeneration) return null;
    if (expectedGeneratedAt != null && Number(row.generated_at) !== expectedGeneratedAt) return null;
    const processing = row.last_started_at != null && Number(row.last_started_at) > Number(row.last_completed_at ?? 0);
    const status: LeaderboardPublicationStatus = row.last_error != null ? "error" : processing ? "publishing"
      : now - Number(row.generated_at) > LEADERBOARD_STALE_MS ? "stale" : "ready";
    const meta = JSON.parse(String(row.meta_json));
    const saved = JSON.parse(String(row.params_json));
    if (saved.mode !== config.mode || saved.arenaMode !== config.arenaMode || saved.cycleId !== config.cycleId ||
        saved.minimumSample !== config.minimumSample || saved.activityCutoffMs !== config.activityCutoffMs ||
        saved.arpSeasonId !== config.arpSeasonId || saved.arpSourceConfirmed !== config.arpSourceConfirmed) return null;
    return { scope: config.scope, generation: Number(row.generation), generatedAt: Number(row.generated_at),
      formulaVersion: Number(row.formula_version), rankedCount: Number(row.ranked_count),
      groupCount: Number(row.group_count), params: saved,
      tabs: Array.isArray(meta?.arenaTabs) ? meta.arenaTabs : null, status };
  }

  function unchanged(snap: Snapshot): boolean {
    const row = db.prepare("SELECT generation,generated_at FROM leaderboard_current WHERE scope=?").get(snap.scope);
    return Number(row?.generation) === snap.generation && Number(row?.generated_at) === snap.generatedAt;
  }

  function finish<T>(snap: Snapshot, response: T): T | null {
    return unchanged(snap) ? response : null;
  }

  function bannedOrdinals(config: LeaderboardScopeConfig, generation: number, sort: LeaderboardSort): number[] {
    return db.prepare(`SELECT o.ordinal FROM (${excludedAidSql(config)}) x
      CROSS JOIN leaderboard_order o ON o.scope=? AND o.generation=? AND o.sort=? AND o.aid=x.aid ORDER BY o.ordinal`)
      .all(config.scope, generation, sort)
      .map((row: any) => Number(row.ordinal));
  }

  function selectedRows(config: LeaderboardScopeConfig, generation: number, sort: LeaderboardSort,
    where: string, params: unknown[], limit: number, direction: "ASC" | "DESC" = "ASC", exceptAid?: number): OrderRow[] {
    return db.prepare(`SELECT o.*,m.nickname,m.status,m.score,m.stats_json,p.ordinal primary_ordinal,
      p.k1 pk1,p.k2 pk2,p.k3 pk3,p.k4 pk4,p.k5 pk5,p.stable_key pstable_key
      FROM leaderboard_order o JOIN leaderboard_members m ON m.scope=o.scope AND m.generation=o.generation AND m.aid=o.aid
      LEFT JOIN leaderboard_order p ON p.scope=o.scope AND p.generation=o.generation AND p.aid=o.aid AND p.sort='primary'
      WHERE o.scope=? AND o.generation=? AND o.sort=? AND ${where} AND ${eligibleSql(config, "o")}
        ${exceptAid == null ? "" : "AND o.aid<>?"}
      ORDER BY o.ordinal ${direction} LIMIT ?`).all(config.scope, generation, sort, ...params,
        ...(exceptAid == null ? [] : [exceptAid]), limit) as OrderRow[];
  }

  function liveCounts(config: LeaderboardScopeConfig, snap: Snapshot, candidate?: MaterializedCandidate | null,
    previous?: any): { ranked: number; group: number } {
    const banned = db.prepare(`SELECT
      SUM(CASE WHEN m.status='ranked' THEN 1 ELSE 0 END) ranked,
      SUM(CASE WHEN m.status='insufficient_sample' THEN 1 ELSE 0 END) grouped
      FROM (${excludedAidSql(config)}) x CROSS JOIN leaderboard_members m
        ON m.scope=? AND m.generation=? AND m.aid=x.aid`).get(config.scope, snap.generation);
    let ranked = snap.rankedCount - Number(banned?.ranked ?? 0);
    let group = snap.groupCount - Number(banned?.grouped ?? 0);
    if (candidate) {
      if (previous?.status === "ranked") ranked -= 1;
      if (previous?.status === "insufficient_sample") group -= 1;
      if (candidate.member.status === "ranked") ranked += 1;
      if (candidate.member.status === "insufficient_sample") group += 1;
    }
    return { ranked: Math.max(0, ranked), group: Math.max(0, group) };
  }

  function metadata(config: LeaderboardScopeConfig, snap: Snapshot, sort: LeaderboardSort,
    counts: { ranked: number; group: number }): LeaderboardMeta {
    const tabs = snap.tabs?.map((tab) => {
      const tabConfig = leaderboardScope("arena", tab.mode);
      if (!tabConfig) return tab;
      const removed = db.prepare(`SELECT COUNT(*) count FROM (${excludedAidSql(tabConfig)}) x
        CROSS JOIN leaderboard_current c
        CROSS JOIN leaderboard_members m ON m.scope=c.scope AND m.generation=c.generation AND m.aid=x.aid
        WHERE c.scope=?
          AND json_extract(m.stats_json,'$.raidsOrMatches') IS NOT NULL`).get(tabConfig.scope);
      return { ...tab, knownMatchProfiles: Math.max(0, tab.knownMatchProfiles - Number(removed?.count ?? 0)) };
    }) ?? null;
    return { generation: snap.generation, generatedAt: snap.generatedAt, formulaVersion: snap.formulaVersion,
      publicationStatus: snap.status, mode: config.mode, arenaMode: config.arenaMode, cycleId: config.cycleId, sort,
      primaryMetric: config.primaryMetric, rankedCount: counts.ranked, groupCount: counts.group,
      arenaTabs: tabs };
  }

  function previousMember(config: LeaderboardScopeConfig, snap: Snapshot, aid: number): any {
    return db.prepare("SELECT * FROM leaderboard_members WHERE scope=? AND generation=? AND aid=?")
      .get(config.scope, snap.generation, aid);
  }

  function rowFrom(order: OrderRow, selectedAid: number | null, selectedBans: number[], primaryBans: number[],
    candidatePrimary?: { key: OrderKey | null; oldOrdinal: number | null } | null,
    candidateSelected?: { key: OrderKey | null; oldOrdinal: number | null } | null,
    groupStart?: number): LeaderboardRow {
    const primaryOrdinal = order.primary_ordinal == null ? null : Number(order.primary_ordinal);
    let primaryRank: number | null = null;
    if (primaryOrdinal != null) primaryRank = primaryOrdinal - countAtOrBefore(primaryBans, primaryOrdinal);
    if (primaryRank != null && candidatePrimary) {
      if (candidatePrimary.oldOrdinal != null && candidatePrimary.oldOrdinal <= primaryOrdinal!) primaryRank -= 1;
      const rowKey = keyFrom(order, "p");
      if (candidatePrimary.key && rowKey && compareOrderKeys(candidatePrimary.key, rowKey) < 0) primaryRank += 1;
    }
    let position = Number(order.ordinal) - countAtOrBefore(selectedBans, Number(order.ordinal));
    if (candidateSelected) {
      if (candidateSelected.oldOrdinal != null && candidateSelected.oldOrdinal <= Number(order.ordinal)) position -= 1;
      const rowKey = keyFrom(order);
      if (candidateSelected.key && rowKey && compareOrderKeys(candidateSelected.key, rowKey) < 0) position += 1;
    }
    return { aid: Number(order.aid), nickname: String(order.nickname), position,
      primaryRank, groupStart: order.status === "insufficient_sample" ? groupStart ?? null : null,
      status: order.status as LeaderboardRow["status"],
      score: order.score == null ? null : Number(order.score), stats: JSON.parse(String(order.stats_json)),
      selected: Number(order.aid) === selectedAid };
  }

  function candidateOrder(candidate: MaterializedCandidate | null | undefined, sort: LeaderboardSort) {
    return candidate?.orders.find((order) => order.sort === sort) ?? null;
  }

  function insertionPosition(config: LeaderboardScopeConfig, snap: Snapshot, sort: LeaderboardSort,
    key: OrderKey, aid: number, bans: number[], oldOrdinal: number | null): number {
    const predecessor = db.prepare(`SELECT o.ordinal FROM leaderboard_order o WHERE o.scope=? AND o.generation=? AND o.sort=?
      AND (o.k1,o.k2,o.k3,o.k4,o.k5,o.stable_key) > (?,?,?,?,?,?) AND o.aid<>? AND ${eligibleSql(config, "o")}
      ORDER BY o.k1 ASC,o.k2 ASC,o.k3 ASC,o.k4 ASC,o.k5 ASC,o.stable_key ASC LIMIT 1`)
      .get(config.scope, snap.generation, sort, ...key, aid);
    if (!predecessor) return 1;
    const ordinal = Number(predecessor.ordinal);
    return ordinal - countAtOrBefore(bans, ordinal) - (oldOrdinal != null && oldOrdinal <= ordinal ? 1 : 0) + 1;
  }

  function candidateRow(candidate: MaterializedCandidate, position: number | null, primaryRank: number | null,
    groupStart: number | null): LeaderboardRow {
    return { aid: candidate.member.aid, nickname: candidate.member.nickname, position, primaryRank, groupStart,
      status: candidate.member.status, score: candidate.member.score, stats: candidate.member.stats, selected: true };
  }

  function readRank(config: LeaderboardScopeConfig, aid: number, candidate?: MaterializedCandidate | null,
    now = Date.now(), expectedGeneration?: number, expectedGeneratedAt?: number): LeaderboardRankResponse | null {
    const snap = snapshot(config, now, expectedGeneration, expectedGeneratedAt);
    if (!snap) return null;
    if (excluded(config, aid)) return finish(snap, { meta: metadata(config, snap, "primary", liveCounts(config, snap)),
      subject: { aid, nickname: "", position: null, primaryRank: null, groupStart: null,
        status: "excluded", score: null, stats: EMPTY_STATS, selected: true } });
    const previous = previousMember(config, snap, aid);
    const useFresh = candidate && (previous?.source_fingerprint !== candidate.member.sourceFingerprint ||
      Number(previous?.parser_version ?? -1) !== candidate.member.parserVersion ||
      Number(previous?.metric_version ?? -1) !== candidate.member.metricVersion) ? candidate : null;
    const counts = liveCounts(config, snap, useFresh, previous);
    if (useFresh) {
      const order = candidateOrder(useFresh, "primary");
      const old = db.prepare("SELECT ordinal FROM leaderboard_order WHERE scope=? AND generation=? AND sort='primary' AND aid=?")
        .get(config.scope, snap.generation, aid);
      const bans = bannedOrdinals(config, snap.generation, "primary");
      const rank = order ? insertionPosition(config, snap, "primary", order.key, aid, bans, old ? Number(old.ordinal) : null) : null;
      return finish(snap, { meta: metadata(config, snap, "primary", counts),
        subject: candidateRow(useFresh, rank, rank, useFresh.member.status === "insufficient_sample" ? counts.ranked + 1 : null) });
    }
    if (!previous) return null;
    const primary = db.prepare(`SELECT o.*,m.nickname,m.status,m.score,m.stats_json,o.ordinal primary_ordinal,
      o.k1 pk1,o.k2 pk2,o.k3 pk3,o.k4 pk4,o.k5 pk5,o.stable_key pstable_key
      FROM leaderboard_order o JOIN leaderboard_members m ON m.scope=o.scope AND m.generation=o.generation AND m.aid=o.aid
      WHERE o.scope=? AND o.generation=? AND o.sort='primary' AND o.aid=? AND ${eligibleSql(config, "o")}`).get(config.scope, snap.generation, aid) as OrderRow;
    const subject = primary ? rowFrom(primary, aid, bannedOrdinals(config, snap.generation, "primary"),
      bannedOrdinals(config, snap.generation, "primary"), null, null, counts.ranked + 1)
      : { aid, nickname: String(previous.nickname), position: null, primaryRank: null,
        groupStart: previous.status === "insufficient_sample" ? counts.ranked + 1 : null,
        status: previous.status, score: previous.score, stats: JSON.parse(String(previous.stats_json)), selected: true };
    return finish(snap, { meta: metadata(config, snap, "primary", counts), subject });
  }

  function readPage(config: LeaderboardScopeConfig, sort: LeaderboardSort, aid: number | null,
    topLimit: number, candidate?: MaterializedCandidate | null, now = Date.now(),
    expectedGeneration?: number, expectedGeneratedAt?: number): LeaderboardPageResponse | null {
    const snap = snapshot(config, now, expectedGeneration, expectedGeneratedAt);
    if (!snap) return null;
    if (aid != null && excluded(config, aid)) {
      const counts = liveCounts(config, snap);
      const topRows = selectedRows(config, snap.generation, sort, "1=1", [], Math.min(500, Math.max(1, topLimit)));
      const selectedBans = bannedOrdinals(config, snap.generation, sort);
      const primaryBans = sort === "primary" ? selectedBans : bannedOrdinals(config, snap.generation, "primary");
      return finish(snap, { meta: metadata(config, snap, sort, counts),
        top: topRows.map((row) => rowFrom(row, aid, selectedBans, primaryBans, null, null, counts.ranked + 1)), around: null,
        subject: { aid, nickname: "", position: null, primaryRank: null, groupStart: null,
          status: "excluded", score: null, stats: EMPTY_STATS, selected: true } });
    }
    const previous = aid == null ? null : previousMember(config, snap, aid);
    const useFresh = aid != null && candidate && (previous?.source_fingerprint !== candidate.member.sourceFingerprint ||
      Number(previous?.parser_version ?? -1) !== candidate.member.parserVersion ||
      Number(previous?.metric_version ?? -1) !== candidate.member.metricVersion) ? candidate : null;
    const counts = liveCounts(config, snap, useFresh, previous);
    const selectedBans = bannedOrdinals(config, snap.generation, sort);
    const primaryBans = sort === "primary" ? selectedBans : bannedOrdinals(config, snap.generation, "primary");
    const freshPrimaryOrder = candidateOrder(useFresh, "primary");
    const oldPrimary = aid == null ? null : db.prepare("SELECT ordinal FROM leaderboard_order WHERE scope=? AND generation=? AND sort='primary' AND aid=?")
      .get(config.scope, snap.generation, aid);
    const primaryOverlay = useFresh ? { key: freshPrimaryOrder?.key ?? null, oldOrdinal: oldPrimary ? Number(oldPrimary.ordinal) : null } : null;
    const oldSelected = aid == null ? null : db.prepare("SELECT ordinal FROM leaderboard_order WHERE scope=? AND generation=? AND sort=? AND aid=?")
      .get(config.scope, snap.generation, sort, aid);
    const freshSelected = candidateOrder(useFresh, sort);
    const selectedOverlay = useFresh ? { key: freshSelected?.key ?? null, oldOrdinal: oldSelected ? Number(oldSelected.ordinal) : null } : null;
    const requested = Math.min(500, Math.max(1, topLimit));
    const rawTop = selectedRows(config, snap.generation, sort, "1=1", [], requested + (aid == null ? 0 : 1), "ASC",
      useFresh ? aid! : undefined);
    let top = rawTop.map((row) => rowFrom(row, aid, selectedBans, primaryBans,
      primaryOverlay, selectedOverlay, counts.ranked + 1));
    let subject: LeaderboardRow | null = null;
    let around: LeaderboardRow[] | null = null;
    if (useFresh && freshSelected) {
      const position = insertionPosition(config, snap, sort, freshSelected.key, aid!, selectedBans,
        oldSelected ? Number(oldSelected.ordinal) : null);
      const primaryRank = primaryOverlay?.key ? insertionPosition(config, snap, "primary", primaryOverlay.key, aid!, primaryBans,
        primaryOverlay.oldOrdinal) : null;
      subject = candidateRow(useFresh, position, primaryRank,
        useFresh.member.status === "insufficient_sample" ? counts.ranked + 1 : null);
      top.push(subject);
      top.sort((left, right) => (left.position ?? Number.MAX_SAFE_INTEGER) - (right.position ?? Number.MAX_SAFE_INTEGER));
      top = top.slice(0, requested);
      const tuple = freshSelected.key;
      const before = db.prepare(`SELECT o.*,m.nickname,m.status,m.score,m.stats_json,p.ordinal primary_ordinal,
        p.k1 pk1,p.k2 pk2,p.k3 pk3,p.k4 pk4,p.k5 pk5,p.stable_key pstable_key
        FROM leaderboard_order o JOIN leaderboard_members m ON m.scope=o.scope AND m.generation=o.generation AND m.aid=o.aid
        LEFT JOIN leaderboard_order p ON p.scope=o.scope AND p.generation=o.generation AND p.aid=o.aid AND p.sort='primary'
        WHERE o.scope=? AND o.generation=? AND o.sort=? AND (o.k1,o.k2,o.k3,o.k4,o.k5,o.stable_key)>(?,?,?,?,?,?)
          AND o.aid<>? AND ${eligibleSql(config, "o")} ORDER BY o.k1 ASC,o.k2 ASC,o.k3 ASC,o.k4 ASC,o.k5 ASC,o.stable_key ASC LIMIT 99`)
        .all(config.scope, snap.generation, sort, ...tuple, aid) as OrderRow[];
      const after = db.prepare(`SELECT o.*,m.nickname,m.status,m.score,m.stats_json,p.ordinal primary_ordinal,
        p.k1 pk1,p.k2 pk2,p.k3 pk3,p.k4 pk4,p.k5 pk5,p.stable_key pstable_key
        FROM leaderboard_order o JOIN leaderboard_members m ON m.scope=o.scope AND m.generation=o.generation AND m.aid=o.aid
        LEFT JOIN leaderboard_order p ON p.scope=o.scope AND p.generation=o.generation AND p.aid=o.aid AND p.sort='primary'
        WHERE o.scope=? AND o.generation=? AND o.sort=? AND (o.k1,o.k2,o.k3,o.k4,o.k5,o.stable_key)<(?,?,?,?,?,?)
          AND o.aid<>? AND ${eligibleSql(config, "o")} ORDER BY o.k1 DESC,o.k2 DESC,o.k3 DESC,o.k4 DESC,o.k5 DESC,o.stable_key DESC LIMIT 99`)
        .all(config.scope, snap.generation, sort, ...tuple, aid) as OrderRow[];
      const merged = [...before.reverse().map((row) => rowFrom(row, aid, selectedBans, primaryBans,
        primaryOverlay, selectedOverlay, counts.ranked + 1)), subject,
        ...after.map((row) => rowFrom(row, aid, selectedBans, primaryBans,
          primaryOverlay, selectedOverlay, counts.ranked + 1))];
      const index = before.length;
      const start = Math.max(0, Math.min(index - 50, merged.length - 100));
      around = merged.slice(start, start + 100);
    } else if (useFresh) {
      const primaryRank = primaryOverlay?.key ? insertionPosition(config, snap, "primary", primaryOverlay.key, aid!, primaryBans,
        primaryOverlay.oldOrdinal) : null;
      subject = candidateRow(useFresh, null, primaryRank,
        useFresh.member.status === "insufficient_sample" ? counts.ranked + 1 : null);
    } else if (aid != null && previous) {
      const saved = top.find((row) => row.aid === aid) ?? (() => {
        const order = selectedRows(config, snap.generation, sort, "o.aid=?", [aid], 1)[0];
        return order ? rowFrom(order, aid, selectedBans, primaryBans, null, null, counts.ranked + 1) : null;
      })();
      const primaryOrder = db.prepare(`SELECT ordinal FROM leaderboard_order o WHERE scope=? AND generation=?
        AND sort='primary' AND aid=? AND ${eligibleSql(config, "o")}`).get(config.scope, snap.generation, aid);
      const livePrimaryRank = primaryOrder == null ? null
        : Number(primaryOrder.ordinal) - countAtOrBefore(primaryBans, Number(primaryOrder.ordinal));
      subject = saved ?? { aid, nickname: String(previous.nickname), position: null,
        primaryRank: livePrimaryRank,
        groupStart: previous.status === "insufficient_sample" ? counts.ranked + 1 : null,
        status: previous.status, score: previous.score, stats: JSON.parse(String(previous.stats_json)), selected: true };
      if (saved) {
        const before = selectedRows(config, snap.generation, sort, "o.ordinal<?", [Number((oldSelected as any).ordinal)], 99, "DESC").reverse();
        const after = selectedRows(config, snap.generation, sort, "o.ordinal>?", [Number((oldSelected as any).ordinal)], 99, "ASC");
        const merged = [...before, saved as any, ...after].map((entry: any) => "stats_json" in entry
          ? rowFrom(entry, aid, selectedBans, primaryBans, null, null, counts.ranked + 1) : entry as LeaderboardRow);
        const start = Math.max(0, Math.min(before.length - 50, merged.length - 100));
        around = merged.slice(start, start + 100);
      }
    }
    top = top.slice(0, requested);
    return finish(snap, { meta: metadata(config, snap, sort, counts), top, around, subject });
  }

  return { snapshot, readRank, readPage, excluded };
}
