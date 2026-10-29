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
const MIN_PARTY_GAMES: u32 = 8;
const MIN_DUO_GAMES: u32 = 10;

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
}
#[derive(Deserialize)]
struct Standing {
    id: String,
    mmr: f64,
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
    now: i64,
    complete: bool,
    updated_at: i64,
    start: i64,
    end: Option<i64>,
) -> Value {
    let ratings: HashMap<&str, f64> = standings.iter().map(|s| (s.id.as_str(), s.mmr)).collect();
    let mut identities = serde_json::Map::new();
    let mut records: HashMap<String, Record> = HashMap::new();
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
                if let Some(mmr) = player.mmr.filter(|v| v.is_finite()) {
                    if record.first_mmr.is_none() {
                        record.first_mmr = Some(mmr);
                    }
                    record.last_mmr = Some(mmr);
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
            let mmr = ratings.get(id.as_str()).copied().or(r.last_mmr)?;
            let score = mmr / 10.0
                + 100.0 * wilson(r.wins, r.wins + r.losses)
                + 5.0 * f64::from(r.games).ln_1p();
            score.is_finite().then_some((id.as_str(), score))
        })
        .max_by(|a, b| a.1.total_cmp(&b.1))
        .map(|(id, v)| award(id, v));
    // Two consecutive 10-game blocks must both be strong, not only the aggregate.
    let stable = records
        .iter()
        .filter(|(_, r)| r.results.len() >= 20)
        .map(|(id, r)| {
            let tail = &r.results[r.results.len() - 20..];
            let a = tail[..10].iter().filter(|v| **v).count() as f64;
            let b = tail[10..].iter().filter(|v| **v).count() as f64;
            (id.as_str(), a.min(b) * 10.0)
        })
        .max_by(|a, b| a.1.total_cmp(&b.1))
        .map(|(id, v)| award(id, v));
    let party = |min_size: usize, max_size: usize, min_games: u32| {
        parties.iter().filter(|(ids,g)|ids.len()>=min_size && ids.len()<=max_size &&g.games>=min_games)
            .max_by(|a,b| wilson(a.1.wins,a.1.games).total_cmp(&wilson(b.1.wins,b.1.games))
                .then_with(||a.1.games.cmp(&b.1.games)))
            .map(|(ids,g)|json!({"players":ids,"games":g.games,"wins":g.wins,"winRate":ratio(g.wins,g.games)*100.0}))
    };
    let best_party = party(3, 5, MIN_PARTY_GAMES);
    let best_duo = party(2, 2, MIN_DUO_GAMES);
    let win_machine =
        select(&|r| ratio(r.wins, r.wins + r.losses) * 100.0).map(|(id, v)| award(id, v));
    let veteran = records
        .iter()
        .max_by_key(|(_, r)| r.games)
        .map(|(id, r)| award(id, r.games as f64));
    let win_streak = records
        .iter()
        .max_by_key(|(_, r)| r.longest_wins)
        .filter(|(_, r)| r.longest_wins > 0)
        .map(|(id, r)| award(id, r.longest_wins as f64));
    let loss_streak = records
        .iter()
        .max_by_key(|(_, r)| r.longest_losses)
        .filter(|(_, r)| r.longest_losses > 0)
        .map(|(id, r)| award(id, r.longest_losses as f64));
    let rising = records
        .iter()
        .filter(|(_, r)| r.results.len() >= 10)
        .filter_map(|(id, r)| {
            let delta = ratings.get(id.as_str()).copied().or(r.last_mmr)? - r.first_mmr?;
            delta.is_finite().then_some((id.as_str(), delta))
        })
        .filter(|(_, v)| *v > 0.0)
        .max_by(|a, b| a.1.total_cmp(&b.1))
        .map(|(id, v)| award(id, v));
    let giant = slayers
        .iter()
        .filter(|(_, wins)| **wins > 0)
        .max_by_key(|(_, wins)| **wins)
        .map(|(id, wins)| award(id, *wins as f64));
    let nemesis = duels
        .iter()
        .max_by_key(|(_, d)| d.games)
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
    for r in records.values().filter(|r| r.wins + r.losses >= 10) {
        let rate = ratio(r.wins, r.wins + r.losses);
        distribution[((rate * 5.0) as usize).min(4)] += 1;
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
    json!({
        "available":true,"archiveComplete":complete,"updatedAt":updated_at,
        "players":identities,
        "awards":{"mvp":mvp,"consistent":stable,"party":best_party,"streak":win_streak,
            "winMachine":win_machine,"veteran":veteran,"rising":rising,"duo":best_duo,"cursed":loss_streak,
            "nemesis":nemesis,"giantSlayer":giant},
        "totals":{"players":records.len(),"matches":match_count,"averageGames":if records.is_empty(){0.0}else{appearances as f64/records.len() as f64},
            "active7d":recent_active.len(),"lineups":distinct_lineups.len(),"peakDay":peak},
        "activity":activity,"distribution":distribution,"recentForm":forms
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
    let mut result = compute(
        matches,
        &standings,
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
        let result = compute(games, &[], start + 5000, true, start + 5000, start, None);
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
}
