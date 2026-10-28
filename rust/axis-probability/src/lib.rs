use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::error::Error;
use std::fmt;

pub const AXIS_PREDICTION_VERSION: u32 = 3;
const PRIORS: [f64; 16] = [
    std::f64::consts::LN_10,
    1.,
    0.6,
    0.3,
    0.2,
    0.5,
    0.6,
    0.2,
    0.7,
    0.4,
    0.4,
    0.3,
    0.4,
    0.3,
    0.,
    0.,
];
const DAY: f64 = 86_400_000.;
fn clamp(n: f64, lo: f64, hi: f64) -> f64 {
    if n.is_nan() { n } else { n.max(lo).min(hi) }
}
fn sigmoid(n: f64) -> f64 {
    1. / (1. + (-clamp(n, -12., 12.)).exp())
}
fn mean(v: &[f64]) -> f64 {
    if v.is_empty() {
        0.
    } else {
        v.iter().sum::<f64>() / v.len() as f64
    }
}
fn dot(a: &[f64], b: &[f64]) -> f64 {
    a.iter().zip(b).fold(0., |s, (x, y)| s + x * y)
}

#[derive(Debug, Clone, Deserialize)]
pub struct AxisMatch {
    pub number: f64,
    #[serde(default)]
    pub time: Option<f64>,
    #[serde(default, rename = "queueId")]
    pub queue_id: Option<String>,
    #[serde(default)]
    pub queue: Option<String>,
    pub maps: Vec<String>,
    pub teams: Vec<Team>,
    #[serde(default)]
    pub winner: Option<f64>,
    #[serde(default)]
    pub rounds: Option<Rounds>,
}
#[derive(Debug, Clone, Deserialize)]
pub struct Team {
    pub players: Vec<Member>,
}
#[derive(Debug, Clone, Deserialize)]
pub struct Member {
    pub id: String,
    #[serde(default)]
    pub mmr: Option<f64>,
    #[serde(default)]
    pub change: Option<f64>,
    #[serde(default)]
    pub kda: Option<Kda>,
}
#[derive(Debug, Clone, Deserialize)]
pub struct Kda {
    pub kills: f64,
    pub deaths: f64,
    pub assists: f64,
}
#[derive(Debug, Clone, Deserialize)]
pub struct Rounds {
    pub a: f64,
    pub b: f64,
}
#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
pub struct AxisWinProbability {
    pub a: f64,
    pub b: f64,
}

#[derive(Debug, Clone)]
pub struct CalibrationError(&'static str);
impl fmt::Display for CalibrationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.0)
    }
}
impl Error for CalibrationError {}
pub struct AxisProbabilityCalibration {
    samples: VecDeque<(f64, f64)>,
    observed: usize,
    scale: f64,
}
impl Default for AxisProbabilityCalibration {
    fn default() -> Self {
        Self::new()
    }
}
impl AxisProbabilityCalibration {
    pub fn new() -> Self {
        Self {
            samples: VecDeque::new(),
            observed: 0,
            scale: 1.,
        }
    }
    pub fn probability(&self, logit: f64) -> Result<f64, CalibrationError> {
        if !logit.is_finite() {
            return Err(CalibrationError("Invalid Axis calibration score"));
        }
        let support = self.observed as f64 / (self.observed as f64 + 20.);
        Ok(clamp(
            sigmoid(clamp(logit, -12., 12.) * self.scale * support),
            0.05,
            0.95,
        ))
    }
    pub fn observe(&mut self, logit: f64, outcome: f64) -> Result<(), CalibrationError> {
        if !logit.is_finite() || (outcome != 0. && outcome != 1.) {
            return Err(CalibrationError("Invalid Axis calibration observation"));
        }
        self.samples.push_back((clamp(logit, -12., 12.), outcome));
        if self.samples.len() > 1000 {
            self.samples.pop_front();
        }
        self.observed += 1;
        if self.observed >= 100 && self.observed.is_multiple_of(25) {
            let (mut lo, mut hi) = (0., 5.);
            for _ in 0..24 {
                let candidate = (lo + hi) / 2.;
                let mut gradient = 5. * (candidate - 1.);
                for (logit, outcome) in &self.samples {
                    gradient += logit * (sigmoid(candidate * logit) - outcome);
                }
                if gradient > 0. {
                    hi = candidate;
                } else {
                    lo = candidate;
                }
            }
            self.scale = (lo + hi) / 2.;
        }
        Ok(())
    }
}

