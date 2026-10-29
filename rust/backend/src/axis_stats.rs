//! Read-only AXIS League statistics. All aggregations live in Rust, not in Next.js.
use axum::{
    Json,
    extract::RawQuery,
    http::{HeaderValue, StatusCode},
    response::{IntoResponse, Response},
};
use chrono::{DateTime, Utc};
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    env,
    time::Duration,
};

const CHANNEL: &str = "1343726040421367842";
const MIN_GAMES: usize = 20;
const MIN_DUO_GAMES: u32 = 10;
const MIN_DISTRIBUTION_GAMES: u32 = 5;
// K/D/A stability needs enough games to separate a steady player from a lucky one.
const MIN_KDA_GAMES: usize = 10;

#[derive(Deserialize)]
struct Match {
    number: i64,
    time: Option<i64>,
    #[serde(rename = "queueId")]
    queue_id: Option<String>,
    winner: Option<isize>,
    teams: Vec<Team>,
}
#[derive(Deserialize)]
struct Team {
    players: Vec<Player>,
}
#[derive(Deserialize)]
struct Player {
    id: String,
    name: String,
    #[serde(rename = "avatarUrl")]
    avatar_url: Option<String>,
    mmr: Option<f64>,
    change: Option<f64>,
}
#[derive(Deserialize)]
struct Standing {
    id: String,
    mmr: f64,
    #[serde(default)]
    position: Option<u32>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Season {
    id: String,
    starts_at: i64,
    ends_at: Option<i64>,
}
#[derive(Default)]
struct Record {
    games: u32,
    wins: u32,
    losses: u32,
    longest_wins: u32,
    longest_losses: u32,
    win_run: u32,
    loss_run: u32,
    results: Vec<bool>,
    first_mmr: Option<f64>,
    last_mmr: Option<f64>,
}
#[derive(Default)]
struct Group {
    games: u32,
    wins: u32,
}
#[derive(Default)]
struct Duel {
    games: u32,
    wins_a: u32,
    wins_b: u32,
}
#[derive(Default)]
struct Day {
    matches: u32,
    players: HashSet<String>,
}

#[derive(Clone, Copy, Default)]
struct Kda {
    kills: u32,
    deaths: u32,
    assists: u32,
}
#[derive(Default)]
struct Combat {
    matches: u32,
    kills: u32,
    deaths: u32,
    assists: u32,
    ratios: Vec<f64>,
}
#[derive(Default)]
struct DuoCombat {
    games: u32,
    kills: u32,
    deaths: u32,
    assists: u32,
}
struct Stability {
    mean: f64,
    sd: f64,
    cv: f64,
    min: f64,
    max: f64,
    score: f64,
    in_band: f64,
}

fn current_start() -> i64 {
    DateTime::parse_from_rfc3339("2026-10-16T01:59:00+03:00")
        .expect("fixed season start")
        .timestamp_millis()
}
fn ratio(wins: u32, games: u32) -> f64 {
    if games == 0 {
        0.0
    } else {
        f64::from(wins) / f64::from(games)
    }
}
fn kda_ratio(kills: u32, deaths: u32, assists: u32) -> f64 {
    (f64::from(kills) + f64::from(assists)) / f64::from(deaths.max(1))
}
impl Combat {
    fn add(&mut self, kda: Kda) {
        self.matches += 1;
        self.kills += kda.kills;
        self.deaths += kda.deaths;
        self.assists += kda.assists;
        self.ratios
            .push(kda_ratio(kda.kills, kda.deaths, kda.assists));
    }
    fn ratio(&self) -> f64 {
        kda_ratio(self.kills, self.deaths, self.assists)
    }
    /// A player is steady when the per-match K/D/A barely moves around its own mean.
    fn stability(&self) -> Option<Stability> {
        if self.ratios.len() < MIN_KDA_GAMES {
            return None;
        }
        let count = self.ratios.len() as f64;
        let mean = self.ratios.iter().sum::<f64>() / count;
        if !mean.is_finite() || mean <= 0.0 {
            return None;
        }
        let variance = self
            .ratios
            .iter()
            .map(|value| (value - mean).powi(2))
            .sum::<f64>()
            / count;
        let sd = variance.sqrt();
        let cv = sd / mean;
        let low = mean * 0.75;
        let high = mean * 1.25;
        let in_band = self
            .ratios
            .iter()
            .filter(|value| low <= **value && **value <= high)
            .count() as f64
            / count
            * 100.0;
        Some(Stability {
            mean,
            sd,
            cv,
            min: self.ratios.iter().copied().fold(f64::INFINITY, f64::min),
            max: self
                .ratios
                .iter()
                .copied()
                .fold(f64::NEG_INFINITY, f64::max),
            score: (1.0 - cv).clamp(0.0, 1.0) * 100.0,
            in_band,
        })
    }
}
// Wilson's conservative win-rate bound rewards both performance and sample size.
fn wilson(wins: u32, games: u32) -> f64 {
    if games == 0 {
        return 0.0;
    }
    let n = f64::from(games);
    let p = ratio(wins, games);
    let z2 = 1.96_f64.powi(2);
    (p + z2 / (2.0 * n) - 1.96 * ((p * (1.0 - p) + z2 / (4.0 * n)) / n).sqrt()) / (1.0 + z2 / n)
}
fn award(id: &str, value: f64) -> Value {
    json!({"playerId":id,"value":value})
}
fn combinable(keys: &[String]) -> Vec<Vec<String>> {
    if keys.len() < 2 || keys.len() > 5 {
        return Vec::new();
    }
    let mut result = Vec::new();
    for mask in 1..(1usize << keys.len()) {
        if mask.count_ones() < 2 {
            continue;
        }
        let members = keys
            .iter()
            .enumerate()
            .filter_map(|(i, id)| (mask & (1 << i) != 0).then_some(id.clone()))
            .collect();
        result.push(members);
    }
    result
}
fn compute(
    matches: Vec<Match>,
    standings: &[Standing],
    kda_rows: &HashMap<(i64, String), Kda>,
    now: i64,
    complete: bool,
    updated_at: i64,
    start: i64,
    end: Option<i64>,
) -> Value {
    let ratings: HashMap<&str, f64> = standings.iter().map(|s| (s.id.as_str(), s.mmr)).collect();
    let positions: HashMap<&str, u32> = standings
        .iter()
        .filter_map(|s| s.position.map(|position| (s.id.as_str(), position)))
        .collect();
    let mut identities = serde_json::Map::new();
    let mut records: HashMap<String, Record> = HashMap::new();
    let mut combat: HashMap<String, Combat> = HashMap::new();
    let mut duo_combat: HashMap<Vec<String>, DuoCombat> = HashMap::new();
    let mut parties: HashMap<Vec<String>, Group> = HashMap::new();
    let mut distinct_lineups: HashSet<Vec<String>> = HashSet::new();
    let mut duels: HashMap<(String, String), Duel> = HashMap::new();
    let mut slayers: HashMap<String, u32> = HashMap::new();
    let mut days: HashMap<i64, Day> = HashMap::new();
    let mut recent_active = HashSet::new();
    let mut match_count = 0_u32;
    let mut appearances = 0_u32;
    let mut ordered = matches;
    ordered.sort_by_key(|m| m.number);
    for m in ordered {
        if m.queue_id.as_deref() != Some(CHANNEL)
            || !m
                .time
                .is_some_and(|t| t >= start && end.is_none_or(|limit| t < limit))
        {
            continue;
        }
        let Some(time) = m.time else { continue };
        if m.teams.len() != 2 || !matches!(m.winner, Some(0 | 1 | -2)) {
            continue;
        }
        let winner = m.winner.unwrap();
        if m.teams.iter().any(|t| t.players.is_empty()) {
            continue;
        }
        let all_ids: Vec<&str> = m
            .teams
            .iter()
            .flat_map(|t| t.players.iter().map(|p| p.id.as_str()))
            .collect();
        if all_ids.iter().any(|id| id.is_empty())
            || all_ids.iter().copied().collect::<HashSet<_>>().len() != all_ids.len()
        {
            continue;
        }
        match_count += 1;
        let day = (time + 3 * 3_600_000).div_euclid(86_400_000);
        let daily = days.entry(day).or_default();
        daily.matches += 1;
        for (team_index, team) in m.teams.iter().enumerate() {
            let mut lineup: Vec<String> = team.players.iter().map(|p| p.id.clone()).collect();
            lineup.sort();
            if lineup.len() >= 2 {
                distinct_lineups.insert(lineup.clone());
            }
            for player in &team.players {
                appearances += 1;
                identities.insert(
                    player.id.clone(),
                    json!({"name":player.name,"avatarUrl":player.avatar_url}),
                );
                daily.players.insert(player.id.clone());
                if time >= end.unwrap_or(now) - 7 * 86_400_000 && time <= end.unwrap_or(now) {
                    recent_active.insert(player.id.clone());
                }
                let record = records.entry(player.id.clone()).or_default();
                record.games += 1;
                if let Some(kda) = kda_rows.get(&(m.number, player.id.clone())) {
                    combat.entry(player.id.clone()).or_default().add(*kda);
                }
                if let Some(mmr) = player.mmr.filter(|v| v.is_finite()) {
                    if record.first_mmr.is_none() {
                        record.first_mmr = Some(mmr);
                    }
                    record.last_mmr = Some(mmr + player.change.unwrap_or(0.0));
                }
                match winner {
                    -2 => {
                        record.win_run = 0;
                        record.loss_run = 0;
                    }
                    n => {
                        let won = n as usize == team_index;
                        record.results.push(won);
                        if won {
                            record.wins += 1;
                            record.win_run += 1;
                            record.loss_run = 0;
                            record.longest_wins = record.longest_wins.max(record.win_run);
                        } else {
                            record.losses += 1;
                            record.loss_run += 1;
                            record.win_run = 0;
                            record.longest_losses = record.longest_losses.max(record.loss_run);
                        }
                    }
                }
            }
            // A duo can be part of a bigger stack, so pair every teammate, not just 2v2 lobbies.
            for (index, first) in lineup.iter().enumerate() {
                for second in &lineup[index + 1..] {
                    if let (Some(a), Some(b)) = (
                        kda_rows.get(&(m.number, first.clone())),
                        kda_rows.get(&(m.number, second.clone())),
                    ) {
                        let duo = duo_combat
                            .entry(vec![first.clone(), second.clone()])
                            .or_default();
                        duo.games += 1;
                        duo.kills += a.kills + b.kills;
                        duo.deaths += a.deaths + b.deaths;
                        duo.assists += a.assists + b.assists;
                    }
                }
            }
            if winner != -2 {
                for members in combinable(&lineup) {
                    let item = parties.entry(members).or_default();
                    item.games += 1;
                    if winner as usize == team_index {
                        item.wins += 1;
                    }
                }
            }
        }
        if winner != -2 {
            for a in &m.teams[0].players {
                for b in &m.teams[1].players {
                    let (first, second, a_first) = if a.id < b.id {
                        (&a.id, &b.id, true)
                    } else {
                        (&b.id, &a.id, false)
                    };
                    let duel = duels.entry((first.clone(), second.clone())).or_default();
                    duel.games += 1;
                    if (winner == 0) == a_first {
                        duel.wins_a += 1;
                    } else {
                        duel.wins_b += 1;
                    }
                }
            }
            for (i, team) in m.teams.iter().enumerate() {
                if i as isize != winner {
                    continue;
                }
                let rival = &m.teams[1 - i].players;
                let known: Vec<f64> = rival
                    .iter()
                    .filter_map(|p| p.mmr.filter(|v| v.is_finite()))
                    .collect();
                if known.len() != rival.len() {
                    continue;
                }
                let average = known.iter().sum::<f64>() / known.len() as f64;
                for p in &team.players {
                    if p.mmr
                        .is_some_and(|own| own.is_finite() && own + 100.0 <= average)
                    {
                        *slayers.entry(p.id.clone()).or_default() += 1;
                    }
                }
            }
        }
    }
    let eligible = |r: &Record| r.results.len() >= MIN_GAMES;
    let select = |f: &dyn Fn(&Record) -> f64| -> Option<(&str, f64)> {
        records
            .iter()
            .filter(|(_, r)| eligible(r))
            .map(|(id, r)| (id.as_str(), f(r)))
            .max_by(|a, b| a.1.total_cmp(&b.1).then_with(|| b.0.cmp(a.0)))
    };
    // An MVP must win consistently, play a meaningful sample, and carry a strong rating.
    let mvp = records
        .iter()
        .filter(|(_, r)| eligible(r))
        .filter_map(|(id, r)| {
            let mmr = if end.is_some() {
                r.last_mmr?
            } else {
                ratings.get(id.as_str()).copied().or(r.last_mmr)?
            };
            let score = mmr / 10.0
                + 100.0 * wilson(r.wins, r.wins + r.losses)
                + 5.0 * f64::from(r.games).ln_1p();
            score.is_finite().then_some((id.as_str(), score, r, mmr))
        })
        .max_by(|a, b| a.1.total_cmp(&b.1).then_with(|| b.0.cmp(a.0)))
        .map(|(id, value, r, mmr)| {
            json!({
                "playerId": id,
                "value": value,
                "rating": mmr,
                "rank": if end.is_none() { positions.get(id).copied() } else { None },
                "games": r.games,
                "wins": r.wins,
                "losses": r.losses,
                "longestWins": r.longest_wins,
            })
        });
    // The steadiest player keeps almost the same per-match K/D/A instead of one huge game.
    let stable = combat
        .iter()
        .filter_map(|(id, c)| c.stability().map(|stability| (id.as_str(), stability, c)))
        .min_by(|a, b| {
            a.1.cv
                .total_cmp(&b.1.cv)
                .then_with(|| b.1.mean.total_cmp(&a.1.mean))
                .then_with(|| b.2.matches.cmp(&a.2.matches))
                .then_with(|| a.0.cmp(b.0))
        })
        .map(|(id, stability, c)| {
            json!({
                "playerId": id,
                "value": stability.score,
                "basis": "kda",
                "games": c.matches,
                "meanKda": stability.mean,
                "minKda": stability.min,
                "maxKda": stability.max,
                "sd": stability.sd,
                "inBand": stability.in_band,
            })
        })
        // Archived seasons can predate K/D/A uploads; keep the old win-block award as a fallback.
        .or_else(|| {
            records
                .iter()
                .filter(|(_, r)| r.results.len() >= 20)
                .map(|(id, r)| {
                    let tail = &r.results[r.results.len() - 20..];
                    let a = tail[..10].iter().filter(|v| **v).count() as f64;
                    let b = tail[10..].iter().filter(|v| **v).count() as f64;
                    (id.as_str(), a.min(b) * 10.0)
                })
                .max_by(|a, b| a.1.total_cmp(&b.1).then_with(|| b.0.cmp(a.0)))
                .map(|(id, value)| json!({"playerId": id, "value": value, "basis": "wins"}))
        });
    let party = |min_size: usize, max_size: usize, min_games: u32| {
        parties
            .iter()
            .filter(|(ids, g)| {
                ids.len() >= min_size && ids.len() <= max_size && g.games >= min_games
            })
            .max_by(|a, b| {
                wilson(a.1.wins, a.1.games)
                    .total_cmp(&wilson(b.1.wins, b.1.games))
                    .then_with(|| a.1.games.cmp(&b.1.games))
                    .then_with(|| b.0.cmp(a.0))
            })
            .map(|(ids, g)| (ids.clone(), g.games, g.wins))
    };
    let best_duo = party(2, 2, MIN_DUO_GAMES).map(|(ids, games, wins)| {
        let duo = duo_combat.get(&ids);
        json!({
            "players": ids, "games": games, "wins": wins,
            "winRate": ratio(wins, games) * 100.0,
            "kdaGames": duo.map_or(0, |d| d.games),
            "kills": duo.map_or(0, |d| d.kills),
            "deaths": duo.map_or(0, |d| d.deaths),
            "assists": duo.map_or(0, |d| d.assists),
            "kda": duo.map(|d| kda_ratio(d.kills, d.deaths, d.assists)),
        })
    });
    let win_machine =
        select(&|r| ratio(r.wins, r.wins + r.losses) * 100.0).map(|(id, v)| award(id, v));
    let veteran = records
        .iter()
        .max_by(|a, b| a.1.games.cmp(&b.1.games).then_with(|| b.0.cmp(a.0)))
        .map(|(id, r)| award(id, r.games as f64));
    let win_streak = records
        .iter()
        .max_by(|a, b| {
            a.1.longest_wins
                .cmp(&b.1.longest_wins)
                .then_with(|| b.0.cmp(a.0))
        })
        .filter(|(_, r)| r.longest_wins > 0)
        .map(|(id, r)| {
            json!({
                "playerId": id,
                "value": r.longest_wins,
                "games": r.games,
                "wins": r.wins,
                "losses": r.losses,
                "winRate": ratio(r.wins, r.wins + r.losses) * 100.0,
            })
        });
    let loss_streak = records
        .iter()
        .max_by(|a, b| {
            a.1.longest_losses
                .cmp(&b.1.longest_losses)
                .then_with(|| b.0.cmp(a.0))
        })
        .filter(|(_, r)| r.longest_losses > 0)
        .map(|(id, r)| award(id, r.longest_losses as f64));
    let rising = records
        .iter()
        .filter(|(_, r)| r.results.len() >= 10)
        .filter_map(|(id, r)| {
            let latest = if end.is_some() {
                r.last_mmr?
            } else {
                ratings.get(id.as_str()).copied().or(r.last_mmr)?
            };
            let first = r.first_mmr?;
            let delta = latest - first;
            delta.is_finite().then_some((id.as_str(), delta, first, latest))
        })
        .filter(|(_, delta, _, _)| *delta > 0.0)
        .max_by(|a, b| a.1.total_cmp(&b.1).then_with(|| b.0.cmp(a.0)))
        .map(|(id, delta, first, latest)| json!({"playerId":id,"value":delta,"fromMmr":first,"toMmr":latest}));
    let giant = slayers
        .iter()
        .filter(|(_, wins)| **wins > 0)
        .max_by(|a, b| a.1.cmp(b.1).then_with(|| b.0.cmp(a.0)))
        .map(|(id, wins)| award(id, *wins as f64));
    let nemesis = duels
        .iter()
        .max_by(|a, b| a.1.games.cmp(&b.1.games).then_with(|| b.0.cmp(a.0)))
        .map(|((a, b), d)| json!({"players":[a,b],"games":d.games,"wins":[d.wins_a,d.wins_b]}));
    let mut forms: Vec<_> = records
        .iter()
        .filter(|(_, r)| r.results.len() >= 10)
        .map(|(id, r)| {
            let tail = &r.results[r.results.len() - 10..];
            (
                id,
                tail.iter().filter(|v| **v).count(),
                tail.iter()
                    .map(|v| if *v { "W" } else { "L" })
                    .collect::<Vec<_>>(),
            )
        })
        .collect();
    forms.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(b.0)));
    let forms: Vec<Value> = forms
        .into_iter()
        .take(5)
        .map(|(id, w, results)| json!({"playerId":id,"wins":w,"losses":10-w,"results":results}))
        .collect();
    let mut distribution = [0_u32; 5];
    let mut distribution_ratings = Vec::new();
    for (id, r) in records
        .iter()
        .filter(|(_, r)| r.wins + r.losses >= MIN_DISTRIBUTION_GAMES)
    {
        let rate = ratio(r.wins, r.wins + r.losses);
        distribution[((rate * 5.0) as usize).min(4)] += 1;
        let rating = if end.is_some() {
            r.last_mmr
        } else {
            ratings.get(id.as_str()).copied().or(r.last_mmr)
        };
        if let Some(rating) = rating.filter(|value| value.is_finite()) {
            distribution_ratings.push(rating);
        }
    }
    let mut rating_distribution = Vec::new();
    if !distribution_ratings.is_empty() {
        let minimum = distribution_ratings
            .iter()
            .copied()
            .fold(f64::INFINITY, f64::min);
        let maximum = distribution_ratings
            .iter()
            .copied()
            .fold(f64::NEG_INFINITY, f64::max);
        let step = (((maximum - minimum) / 6.0 / 250.0).ceil() * 250.0).max(250.0);
        let first = (minimum / step).floor() * step;
        let buckets = ((maximum - first) / step).floor() as usize + 1;
        let mut counts = vec![0_u32; buckets];
        for rating in distribution_ratings {
            counts[((rating - first) / step).floor() as usize] += 1;
        }
        for (index, count) in counts.into_iter().enumerate() {
            rating_distribution.push(json!({"from":first + index as f64 * step,"to":first + (index + 1) as f64 * step,"players":count}));
        }
    }
    // Include inactive calendar days, so 7D/30D means days rather than active-day samples.
    let first_day = (start + 3 * 3_600_000).div_euclid(86_400_000);
    let last_day = (end.unwrap_or(now) - 1 + 3 * 3_600_000).div_euclid(86_400_000);
    for day in first_day..=last_day {
        days.entry(day).or_default();
    }
    let mut activity: Vec<_> = days.into_iter().collect();
    activity.sort_by_key(|(day, _)| *day);
    let activity: Vec<Value> = activity
        .into_iter()
        .map(|(day, d)| {
            let date = DateTime::<Utc>::from_timestamp(day * 86_400, 0)
                .map(|t| t.format("%Y-%m-%d").to_string())
                .unwrap_or_default();
            json!({"date":date,"matches":d.matches,"players":d.players.len()})
        })
        .collect();
    let peak = activity
        .iter()
        .filter_map(|day| day["matches"].as_u64())
        .max()
        .unwrap_or(0);
    let peak_date = activity
        .iter()
        .find(|day| peak > 0 && day["matches"].as_u64() == Some(peak))
        .map(|day| day["date"].clone());
    let total_kills: u64 = combat.values().map(|c| u64::from(c.kills)).sum();
    let total_deaths: u64 = combat.values().map(|c| u64::from(c.deaths)).sum();
    let total_assists: u64 = combat.values().map(|c| u64::from(c.assists)).sum();
    let average_kda = (!combat.is_empty() && total_kills + total_assists > 0)
        .then(|| (total_kills + total_assists) as f64 / total_deaths.max(1) as f64);
    let combat_players: serde_json::Map<String, Value> = combat
        .iter()
        .map(|(id, c)| {
            let stability = c.stability();
            let kda = c.ratio();
            let record = records.get(id);
            (
                id.clone(),
                json!({
                    "matches": c.matches,
                    "games": record.map_or(0, |r| r.games),
                    "wins": record.map_or(0, |r| r.wins),
                    "losses": record.map_or(0, |r| r.losses),
                    "kills": c.kills,
                    "deaths": c.deaths,
                    "assists": c.assists,
                    "kda": kda,
                    "meanKda": stability.as_ref().map_or(kda, |s| s.mean),
                    "minKda": stability.as_ref().map_or(kda, |s| s.min),
                    "maxKda": stability.as_ref().map_or(kda, |s| s.max),
                    "sd": stability.as_ref().map_or(0.0, |s| s.sd),
                    "stability": stability.as_ref().map(|s| s.score),
                    "inBand": stability.as_ref().map(|s| s.in_band),
                    "vsAverage": average_kda.filter(|a| *a > 0.0).map(|a| kda / a),
                }),
            )
        })
        .collect();
    json!({
        "available":true,"archiveComplete":complete,"updatedAt":updated_at,
        "players":identities,
        "awards":{"mvp":mvp,"consistent":stable,"streak":win_streak,
            "winMachine":win_machine,"veteran":veteran,"rising":rising,"duo":best_duo,"cursed":loss_streak,
            "nemesis":nemesis,"giantSlayer":giant},
        "combat":{"averageKda":average_kda,"players":combat_players},
        "totals":{"players":records.len(),"matches":match_count,"averageGames":if records.is_empty(){0.0}else{appearances as f64/records.len() as f64},
            "active7d":recent_active.len(),"lineups":distinct_lineups.len(),"peakDay":peak,"peakDayDate":peak_date},
        "activity":activity,"distribution":distribution,"ratingDistribution":rating_distribution,"recentForm":forms
    })
}

