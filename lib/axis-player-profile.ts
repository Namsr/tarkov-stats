import type { AxisPlayer, AxisProfile, AxisSort } from "./axis-league";
import type { AxisHistoryResponse, AxisMatch, AxisMatchPlayer } from "./axis-history";
import type { AxisKda } from "./axis-kda";

export interface AxisIdentity {
  id: string;
  name: string;
  avatarUrl: string | null;
  profile: AxisProfile;
}
export interface AxisRecord {
  games: number; wins: number; losses: number; draws: number; winrate: number | null;
}
export interface AxisPeer extends AxisRecord {
  id: string; name: string; avatarUrl: string | null; profile: AxisProfile | null;
}
export interface AxisPersonalMatch {
  number: number; time: number | null; won: boolean | null; kda: AxisKda | null;
}
export interface AxisPlayerSummary {
  identity: AxisIdentity;
  stats: Omit<AxisRecord, "draws"> & { position: number | null; mmr: number | null; peakMmr: number | null; streak: number; peakStreak: number | null };
  averages: Partial<Record<AxisSort, number | null>>;
  combat: (AxisKda & { matches: number }) | null;
  recent: AxisPersonalMatch[];
  averageKda: number | null;
  averageRecentKda: number | null;
  archivedGames: number;
  teammates: AxisPeer[];
  opponents: AxisPeer[];
  highlights: { teammate: AxisPeer | null; opponent: AxisPeer | null; ally: { with: AxisPeer; against: AxisPeer } | null };
  maps: (AxisRecord & { name: string })[];
}
export interface AxisPlayerProfileResponse extends AxisPlayerSummary {
  aid: number;
  season: string;
  history: AxisHistoryResponse;
  updatedAt: number | null;
  stale: boolean;
}
export const AXIS_PEER_MIN_MATCHES = 10;
export const AXIS_PLAYER_PAGE_SIZE = 10;

export function axisPlayerHref(profile: AxisProfile): string {
  return `/player/arena/${profile.aid}?arenaMode=axis`;
}
export function axisPlayerResult(match: AxisMatch, id: string): "win" | "loss" | "draw" | "cancelled" | "pending" {
  if (match.winner === -1) return "cancelled";
  if (match.winner === -2) return "draw";
  if (match.winner == null || !match.teams[match.winner]) return "pending";
  return match.teams[match.winner].players.some(player => player.id === id) ? "win" : "loss";
}
function emptyRecord(): AxisRecord { return { games: 0, wins: 0, losses: 0, draws: 0, winrate: null }; }
function add(record: AxisRecord, result: "win" | "loss" | "draw") {
  record.games++;
  if (result === "win") record.wins++;
  else if (result === "loss") record.losses++;
  else record.draws++;
  record.winrate = record.wins + record.losses ? record.wins / (record.wins + record.losses) : null;
}
export function axisLeagueAverages(players: AxisPlayer[]): AxisPlayerSummary["averages"] {
  const active = players.filter(player => player.games > 0);
  return Object.fromEntries((["mmr", "peakMmr", "games", "wins", "losses", "winrate", "streak", "peakStreak"] as const).map(key => {
    const values = active.map(player => player[key]).filter((n): n is number => n != null && Number.isFinite(n));
    return [key, values.length ? values.reduce((sum, n) => sum + n, 0) / values.length : null];
  }));
}

