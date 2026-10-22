import type { AxisMatch } from "./axis-history";

export const AXIS_PREDICTION_VERSION = 1;
export interface AxisWinProbability { a: number; b: number }

// Priors are deliberately modest; regularized online logistic regression learns their
// usefulness from earlier games only. MMR uses the usual 400-point Elo scale.
const PRIORS = [Math.LN10, 1, .6, .3, .2, .5, .6, .2, .7, .4, .4, .3, .4, .3, 0];
const DAY = 86_400_000;
const clamp = (n: number, lo = -2, hi = 2) => Math.max(lo, Math.min(hi, n));
const sigmoid = (n: number) => 1 / (1 + Math.exp(-clamp(n, -12, 12)));
const mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
const dot = (a: number[], b: number[]) => a.reduce((sum, value, i) => sum + value * b[i], 0);

interface Evidence { n: number; value: number; at: number }
interface Player {
  rating: number | null;
  result: Evidence; form: Evidence; combat: Evidence; recentCombat: Evidence; rounds: Evidence;
  maps: Map<string, Evidence>; mapCombat: Map<string, Evidence>;
}
function evidence(): Evidence { return { n: 0, value: 0, at: 0 }; }
function decay(stat: Evidence, time: number, halfLife = 45): number {
  return stat.at ? 2 ** (-Math.max(0, time - stat.at) / (halfLife * DAY)) : 1;
}
function value(stat: Evidence | undefined, time: number, prior: number, halfLife = 45): number {
  if (!stat) return 0;
  const weight = decay(stat, time, halfLife);
  return stat.value * weight / (prior + stat.n * weight);
}
function add(stat: Evidence, time: number, result: number, halfLife = 45) {
  const weight = decay(stat, time, halfLife);
  stat.n = stat.n * weight + 1;
  stat.value = stat.value * weight + result;
  stat.at = time;
}
function entry(map: Map<string, Evidence>, key: string) {
  let stat = map.get(key);
  if (!stat) { stat = evidence(); map.set(key, stat); }
  return stat;
}
function groups(ids: string[], size: number): string[] {
  const result: string[] = [];
  function choose(start: number, chosen: string[]) {
    if (chosen.length === size) { result.push(chosen.join(":")); return; }
    for (let i = start; i <= ids.length - size + chosen.length; i++) choose(i + 1, [...chosen, ids[i]]);
  }
  choose(0, []);
  return result;
}
function roster(match: AxisMatch): boolean {
  if (match.teams.length !== 2 || !match.teams[0].players.length
    || match.teams[0].players.length !== match.teams[1].players.length || match.teams[0].players.length > 10) return false;
  const ids = match.teams.flatMap(team => team.players.map(player => player.id));
  return ids.every(id => /^\d{1,20}$/.test(id)) && new Set(ids).size === ids.length;
}

/** A two-outcome estimate: A/B probabilities are conditional on a decisive result.
 * Draws contribute combat evidence but do not train win/loss coefficients.
 * The target's winner, MMR change, KDA and rounds are NEVER prediction inputs.
 */
export function buildAxisWinProbabilities(matches: readonly AxisMatch[]): Map<number, AxisWinProbability> {
  const predictions = new Map<number, AxisWinProbability>();
  const queues = new Map<string, ReturnType<typeof createModel>>();
  const ordered = [...matches].sort((a, b) => (a.time ?? Infinity) - (b.time ?? Infinity) || a.number - b.number);
  // Matches sharing a timestamp are predicted together before observing any result.
  for (let start = 0; start < ordered.length;) {
    let end = start + 1;
    while (end < ordered.length && ordered[end].time === ordered[start].time) end++;
    const batch: (() => void)[] = [];
    for (let i = start; i < end; i++) {
      const match = ordered[i];
      if (!roster(match)) continue;
      const key = match.queueId ?? `unknown:${match.queue ?? ""}`;
      let model = queues.get(key);
      if (!model) { model = createModel(); queues.set(key, model); }
      const result = model.predict(match);
      predictions.set(match.number, result.probability);
      if (match.time != null && Number.isFinite(match.time)) batch.push(result.observe);
    }
    for (const observe of batch) observe();
    start = end;
  }
  return predictions;
}