fn read(now: i64, season: &str) -> Result<Value, String> {
    let path = env::var("ADMIN_ANALYTICS_SQLITE_PATH")
        .unwrap_or_else(|_| "/data/admin-analytics.db".into());
    let db = Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| e.to_string())?;
    db.busy_timeout(Duration::from_millis(1000))
        .map_err(|e| e.to_string())?;
    let status: Option<(Option<i64>, i64)> = db
        .query_row(
            "SELECT updated_at,complete FROM axis_archive_state WHERE id=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some((Some(updated_at), complete)) = status else {
        return Err("Archive unavailable".into());
    };
    let payload: Option<String> = db
        .query_row(
            "SELECT payload FROM axis_league_snapshot WHERE id=1",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .flatten();
    let standings: Vec<Standing> = payload
        .and_then(|v| serde_json::from_str(&v).ok())
        .unwrap_or_default();
    let saved: Option<String> = db
        .query_row(
            "SELECT payload FROM axis_archive_seasons WHERE id=1",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .flatten();
    let mut seasons: Vec<Season> = saved
        .and_then(|v| serde_json::from_str(&v).ok())
        .unwrap_or_default();
    if complete != 1 {
        seasons.retain(|entry| entry.id == "current");
    }
    if !seasons.iter().any(|entry| entry.id == "current") {
        seasons.push(Season {
            id: "current".into(),
            starts_at: current_start(),
            ends_at: None,
        });
    }
    let selected = seasons
        .iter()
        .find(|entry| entry.id == season)
        .ok_or("invalid_season")?;
    let (starts_at, ends_at) = (selected.starts_at, selected.ends_at);
    let mut query=db.prepare("SELECT payload FROM axis_archive_matches WHERE json_extract(payload,'$.queueId')=?1 AND json_extract(payload,'$.time')>=?2 AND (?3 IS NULL OR json_extract(payload,'$.time')<?3) ORDER BY number")
        .map_err(|e|e.to_string())?;
    let rows = query
        .query_map(rusqlite::params![CHANNEL, starts_at, ends_at], |row| {
            row.get::<_, String>(0)
        })
        .map_err(|e| e.to_string())?;
    let mut matches = Vec::new();
    for row in rows {
        let raw = row.map_err(|e| e.to_string())?;
        matches
            .push(serde_json::from_str(&raw).map_err(|e| format!("Invalid archived match: {e}"))?);
    }
    let mut kda_query = db
        .prepare(
            "SELECT k.match_number,k.discord_id,k.kills,k.deaths,k.assists
             FROM axis_match_kda k JOIN axis_archive_matches m ON m.number=k.match_number
             WHERE json_extract(m.payload,'$.queueId')=?1 AND json_extract(m.payload,'$.time')>=?2
               AND (?3 IS NULL OR json_extract(m.payload,'$.time')<?3)",
        )
        .map_err(|e| e.to_string())?;
    let kda_rows = kda_query
        .query_map(rusqlite::params![CHANNEL, starts_at, ends_at], |row| {
            Ok((
                (row.get::<_, i64>(0)?, row.get::<_, String>(1)?),
                Kda {
                    kills: row.get::<_, i64>(2)?.clamp(0, 9999) as u32,
                    deaths: row.get::<_, i64>(3)?.clamp(0, 9999) as u32,
                    assists: row.get::<_, i64>(4)?.clamp(0, 9999) as u32,
                },
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<HashMap<_, _>, _>>()
        .map_err(|e| e.to_string())?;
    let mut result = compute(
        matches,
        &standings,
        &kda_rows,
        now,
        complete == 1,
        updated_at,
        starts_at,
        ends_at,
    );
    result["season"] = json!(season);
    result["seasons"] = json!(
        seasons
            .iter()
            .map(|s| json!({"id":s.id,"startsAt":s.starts_at,"endsAt":s.ends_at}))
            .collect::<Vec<_>>()
    );
    Ok(result)
}
pub async fn get(RawQuery(raw): RawQuery) -> Response {
    let query = crate::config::query(raw.as_deref().unwrap_or(""));
    let season = query
        .get("season")
        .cloned()
        .unwrap_or_else(|| "current".into());
    let result = tokio::task::spawn_blocking(move || read(crate::now_ms(), &season)).await;
    let mut response = match result {
        Ok(Ok(value)) => (StatusCode::OK, Json(value)).into_response(),
        Ok(Err(error)) if error == "invalid_season" => (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"invalid_season"})),
        )
            .into_response(),
        Ok(Err(error)) => {
            eprintln!("AXIS statistics unavailable: {error}");
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({"error":"axis_statistics_unavailable"})),
            )
                .into_response()
        }
        Err(error) => {
            eprintln!("AXIS statistics task failed: {error}");
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({"error":"axis_statistics_unavailable"})),
            )
                .into_response()
        }
    };
    response
        .headers_mut()
        .insert("cache-control", HeaderValue::from_static("no-store"));
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    fn match_at(n: i64, winner: isize, players: (&str, &str), time: i64) -> Match {
        let team = |id: &str| Team {
            players: vec![Player {
                id: id.into(),
                name: id.into(),
                avatar_url: None,
                mmr: Some(1000.0),
                change: None,
            }],
        };
        Match {
            number: n,
            time: Some(time),
            queue_id: Some(CHANNEL.into()),
            winner: Some(winner),
            teams: vec![team(players.0), team(players.1)],
        }
    }
    #[test]
    fn statistics_use_real_results_and_ignore_unknown_outcomes() {
        let start = current_start();
        let games = vec![
            match_at(1, 0, ("a", "b"), start + 1000),
            match_at(2, 0, ("a", "b"), start + 2000),
            match_at(3, -2, ("a", "b"), start + 3000),
            match_at(4, 2, ("a", "b"), start + 4000),
        ];
        let result = compute(
            games,
            &[],
            &HashMap::new(),
            start + 5000,
            true,
            start + 5000,
            start,
            None,
        );
        assert_eq!(result["totals"]["matches"], 3);
        assert_eq!(result["totals"]["players"], 2);
        assert_eq!(result["totals"]["averageGames"], 3.0);
        assert_eq!(result["awards"]["streak"]["value"], 2.0);
        assert_eq!(result["totals"]["active7d"], 2);
        assert!(result["awards"]["mvp"].is_null());
    }
    #[test]
    fn party_subsets_and_wilson_are_conservative() {
        assert_eq!(combinable(&["a".into(), "b".into(), "c".into()]).len(), 4);
        assert!(wilson(8, 10) > wilson(1, 1));
        assert!(combinable(&["a".into()]).is_empty());
    }
    #[test]
    fn distributions_include_five_completed_games_and_skip_unknown_ratings() {
        let start = current_start();
        let mut games: Vec<_> = (0..5)
            .map(|n| match_at(n, 0, ("a", "b"), start + n * 1000))
            .collect();
        for game in &mut games {
            game.teams[1].players[0].mmr = None;
        }
        games.extend((5..9).map(|n| match_at(n, 0, ("c", "d"), start + n * 1000)));
        // A draw is recorded, but is not a completed win/loss for eligibility.
        games.push(match_at(10, -2, ("c", "d"), start + 10_000));
        let result = compute(
            games,
            &[],
            &HashMap::new(),
            start + 20_000,
            true,
            start,
            start,
            None,
        );
        assert_eq!(result["distribution"], json!([1, 0, 0, 0, 1]));
        assert_eq!(
            result["ratingDistribution"],
            json!([{"from":1000.0,"to":1250.0,"players":1}])
        );
        assert_eq!(result["totals"]["peakDay"], 10);
        assert_eq!(result["totals"]["peakDayDate"], "2026-10-16");
    }
    #[test]
    fn rating_endpoints_follow_the_selected_season() {
        let start = current_start();
        let games = || {
            (0..10)
                .map(|n| {
                    let mut game = match_at(n, 0, ("a", "b"), start + n * 1000);
                    game.teams[0].players[0].mmr = Some(850.0 + n as f64 * 5.0);
                    game.teams[0].players[0].change = Some(5.0);
                    game
                })
                .collect()
        };
        let standings = [Standing {
            id: "a".into(),
            mmr: 1200.0,
            position: Some(1),
        }];
        let current = compute(
            games(),
            &standings,
            &HashMap::new(),
            start + 20_000,
            true,
            start,
            start,
            None,
        );
        assert_eq!(
            current["awards"]["rising"],
            json!({"playerId":"a","value":350.0,"fromMmr":850.0,"toMmr":1200.0})
        );
        assert_eq!(
            current["ratingDistribution"],
            json!([{"from":1000.0,"to":1250.0,"players":2}])
        );
        let archived = compute(
            games(),
            &standings,
            &HashMap::new(),
            start + 20_000,
            true,
            start,
            start,
            Some(start + 15_000),
        );
        assert_eq!(archived["awards"]["rising"]["toMmr"], 900.0);
        assert_eq!(
            archived["ratingDistribution"],
            json!([
                {"from":750.0,"to":1000.0,"players":1}, {"from":1000.0,"to":1250.0,"players":1}
            ])
        );
    }
    #[test]
    fn tied_awards_are_repeatable() {
        let start = current_start();
        for _ in 0..24 {
            let games = (0..20)
                .map(|n| match_at(n, (n % 2) as isize, ("a", "b"), start + n * 1000))
                .collect();
            let result = compute(
                games,
                &[],
                &HashMap::new(),
                start + 30_000,
                true,
                start,
                start,
                None,
            );
            for name in [
                "mvp",
                "consistent",
                "streak",
                "veteran",
                "cursed",
                "winMachine",
            ] {
                assert_eq!(result["awards"][name]["playerId"], "a", "{name}");
            }
        }
    }
    #[test]
    fn empty_season_has_no_rating_buckets_or_peak_date() {
        let start = current_start();
        let result = compute(
            Vec::new(),
            &[],
            &HashMap::new(),
            start + 30_000,
            true,
            start,
            start,
            None,
        );
        assert_eq!(result["ratingDistribution"], json!([]));
        assert!(result["totals"]["peakDayDate"].is_null());
    }
    #[test]
    fn party_and_rivalry_awards_require_repeated_real_matches() {
        let start = current_start();
        let team = |ids: &[&str], rating: f64| Team {
            players: ids
                .iter()
                .map(|id| Player {
                    id: (*id).into(),
                    name: (*id).into(),
                    avatar_url: None,
                    mmr: Some(rating),
                    change: None,
                })
                .collect(),
        };
        let games = (0..12)
            .map(|index| Match {
                number: index + 1,
                time: Some(start + index * 1000),
                queue_id: Some(CHANNEL.into()),
                winner: Some(if index < 9 { 0 } else { 1 }),
                teams: vec![
                    team(&["a", "b", "c"], 900.0),
                    team(&["x", "y", "z"], 1100.0),
                ],
            })
            .collect();
        let result = compute(
            games,
            &[],
            &HashMap::new(),
            start + 15_000,
            true,
            start,
            start,
            None,
        );
        assert_eq!(result["totals"]["matches"], 12);
        assert_eq!(result["totals"]["lineups"], 2);
        assert_eq!(result["awards"]["duo"]["games"], 12);
        assert_eq!(result["awards"]["duo"]["winRate"], 75.0);
        assert_eq!(result["awards"]["nemesis"]["games"], 12);
        assert_eq!(result["awards"]["giantSlayer"]["value"], 9.0);
    }
    #[test]
    fn steadiest_player_is_chosen_by_kda_spread() {
        let start = current_start();
        let games: Vec<_> = (1..=12)
            .map(|n| match_at(n, 0, ("a", "b"), start + n * 1000))
            .collect();
        let mut kda = HashMap::new();
        for n in 1..=12 {
            kda.insert(
                (n, "a".to_string()),
                Kda {
                    kills: 4,
                    deaths: 2,
                    assists: 0,
                },
            );
            let (kills, deaths) = if n % 2 == 0 { (9, 1) } else { (1, 9) };
            kda.insert(
                (n, "b".to_string()),
                Kda {
                    kills,
                    deaths,
                    assists: 0,
                },
            );
        }
        let result = compute(games, &[], &kda, start + 30_000, true, start, start, None);
        assert_eq!(result["awards"]["consistent"]["playerId"], "a");
        assert_eq!(result["awards"]["consistent"]["basis"], "kda");
        assert_eq!(result["awards"]["consistent"]["value"], 100.0);
        assert_eq!(result["combat"]["players"]["a"]["kills"], 48);
        assert_eq!(result["combat"]["players"]["a"]["deaths"], 24);
        assert_eq!(result["combat"]["players"]["a"]["kda"], 2.0);
        assert_eq!(result["combat"]["players"]["a"]["minKda"], 2.0);
        assert_eq!(result["combat"]["players"]["a"]["maxKda"], 2.0);
        assert_eq!(result["combat"]["players"]["a"]["stability"], 100.0);
        let average = result["combat"]["averageKda"].as_f64().unwrap();
        assert!((average - 108.0 / 84.0).abs() < 1e-9);
        let versus = result["combat"]["players"]["a"]["vsAverage"]
            .as_f64()
            .unwrap();
        assert!((versus - 2.0 / (108.0 / 84.0)).abs() < 1e-9);
    }
}