#[derive(Default, Clone)]
struct Evidence {
    n: f64,
    value: f64,
    at: f64,
}
impl Evidence {
    fn decay(&self, time: f64, half_life: f64) -> f64 {
        if self.at != 0. {
            2_f64.powf(-(time - self.at).max(0.) / (half_life * DAY))
        } else {
            1.
        }
    }
    fn value(&self, time: f64, prior: f64, half_life: f64) -> f64 {
        let w = self.decay(time, half_life);
        self.value * w / (prior + self.n * w)
    }
    fn add(&mut self, time: f64, result: f64, half_life: f64) {
        let w = self.decay(time, half_life);
        self.n = self.n * w + 1.;
        self.value = self.value * w + result;
        self.at = time;
    }
}
fn value(e: Option<&Evidence>, time: f64, prior: f64, half: f64) -> f64 {
    e.map_or(0., |e| e.value(time, prior, half))
}
#[derive(Default)]
struct Player {
    rating: Option<f64>,
    peak_mmr: Option<f64>,
    result: Evidence,
    form: Evidence,
    combat: Evidence,
    recent_combat: Evidence,
    rounds: Evidence,
    maps: HashMap<String, Evidence>,
    map_combat: HashMap<String, Evidence>,
}
fn groups(ids: &[String], size: usize) -> Vec<String> {
    fn choose(
        ids: &[String],
        size: usize,
        start: usize,
        chosen: &mut Vec<String>,
        out: &mut Vec<String>,
    ) {
        if chosen.len() == size {
            out.push(chosen.join(":"));
            return;
        }
        let needed = size - chosen.len();
        if ids.len() < needed {
            return;
        }
        for i in start..=ids.len().saturating_sub(needed) {
            chosen.push(ids[i].clone());
            choose(ids, size, i + 1, chosen, out);
            chosen.pop();
        }
    }
    let mut out = Vec::new();
    choose(ids, size, 0, &mut Vec::new(), &mut out);
    out
}
fn roster(m: &AxisMatch) -> bool {
    if m.teams.len() != 2
        || m.teams[0].players.is_empty()
        || m.teams[0].players.len() != m.teams[1].players.len()
        || m.teams[0].players.len() > 10
    {
        return false;
    }
    let mut seen = HashSet::new();
    m.teams.iter().flat_map(|t| &t.players).all(|p| {
        !p.id.is_empty()
            && p.id.len() <= 20
            && p.id.bytes().all(|b| b.is_ascii_digit())
            && seen.insert(&p.id)
    })
}
struct Model {
    players: HashMap<String, Player>,
    pairs: HashMap<String, Evidence>,
    trios: HashMap<String, Evidence>,
    lineups: HashMap<String, Evidence>,
    map_pairs: HashMap<String, Evidence>,
    opponents: HashMap<String, Evidence>,
    meetings: HashMap<String, Evidence>,
    weights: [f64; 16],
    games: usize,
    calibration: AxisProbabilityCalibration,
}
struct Pending<'a> {
    m: &'a AxisMatch,
    maps: Vec<String>,
    ids: Vec<Vec<String>>,
    pairs: Vec<Vec<String>>,
    trios: Vec<Vec<String>>,
    keys: Vec<String>,
    matchup: String,
    direction: f64,
    features: Vec<f64>,
    logit: f64,
    individual: f64,
}
impl Default for Model {
    fn default() -> Self {
        Self {
            players: HashMap::new(),
            pairs: HashMap::new(),
            trios: HashMap::new(),
            lineups: HashMap::new(),
            map_pairs: HashMap::new(),
            opponents: HashMap::new(),
            meetings: HashMap::new(),
            weights: PRIORS,
            games: 0,
            calibration: AxisProbabilityCalibration::new(),
        }
    }
}
impl Model {
    fn predict<'a>(
        &mut self,
        m: &'a AxisMatch,
    ) -> Result<(AxisWinProbability, Pending<'a>), CalibrationError> {
        let time = m.time.unwrap();
        let mut seen = HashSet::new();
        let maps: Vec<String> = m
            .maps
            .iter()
            .map(|s| {
                s.trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}')
                    .to_lowercase()
            })
            .filter(|s| !s.is_empty() && seen.insert(s.clone()))
            .collect();
        let ids: Vec<Vec<String>> = m
            .teams
            .iter()
            .map(|t| {
                let mut v: Vec<_> = t.players.iter().map(|p| p.id.clone()).collect();
                v.sort();
                v
            })
            .collect();
        let pairs: Vec<_> = ids.iter().map(|t| groups(t, 2)).collect();
        let trios: Vec<_> = ids.iter().map(|t| groups(t, 3)).collect();
        let keys: Vec<_> = ids.iter().map(|t| t.join(":")).collect();
        let mut sorted_keys = keys.clone();
        sorted_keys.sort();
        let matchup = sorted_keys.join("|");
        let direction = if keys[0] < keys[1] { 1. } else { -1. };
        let ratings: Vec<Vec<f64>> = m
            .teams
            .iter()
            .map(|t| {
                t.players
                    .iter()
                    .map(|p| {
                        p.mmr.filter(|n| n.is_finite()).unwrap_or_else(|| {
                            self.players
                                .entry(p.id.clone())
                                .or_default()
                                .rating
                                .unwrap_or(1000.)
                        })
                    })
                    .collect()
            })
            .collect();
        for p in m.teams.iter().flat_map(|t| &t.players) {
            self.players.entry(p.id.clone()).or_default();
        }
        let rating = (mean(&ratings[0]) - mean(&ratings[1])) / 400.;
        let team_features: Vec<Vec<f64>> = m.teams.iter().enumerate().map(|(index, team)| {
            let members: Vec<&Player> = team.players.iter().map(|p| &self.players[&p.id]).collect();
            let stat = |get: fn(&Player) -> &Evidence, prior, half| mean(&members.iter().map(|p| get(p).value(time, prior, half)).collect::<Vec<_>>());
            let player_maps = |get: fn(&Player) -> &HashMap<String, Evidence>, prior| mean(&members.iter().map(|p| mean(&maps.iter().map(|map| value(get(p).get(map), time, prior, 45.)).collect::<Vec<_>>())).collect::<Vec<_>>());
            vec![0., stat(|p| &p.result, 20., 45.) * 2., stat(|p| &p.form, 6., 7.) * 2., stat(|p| &p.combat, 10., 45.), stat(|p| &p.recent_combat, 5., 7.), stat(|p| &p.rounds, 10., 45.) * 2.,
                player_maps(|p| &p.maps, 10.) * 2., player_maps(|p| &p.map_combat, 8.),
                mean(&pairs[index].iter().map(|k| value(self.pairs.get(k), time, 10., 45.)).collect::<Vec<_>>()) * 2.,
                mean(&trios[index].iter().map(|k| value(self.trios.get(k), time, 12., 45.)).collect::<Vec<_>>()) * 2.,
                value(self.lineups.get(&keys[index]), time, 12., 45.) * 2.,
                mean(&pairs[index].iter().map(|key| mean(&maps.iter().map(|map| value(self.map_pairs.get(&format!("{map}|{key}")), time, 8., 45.)).collect::<Vec<_>>())).collect::<Vec<_>>()) * 2.,
                0., 0., ratings[index].iter().copied().fold(f64::INFINITY, f64::min) / 400.,
                mean(&members.iter().enumerate().map(|(i,p)| { let d = p.peak_mmr.unwrap_or(ratings[index][i]) - ratings[index][i]; if d.is_nan() { d } else { d.max(0.) } } / 400.).collect::<Vec<_>>())]
        }).collect();
        let mut features: Vec<f64> = team_features[0]
            .iter()
            .zip(&team_features[1])
            .map(|(a, b)| clamp(a - b, -2., 2.))
            .collect();
        features[0] = clamp(rating, -2., 2.);
        let mut cross = Vec::new();
        for a in &ids[0] {
            for b in &ids[1] {
                let key = if a < b {
                    format!("{a}:{b}")
                } else {
                    format!("{b}:{a}")
                };
                cross.push(
                    value(self.opponents.get(&key), time, 10., 45.) * if a < b { 1. } else { -1. },
                );
            }
        }
        features[12] = mean(&cross) * 2.;
        features[13] = value(self.meetings.get(&matchup), time, 10., 45.) * direction * 2.;
        let logit = dot(&features, &self.weights);
        let a = (self.calibration.probability(logit)? * 1000.).round() / 1000.;
        let probability = AxisWinProbability {
            a,
            b: ((1. - a) * 1000.).round() / 1000.,
        };
        let individual = sigmoid(dot(
            &features
                .iter()
                .enumerate()
                .map(|(i, v)| if (8..=13).contains(&i) { 0. } else { *v })
                .collect::<Vec<_>>(),
            &self.weights,
        ));
        Ok((
            probability,
            Pending {
                m,
                maps,
                ids,
                pairs,
                trios,
                keys,
                matchup,
                direction,
                features,
                logit,
                individual,
            },
        ))
    }
    fn observe(&mut self, p: Pending<'_>) -> Result<(), CalibrationError> {
        let m = p.m;
        let winner = m.winner;
        if winner != Some(0.) && winner != Some(1.) && winner != Some(-2.) {
            return Ok(());
        }
        let time = m.time.unwrap();
        let draw = winner == Some(-2.);
        let outcome = if draw {
            0.5
        } else if winner == Some(0.) {
            1.
        } else {
            0.
        };
        let expected = sigmoid(std::f64::consts::LN_10 * p.features[0]);
        let residual = outcome - expected;
        let joint = outcome - p.individual;
        for (index, team) in m.teams.iter().enumerate() {
            let sign = if index == 0 { 1. } else { -1. };
            for member in &team.players {
                let player = self.players.entry(member.id.clone()).or_default();
                if let Some(mmr) = member.mmr.filter(|n| n.is_finite()) {
                    let rating = mmr + member.change.filter(|n| n.is_finite()).unwrap_or(0.);
                    player.rating = Some(rating);
                    player.peak_mmr = Some(player.peak_mmr.unwrap_or(mmr).max(mmr).max(rating));
                }
                if !draw {
                    player.result.add(time, residual * sign, 45.);
                    player.form.n *= 0.9;
                    player.form.value *= 0.9;
                    player.form.add(time, residual * sign, 7.);
                    for map in &p.maps {
                        player
                            .maps
                            .entry(map.clone())
                            .or_default()
                            .add(time, residual * sign, 45.);
                    }
                }
                if let Some(kda) = &member.kda
                    && [kda.kills, kda.deaths, kda.assists]
                        .iter()
                        .all(|n| n.is_finite() && *n >= 0.)
                {
                    let combat = clamp(
                        ((kda.kills + 0.5 * kda.assists + 5.) / (kda.deaths + 5.)).ln(),
                        -1.5,
                        1.5,
                    );
                    player.combat.add(time, combat, 45.);
                    player.recent_combat.n *= 0.9;
                    player.recent_combat.value *= 0.9;
                    player.recent_combat.add(time, combat, 7.);
                    for map in &p.maps {
                        player
                            .map_combat
                            .entry(map.clone())
                            .or_default()
                            .add(time, combat, 45.);
                    }
                }
                if let Some(rounds) = &m.rounds
                    && rounds.a + rounds.b > 0.
                {
                    player.rounds.add(
                        time,
                        (rounds.a / (rounds.a + rounds.b) - expected) * sign,
                        45.,
                    );
                }
            }
            if !draw {
                for key in &p.pairs[index] {
                    self.pairs
                        .entry(key.clone())
                        .or_default()
                        .add(time, joint * sign, 45.);
                    for map in &p.maps {
                        self.map_pairs
                            .entry(format!("{map}|{key}"))
                            .or_default()
                            .add(time, joint * sign, 45.);
                    }
                }
                for key in &p.trios[index] {
                    self.trios
                        .entry(key.clone())
                        .or_default()
                        .add(time, joint * sign, 45.);
                }
                self.lineups
                    .entry(p.keys[index].clone())
                    .or_default()
                    .add(time, joint * sign, 45.);
            }
        }
        if draw {
            return Ok(());
        }
        for left in &p.ids[0] {
            for right in &p.ids[1] {
                let (key, sign) = if left < right {
                    (format!("{left}:{right}"), 1.)
                } else {
                    (format!("{right}:{left}"), -1.)
                };
                self.opponents
                    .entry(key)
                    .or_default()
                    .add(time, joint * sign, 45.);
            }
        }
        self.meetings
            .entry(p.matchup)
            .or_default()
            .add(time, joint * p.direction, 45.);
        let rate = 0.04 / (1. + self.games as f64 / 200.).sqrt();
        let error = outcome - sigmoid(p.logit);
        for (i, feature) in p.features.iter().enumerate() {
            self.weights[i] = clamp(
                self.weights[i] + rate * (error * feature - 0.02 * (self.weights[i] - PRIORS[i])),
                if i == 0 { 0. } else { -2. },
                4.,
            );
        }
        self.calibration
            .observe(p.logit, if winner == Some(0.) { 1. } else { 0. })?;
        self.games += 1;
        Ok(())
    }
}