/** Newest first; cancelled/pending games stay in history but cannot become wins or zero K/D/A. */
export function buildAxisPlayerSummary(identity: AxisIdentity, matches: AxisMatch[], players: AxisPlayer[], current: boolean,
  averages: AxisPlayerSummary["averages"], averageKda: number | null): AxisPlayerSummary {
  const league = new Map(players.map(player => [player.id, player]));
  const teammates = new Map<string, AxisPeer>(), opponents = new Map<string, AxisPeer>();
  const maps = new Map<string, AxisRecord & { name: string }>();
  const record = emptyRecord(), recent: AxisPersonalMatch[] = [];
  const combat = { kills: 0, deaths: 0, assists: 0, matches: 0 };
  const outcomes: boolean[] = [];
  let peakMmr: number | null = null, mmr: number | null = null;
  for (const match of matches) {
    const ownTeam = match.teams.findIndex(team => team.players.some(player => player.id === identity.id));
    if (ownTeam < 0) continue;
    const own = match.teams[ownTeam].players.find(player => player.id === identity.id)!;
    const result = axisPlayerResult(match, identity.id);
    if (result === "cancelled" || result === "pending") continue;
    add(record, result);
    if (own.mmr != null) {
      const after = own.mmr + (own.change ?? 0);
      mmr ??= after;
      peakMmr = Math.max(peakMmr ?? -Infinity, own.mmr, after);
    }
    if (result !== "draw") outcomes.push(result === "win");
    if (own.kda) {
      combat.kills += own.kda.kills; combat.deaths += own.kda.deaths; combat.assists += own.kda.assists; combat.matches++;
    }
    if (recent.length < 10) recent.push({ number: match.number, time: match.time, won: result === "draw" ? null : result === "win", kda: own.kda ?? null });
    const seen = new Set([identity.id]);
    match.teams.forEach((team, index) => team.players.forEach(player => {
      if (seen.has(player.id)) return;
      seen.add(player.id);
      const peers = index === ownTeam ? teammates : opponents;
      let peer = peers.get(player.id);
      if (!peer) {
        const latest: AxisMatchPlayer | AxisPlayer = league.get(player.id) ?? player;
        peer = { ...emptyRecord(), id: player.id, name: latest.name, avatarUrl: latest.avatarUrl ?? null, profile: player.profile ?? latest.profile };
        peers.set(player.id, peer);
      }
      add(peer, result);
    }));
    // A multi-map match has one result: keep the combination instead of inventing per-map wins.
    const name = [...new Set(match.maps)].join(" / ");
    if (name) { if (!maps.has(name)) maps.set(name, { ...emptyRecord(), name }); add(maps.get(name)!, result); }
  }
  let peakStreak = 0, run = 0;
  for (const won of [...outcomes].reverse()) { run = won ? run + 1 : 0; peakStreak = Math.max(peakStreak, run); }
  const first = outcomes[0];
  const boundary = outcomes.findIndex(won => won !== first);
  const streak = outcomes.length ? (boundary < 0 ? outcomes.length : boundary) * (first ? 1 : -1) : 0;
  const byGames = (a: AxisPeer, b: AxisPeer) => b.games - a.games || a.id.localeCompare(b.id);
  const eligible = (peer: AxisPeer) => peer.wins + peer.losses >= AXIS_PEER_MIN_MATCHES;
  const withPlayers = [...teammates.values()].sort(byGames), againstPlayers = [...opponents.values()].sort(byGames);
  const teammate = withPlayers.filter(eligible).sort((a, b) => b.winrate! - a.winrate! || b.wins - a.wins || byGames(a, b))[0] ?? null;
  const opponent = againstPlayers.filter(eligible).sort((a, b) => a.winrate! - b.winrate! || b.losses - a.losses || byGames(a, b))[0] ?? null;
  const ally = withPlayers.filter(eligible).flatMap(peer => {
    const enemy = opponents.get(peer.id);
    return enemy && eligible(enemy) && peer.winrate! > enemy.winrate! ? [{ with: peer, against: enemy }] : [];
  }).sort((a, b) => (b.with.winrate! - b.against.winrate!) - (a.with.winrate! - a.against.winrate!) || byGames(a.with, b.with))[0] ?? null;
  const standing = current ? league.get(identity.id) : null;
  return {
    identity, stats: standing ? { position: standing.position, mmr: standing.mmr, peakMmr: standing.peakMmr, games: standing.games,
      wins: standing.wins, losses: standing.losses, winrate: standing.winrate, streak: standing.streak, peakStreak: standing.peakStreak }
      : { ...record, position: null, mmr, peakMmr, streak, peakStreak },
    averages, combat: combat.matches ? combat : null, recent, averageKda, averageRecentKda: null, archivedGames: record.games,
    teammates: withPlayers.slice(0, 50), opponents: againstPlayers.slice(0, 50), highlights: { teammate, opponent, ally },
    maps: [...maps.values()].sort((a, b) => b.games - a.games || a.name.localeCompare(b.name)),
  };
}