function createModel() {
  const players = new Map<string, Player>();
  const pairs = new Map<string, Evidence>(), trios = new Map<string, Evidence>(), lineups = new Map<string, Evidence>();
  const mapPairs = new Map<string, Evidence>(), opponents = new Map<string, Evidence>(), meetings = new Map<string, Evidence>();
  const weights = [...PRIORS];
  let games = 0, calibration = 1;
  function player(id: string): Player {
    let p = players.get(id);
    if (!p) {
      p = { rating: null, result: evidence(), form: evidence(), combat: evidence(), recentCombat: evidence(), rounds: evidence(), maps: new Map(), mapCombat: new Map() };
      players.set(id, p);
    }
    return p;
  }
  return { predict(match: AxisMatch) {
    const time = match.time ?? 0;
    const maps = [...new Set(match.maps.map(name => name.trim().toLowerCase()).filter(Boolean))];
    const ids = match.teams.map(team => team.players.map(p => p.id).sort());
    const teamPairs = ids.map(team => groups(team, 2)), teamTrios = ids.map(team => groups(team, 3));
    const teamKeys = ids.map(team => team.join(":"));
    const matchup = [...teamKeys].sort().join("|");
    const direction = teamKeys[0] < teamKeys[1] ? 1 : -1;
    const hasHistory = match.time != null && Number.isFinite(match.time);
    const ratings = match.teams.map(team => team.players.map(p => Number.isFinite(p.mmr) ? p.mmr! : hasHistory ? player(p.id).rating ?? 1000 : 1000));
    const rating = (mean(ratings[0]) - mean(ratings[1])) / 400;
    const teamFeatures = match.teams.map((team, index) => {
      const members = team.players.map(p => player(p.id));
      const stat = (key: "result" | "form" | "combat" | "recentCombat" | "rounds", prior: number, halfLife = 45) =>
        mean(members.map(p => value(p[key], time, prior, halfLife)));
      return [
        0, stat("result", 20) * 2, stat("form", 6, 7) * 2,
        stat("combat", 10), stat("recentCombat", 5, 7), stat("rounds", 10) * 2,
        mean(members.map(p => mean(maps.map(map => value(p.maps.get(map), time, 10))))) * 2,
        mean(members.map(p => mean(maps.map(map => value(p.mapCombat.get(map), time, 8))))),
        mean(teamPairs[index].map(key => value(pairs.get(key), time, 10))) * 2,
        mean(teamTrios[index].map(key => value(trios.get(key), time, 12))) * 2,
        value(lineups.get(teamKeys[index]), time, 12) * 2,
        mean(teamPairs[index].map(key => mean(maps.map(map => value(mapPairs.get(`${map}|${key}`), time, 8))))) * 2,
        0, 0, Math.min(...ratings[index]) / 400,
      ];
    });
    const features = teamFeatures[0].map((v, i) => clamp(v - teamFeatures[1][i]));
    features[0] = clamp(rating);
    features[12] = mean(ids[0].flatMap(a => ids[1].map(b => {
      const key = [a, b].sort().join(":");
      return value(opponents.get(key), time, 10) * (a < b ? 1 : -1);
    }))) * 2;
    features[13] = value(meetings.get(matchup), time, 10) * direction * 2;
    if (!hasHistory) features.fill(0, 1); // No safe temporal cutoff: use pre-match MMR only.
    const logit = dot(features, weights);
    // Shrink extremes. The temperature is fitted prequentially, never on the target result.
    const a = Math.round(clamp(sigmoid(logit * calibration), .05, .95) * 1000) / 1000;
    // Personal strength + map form explain the baseline; synergy learns excess results,
    // rather than rewarding a pair simply because its members were already stronger.
    const individual = sigmoid(dot(features.map((v, i) => i >= 8 && i <= 13 ? 0 : v), weights));
    return { probability: { a, b: Math.round((1 - a) * 1000) / 1000 }, observe() {
      if (match.winner !== 0 && match.winner !== 1 && match.winner !== -2) return;
      const outcome = match.winner === -2 ? .5 : match.winner === 0 ? 1 : 0;
      const expected = sigmoid(Math.LN10 * features[0]);
      const residual = outcome - expected;
      const jointResidual = outcome - individual;
      match.teams.forEach((team, index) => {
        const sign = index === 0 ? 1 : -1;
        for (const member of team.players) {
          const p = player(member.id);
          if (Number.isFinite(member.mmr)) p.rating = member.mmr! + (Number.isFinite(member.change) ? member.change! : 0);
          if (match.winner !== -2) {
            add(p.result, time, residual * sign);
            // Besides wall-clock decay, forget a little on each appearance.
            p.form.n *= .9; p.form.value *= .9;
            add(p.form, time, residual * sign, 7);
            for (const map of maps) add(entry(p.maps, map), time, residual * sign);
          }
          if (member.kda) {
            const { kills, deaths, assists } = member.kda;
            if ([kills, deaths, assists].every(n => Number.isFinite(n) && n >= 0)) {
              // Bounded per-match contribution; long games and zero deaths cannot dominate.
              const combat = clamp(Math.log((kills + .5 * assists + 5) / (deaths + 5)), -1.5, 1.5);
              add(p.combat, time, combat);
              p.recentCombat.n *= .9; p.recentCombat.value *= .9;
              add(p.recentCombat, time, combat, 7);
              for (const map of maps) add(entry(p.mapCombat, map), time, combat);
            }
          }
          if (match.rounds && match.rounds.a + match.rounds.b > 0) {
            add(p.rounds, time, (match.rounds.a / (match.rounds.a + match.rounds.b) - expected) * sign);
          }
        }
        if (match.winner !== -2) {
          for (const key of teamPairs[index]) {
            add(entry(pairs, key), time, jointResidual * sign);
            for (const map of maps) add(entry(mapPairs, `${map}|${key}`), time, jointResidual * sign);
          }
          for (const key of teamTrios[index]) add(entry(trios, key), time, jointResidual * sign);
          add(entry(lineups, teamKeys[index]), time, jointResidual * sign);
        }
      });
      if (match.winner === -2) return;
      for (const left of ids[0]) for (const right of ids[1]) {
        add(entry(opponents, [left, right].sort().join(":")), time, jointResidual * (left < right ? 1 : -1));
      }
      add(entry(meetings, matchup), time, jointResidual * direction);
      // No intercept: exchanging A/B must always complement the prediction.
      const rate = .04 / Math.sqrt(1 + games / 200);
      const error = outcome - sigmoid(logit);
      for (let i = 0; i < weights.length; i++) weights[i] = clamp(weights[i] + rate * (error * features[i] - .02 * (weights[i] - PRIORS[i])), i === 0 ? 0 : -2, 4);
      calibration = clamp(calibration + .01 * ((outcome - sigmoid(logit * calibration)) * logit - .02 * (calibration - 1)), .35, 1.5);
      games++;
    } };
  } };
}