// JavaScript Map uses SameValueZero: both zeros share a key and all NaNs share a key.
fn number_key(number: f64) -> u64 {
    if number == 0. {
        0.0_f64.to_bits()
    } else if number.is_nan() {
        f64::NAN.to_bits()
    } else {
        number.to_bits()
    }
}

pub fn build_axis_win_probabilities(
    matches: &[AxisMatch],
) -> Result<Vec<(f64, AxisWinProbability)>, CalibrationError> {
    let mut ordered: Vec<_> = matches.iter().collect();
    ordered.sort_by(|a, b| {
        let time = a.time.unwrap_or(f64::INFINITY) - b.time.unwrap_or(f64::INFINITY);
        match time.partial_cmp(&0.) {
            Some(std::cmp::Ordering::Less) => std::cmp::Ordering::Less,
            Some(std::cmp::Ordering::Greater) => std::cmp::Ordering::Greater,
            _ => (a.number - b.number)
                .partial_cmp(&0.)
                .unwrap_or(std::cmp::Ordering::Equal),
        }
    });
    let mut queues: HashMap<String, Model> = HashMap::new();
    let mut predictions: Vec<(f64, AxisWinProbability)> = Vec::new();
    let mut positions: HashMap<u64, usize> = HashMap::new();
    let mut start = 0;
    while start < ordered.len() {
        let mut end = start + 1;
        while end < ordered.len() && ordered[end].time == ordered[start].time {
            end += 1;
        }
        let mut batch = Vec::new();
        for m in &ordered[start..end] {
            if !roster(m) || !m.time.is_some_and(f64::is_finite) {
                continue;
            }
            let key = m
                .queue_id
                .clone()
                .unwrap_or_else(|| format!("unknown:{}", m.queue.as_deref().unwrap_or("")));
            let (probability, pending) = queues.entry(key.clone()).or_default().predict(m)?;
            let position = positions.entry(number_key(m.number)).or_insert_with(|| {
                let index = predictions.len();
                // Map canonicalizes -0 to +0 when a key is first inserted.
                predictions.push((if m.number == 0. { 0. } else { m.number }, probability));
                index
            });
            predictions[*position].1 = probability;
            batch.push((key, pending));
        }
        for (key, pending) in batch {
            queues.get_mut(&key).unwrap().observe(pending)?;
        }
        start = end;
    }
    Ok(predictions)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn number_keys_match_same_value_zero() {
        assert_eq!(number_key(-0.0), number_key(0.0));
        assert_eq!(
            number_key(f64::NAN),
            number_key(f64::from_bits(0xfff8_0000_0000_0001))
        );
        assert_ne!(number_key(1.0), number_key(-1.0));
    }
    #[test]
    fn map_upserts_keep_first_position_and_canonicalize_zero() {
        let base: AxisMatch = serde_json::from_str(r#"{"number":1,"time":1,"maps":[],"teams":[{"players":[{"id":"1"}]},{"players":[{"id":"2"}]}]}"#).unwrap();
        let numbers = [
            -0.0,
            42.0,
            0.0,
            f64::NAN,
            f64::from_bits(0xfff8_0000_0000_0001),
        ];
        let matches: Vec<_> = numbers
            .into_iter()
            .enumerate()
            .map(|(i, number)| {
                let mut m = base.clone();
                m.number = number;
                m.time = Some(i as f64 + 1.);
                m
            })
            .collect();
        let result = build_axis_win_probabilities(&matches).unwrap();
        assert_eq!(result.len(), 3);
        assert_eq!(result[0].0.to_bits(), 0.0_f64.to_bits());
        assert_eq!(result[1].0, 42.0);
        assert!(result[2].0.is_nan());
    }
    #[test]
    fn calibration_validates_refits_and_forgets() {
        let mut c = AxisProbabilityCalibration::default();
        assert_eq!(c.probability(2.).unwrap(), 0.5);
        assert!(c.probability(f64::NAN).is_err());
        assert!(c.observe(f64::INFINITY, 1.).is_err());
        assert!(c.observe(1., 0.5).is_err());
        for _ in 0..2000 {
            c.observe(2., 1.).unwrap();
        }
        assert!(c.probability(2.).unwrap() > 0.8);
        for i in 0..1000 {
            c.observe(2., (i % 2) as f64).unwrap();
        }
        assert!(c.probability(2.).unwrap() < 0.55);
        assert!((c.probability(-2.).unwrap() + c.probability(2.).unwrap() - 1.).abs() < 1e-12);
    }
}
