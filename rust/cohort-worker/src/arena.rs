use super::{Bounds, MAX_VECTOR_BYTES, PERCENTAGES, TARGET, VectorBudget};
use rusqlite::{Connection, types::Value as SqlValue};
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;

const MODES: [&str; 6] = [
    "overall",
    "teamFight",
    "lastHero",
    "checkpoint",
    "blastGang",
    "shootOutDuo",
];
const METRICS: [&str; 5] = [
    "kd_ratio",
    "win_rate",
    "headshot_rate",
    "kills_per_match",
    "damage_per_match",
];
// Kept in parity tests against lib/arena/storage.ts.
const PARSER_VERSION: i64 = 5;
const COLUMNS: &str =
    "hours, games_count, kd_ratio, win_rate, headshot_rate, kills_per_match, damage_per_match";
const BASE_WHERE: &str = "arena_mode = ? AND NOT EXISTS (SELECT 1 FROM excluded_players tombstone WHERE tombstone.aid = arena_mode_stats.aid)";

pub(super) struct CohortInput {
    aid: i64,
    mode: String,
    median: bool,
}

pub(super) struct AverageInput {
    mode: String,
    median: bool,
    dimension: String,
    metric: String,
    ranges: [Option<f64>; 4],
}

fn mode(value: Option<&Value>) -> Result<String, String> {
    value
        .and_then(Value::as_str)
        .filter(|mode| MODES.contains(mode))
        .map(str::to_string)
        .ok_or_else(|| "Invalid Arena mode".into())
}

fn optional_string<'a>(value: Option<&'a Value>, default: &'a str) -> Result<&'a str, String> {
    match value {
        None | Some(Value::Null) => Ok(default),
        Some(value) => value.as_str().ok_or_else(|| "Invalid Arena option".into()),
    }
}

fn median(value: Option<&Value>) -> Result<bool, String> {
    match optional_string(value, "trimmed_mean")? {
        "median" => Ok(true),
        "trimmed_mean" => Ok(false),
        _ => Err("Invalid Arena statistic".into()),
    }
}

pub(super) fn parse_cohort(args: &[Value]) -> Result<CohortInput, String> {
    if !(2..=3).contains(&args.len()) {
        return Err("Invalid Arena cohort arguments".into());
    }
    let aid = args[0]
        .as_i64()
        .filter(|aid| *aid > 0 && *aid <= 9_007_199_254_740_991)
        .ok_or("Invalid Arena account ID")?;
    Ok(CohortInput {
        aid,
        mode: mode(args.get(1))?,
        median: median(args.get(2))?,
    })
}

pub(super) fn parse_average(args: &[Value]) -> Result<AverageInput, String> {
    if args.len() != 1 || !args[0].is_object() {
        return Err("Invalid Arena population arguments".into());
    }
    let value = &args[0];
    let dimension = optional_string(value.get("dimension"), "matches")?;
    if !["hours", "matches"].contains(&dimension) {
        return Err("Invalid Arena dimension".into());
    }
    let metric = optional_string(value.get("metric"), "players")?;
    if metric != "players" && !METRICS.contains(&metric) {
        return Err("Invalid Arena metric".into());
    }
    let mut ranges = [None; 4];
    for (index, key) in ["minHours", "maxHours", "minMatches", "maxMatches"]
        .iter()
        .enumerate()
    {
        if let Some(value) = value.get(key).filter(|value| !value.is_null()) {
            ranges[index] = Some(
                value
                    .as_f64()
                    .filter(|n| n.is_finite() && *n >= 0.0)
                    .ok_or("Invalid Arena range")?,
            );
        }
    }
    for pair in [0, 2] {
        if let (Some(min), Some(max)) = (ranges[pair], ranges[pair + 1])
            && min > max
        {
            return Err("Invalid Arena range".into());
        }
    }
    Ok(AverageInput {
        mode: mode(value.get("mode"))?,
        median: median(value.get("statistic"))?,
        dimension: dimension.into(),
        metric: metric.into(),
        ranges,
    })
}

pub(super) fn ready(db: &Connection) -> bool {
    db.prepare(&format!("SELECT {COLUMNS},parser_version,aid,arena_mode FROM arena_mode_stats WHERE NOT EXISTS (SELECT 1 FROM excluded_players WHERE aid=arena_mode_stats.aid) LIMIT 0")).is_ok()
}

// Node's Arena reader accepts only finite numeric SQLite values. Text/blob
// legacy values are missing evidence, not a failure of the complete cohort.
fn number(row: &rusqlite::Row<'_>, index: usize) -> rusqlite::Result<Option<f64>> {
    use rusqlite::types::ValueRef;
    Ok(match row.get_ref(index)? {
        ValueRef::Integer(value) => Some(value as f64),
        ValueRef::Real(value) if value.is_finite() => Some(value),
        _ => None,
    })
}
fn statistic(values: &mut [f64], median: bool) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    values.sort_unstable_by(f64::total_cmp);
    let n = values.len();
    let result = if median {
        if n % 2 == 1 {
            values[n / 2]
        } else {
            (values[n / 2 - 1] + values[n / 2]) / 2.0
        }
    } else {
        let trim = if n >= TARGET {
            (n as f64 * 0.05).floor() as usize
        } else {
            0
        };
        values[trim..n - trim].iter().sum::<f64>() / (n - 2 * trim) as f64
    };
    result.is_finite().then_some(result)
}

fn summary(values: &mut [f64], median: bool, minimum: usize) -> Value {
    let n = values.len();
    json!({ "value": if n >= minimum { statistic(values, median) } else { None }, "count": n,
        "reason": if n == 0 { Some("no_valid_values") } else if n < minimum { Some("insufficient_values") } else { None } })
}

struct Samples {
    n: usize,
    values: [Vec<f64>; 6],
    hours: Option<Bounds>,
    matches: Option<Bounds>,
}
impl Samples {
    fn new() -> Self {
        Self {
            n: 0,
            values: std::array::from_fn(|_| Vec::new()),
            hours: None,
            matches: None,
        }
    }
    fn add(&mut self, row: &[Option<f64>; 7], budget: &mut VectorBudget) -> Result<(), String> {
        self.n += 1;
        for (range, value) in [(&mut self.hours, row[0]), (&mut self.matches, row[1])] {
            if let Some(value) = value {
                super::Population::include_range(range, value);
            }
        }
        for index in 0..6 {
            if let Some(value) = row[if index == 5 { 1 } else { index + 2 }] {
                budget.push(&mut self.values[index], value)?;
            }
        }
        Ok(())
    }
    fn metrics(&mut self, median: bool, minimum: usize) -> Value {
        Value::Object(
            METRICS
                .iter()
                .enumerate()
                .map(|(index, metric)| {
                    (
                        (*metric).into(),
                        summary(&mut self.values[index], median, minimum),
                    )
                })
                .collect(),
        )
    }
}

fn nullable_bounds(bounds: Option<Bounds>) -> Value {
    bounds
        .map(Bounds::json)
        .unwrap_or_else(|| json!({"min":null,"max":null}))
}
fn proportional(center: f64, percent: u32) -> Bounds {
    let ratio = f64::from(percent) / 100.0;
    Bounds {
        min: (center * (1.0 - ratio)).max(0.0),
        max: center * (1.0 + ratio),
    }
}
fn statistic_name(median: bool) -> &'static str {
    if median { "median" } else { "trimmed_mean" }
}

fn condition(
    mode: &str,
    except_aid: Option<i64>,
    ranges: [Option<f64>; 4],
) -> (String, Vec<SqlValue>) {
    let mut sql = format!("{BASE_WHERE} AND games_count >= 10 AND parser_version = ?");
    let mut params = vec![
        SqlValue::Text(mode.into()),
        SqlValue::Integer(PARSER_VERSION),
    ];
    if let Some(aid) = except_aid {
        sql.push_str(" AND aid != ?");
        params.push(SqlValue::Integer(aid));
    }
    for (range, clause) in ranges.into_iter().zip([
        "hours >= ?",
        "hours <= ?",
        "games_count >= ?",
        "games_count <= ?",
    ]) {
        if let Some(value) = range {
            sql.push_str(" AND ");
            sql.push_str(clause);
            params.push(SqlValue::Real(value));
        }
    }
    (sql, params)
}

fn scan(
    db: &Connection,
    mode: &str,
    aid: Option<i64>,
    ranges: [Option<f64>; 4],
    mut visit: impl FnMut([Option<f64>; 7]) -> Result<(), String>,
) -> Result<(), String> {
    let (condition, params) = condition(mode, aid, ranges);
    let mut statement = db
        .prepare_cached(&format!(
            "SELECT {COLUMNS} FROM arena_mode_stats WHERE {condition}"
        ))
        .map_err(|e| e.to_string())?;
    let mut rows = statement
        .query(rusqlite::params_from_iter(params))
        .map_err(|e| e.to_string())?;
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let mut values = [None; 7];
        for (index, value) in values.iter_mut().enumerate() {
            *value = number(row, index).map_err(|e| e.to_string())?;
        }
        visit(values)?;
    }
    Ok(())
}

fn empty_cohort(input: &CohortInput) -> Value {
    let mut samples = Samples::new();
    json!({"aid":input.aid,"mode":input.mode,"statistic":statistic_name(input.median),"target":{"hours":null,"matches":null},
        "percent":30,"sampleN":0,"required":20,"quality":"unavailable","reason":"target_unavailable",
        "metrics":samples.metrics(input.median,20),"averageMatches":summary(&mut [],input.median,20),
        "strategy":if input.mode=="overall" {"population"} else {"matched"},
        "bounds":{"hours":{"min":null,"max":null},"matches":{"min":if input.mode=="overall" {Some(10)} else {None},"max":null}}})
}

pub(super) fn cohort(db: &mut Connection, input: &CohortInput) -> Result<Value, String> {
    let tx = db.transaction().map_err(|e| e.to_string())?;
    let mut statement = tx.prepare_cached(&format!("SELECT hours,games_count,parser_version FROM arena_mode_stats WHERE {BASE_WHERE} AND aid=? LIMIT 1")).map_err(|e| e.to_string())?;
    let target = statement
        .query_row(rusqlite::params![input.mode, input.aid], |row| {
            Ok((number(row, 0)?, number(row, 1)?, number(row, 2)?))
        })
        .optional()
        .map_err(|e| e.to_string())?;
    drop(statement);
    let Some((hours, matches, parser)) = target else {
        return Ok(empty_cohort(input));
    };
    let hours = hours.filter(|n| n.is_finite());
    let matches = matches.filter(|n| n.is_finite());
    if parser != Some(PARSER_VERSION as f64)
        || matches.is_none_or(|n| n < 1.0)
        || (input.mode != "overall" && hours.is_none())
    {
        return Ok(empty_cohort(input));
    }
    let matches = matches.unwrap();
    let mut percent = 30;
    let mut ranges = [None; 4];
    let mut bounds = json!({"hours":{"min":null,"max":null},"matches":{"min":10,"max":null}});
    if input.mode != "overall" {
        let h = hours.unwrap();
        let wide_h = proportional(h, 30);
        let wide_m = proportional(matches, 30);
        let (where_clause, mut parameters) = condition(
            &input.mode,
            Some(input.aid),
            [
                Some(wide_h.min),
                Some(wide_h.max),
                Some(wide_m.min),
                Some(wide_m.max),
            ],
        );
        let mut count_parameters = Vec::new();
        let clauses = PERCENTAGES.iter().map(|p| {
            let h = proportional(h,*p); let m = proportional(matches,*p);
            count_parameters.extend([h.min,h.max,m.min,m.max].map(SqlValue::Real));
            "SUM(CASE WHEN hours BETWEEN ? AND ? AND games_count BETWEEN ? AND ? THEN 1 ELSE 0 END)"
        }).collect::<Vec<_>>().join(",");
        count_parameters.append(&mut parameters);
        let mut statement = tx
            .prepare_cached(&format!(
                "SELECT {clauses} FROM arena_mode_stats WHERE {where_clause}"
            ))
            .map_err(|e| e.to_string())?;
        let counts = statement
            .query_row(rusqlite::params_from_iter(count_parameters), |row| {
                let mut counts = [0_i64; 4];
                for (index, count) in counts.iter_mut().enumerate() {
                    *count = row.get::<_, Option<i64>>(index)?.unwrap_or(0);
                }
                Ok(counts)
            })
            .map_err(|e| e.to_string())?;
        let selected = counts
            .iter()
            .position(|count| *count >= TARGET as i64)
            .unwrap_or(3);
        percent = PERCENTAGES[selected];
        let hr = proportional(h, percent);
        let mr = proportional(matches, percent);
        bounds = json!({"hours":hr.json(),"matches":mr.json()});
        if counts[selected] < TARGET as i64 {
            let mut answer = empty_cohort(input);
            answer["target"] = json!({"hours":hours,"matches":matches});
            answer["bounds"] = bounds;
            answer["sampleN"] = json!(counts[selected]);
            answer["reason"] = json!("insufficient_cohort");
            return Ok(answer);
        }
        ranges = [Some(hr.min), Some(hr.max), Some(mr.min), Some(mr.max)];
    }
    let mut samples = Samples::new();
    let mut budget = VectorBudget {
        used: 0,
        limit: MAX_VECTOR_BYTES,
    };
    scan(&tx, &input.mode, Some(input.aid), ranges, |row| {
        samples.add(&row, &mut budget)
    })?;
    let sufficient = samples.n >= TARGET;
    let answer = json!({"aid":input.aid,"mode":input.mode,"strategy":if input.mode=="overall"{"population"}else{"matched"},
        "statistic":statistic_name(input.median),"target":{"hours":hours,"matches":matches},"percent":percent,"bounds":bounds,
        "sampleN":samples.n,"required":20,"quality":if sufficient{"sufficient"}else{"unavailable"},"reason":if sufficient{None}else{Some("insufficient_cohort")},
        "metrics":samples.metrics(input.median,20),"averageMatches":summary(&mut samples.values[5],input.median,20)});
    tx.commit().map_err(|e| e.to_string())?;
    Ok(answer)
}

fn bucket(value: f64, hours: bool) -> (f64, Option<f64>) {
    let (split, cap, small, large) = if hours {
        (2000.0, 10000.0, 50.0, 100.0)
    } else {
        (1000.0, 3000.0, 25.0, 50.0)
    };
    if value >= cap {
        return (cap, None);
    }
    let min = if value < split {
        (value / small).floor() * small
    } else {
        split + ((value - split) / large).floor() * large
    };
    (min, Some(min + if value < split { small } else { large }))
}

fn population(db: &Connection) -> Result<Value, String> {
    let mut statement=db.prepare_cached("SELECT arena_mode,COUNT(DISTINCT CASE WHEN arena_mode='overall' THEN aid END),COUNT(DISTINCT CASE WHEN arena_mode<>'overall' AND typeof(games_count)='integer' AND games_count>=1 THEN aid END) FROM arena_mode_stats WHERE parser_version=? AND NOT EXISTS(SELECT 1 FROM excluded_players tombstone WHERE tombstone.aid=arena_mode_stats.aid) GROUP BY arena_mode").map_err(|e|e.to_string())?;
    let mut rows = statement
        .query([PARSER_VERSION])
        .map_err(|e| e.to_string())?;
    let mut played: Map<String, Value> = MODES[1..]
        .iter()
        .map(|mode| ((*mode).into(), json!(0)))
        .collect();
    let mut scanned = 0_i64;
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let mode: String = row.get(0).map_err(|e| e.to_string())?;
        if mode == "overall" {
            scanned = row.get(1).map_err(|e| e.to_string())?;
        } else if played.contains_key(&mode) {
            played.insert(
                mode,
                json!(row.get::<_, i64>(2).map_err(|e| e.to_string())?),
            );
        }
    }
    Ok(json!({"scannedAccounts":scanned,"playedAccounts":played}))
}

pub(super) fn average(db: &mut Connection, input: &AverageInput) -> Result<Value, String> {
    let tx = db.transaction().map_err(|e| e.to_string())?;
    let mut samples = Samples::new();
    let mut budget = VectorBudget {
        used: 0,
        limit: MAX_VECTOR_BYTES,
    };
    let mut buckets: BTreeMap<String, (f64, Option<f64>, Samples)> = BTreeMap::new();
    scan(&tx, &input.mode, None, input.ranges, |row| {
        samples.add(&row, &mut budget)?;
        if let Some(value) = row[if input.dimension == "hours" { 0 } else { 1 }] {
            let (min, max) = bucket(value, input.dimension == "hours");
            let group = buckets
                .entry(min.to_string())
                .or_insert_with(|| (min, max, Samples::new()));
            group.2.add(&row, &mut budget)?;
        }
        Ok(())
    })?;
    let metrics = samples.metrics(input.median, 0);
    let coverage: Map<String, Value> = METRICS
        .iter()
        .enumerate()
        .map(|(index, metric)| {
            (
                (*metric).into(),
                json!(if samples.n == 0 {
                    0.0
                } else {
                    samples.values[index].len() as f64 / samples.n as f64
                }),
            )
        })
        .collect();
    let mut buckets: Vec<_> = buckets.into_values().collect();
    buckets.sort_unstable_by(|a, b| a.0.total_cmp(&b.0));
    let buckets:Vec<_>=buckets.into_iter().map(|(min,max,mut samples)|json!({"min":min,"max":max,"sampleN":samples.n,"metrics":samples.metrics(input.median,0)})).collect();
    let answer = json!({"filterIdentity":{"mode":input.mode,"statistic":statistic_name(input.median),"dimension":input.dimension,"metric":input.metric,"minHours":input.ranges[0],"maxHours":input.ranges[1],"minMatches":input.ranges[2],"maxMatches":input.ranges[3]},
        "sampleN":samples.n,"total":samples.n,"coverage":coverage,"bounds":{"hours":nullable_bounds(samples.hours),"matches":nullable_bounds(samples.matches)},
        "metrics":metrics,"averageMatches":summary(&mut samples.values[5],input.median,0),"buckets":buckets,"population":population(&tx)?});
    tx.commit().map_err(|e| e.to_string())?;
    Ok(answer)
}

use rusqlite::OptionalExtension;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sparse_summary_and_naive_arithmetic_match_arena() {
        assert_eq!(summary(&mut [], false, 20)["reason"], "no_valid_values");
        assert_eq!(
            summary(&mut [0.0, 2.0], true, 20)["reason"],
            "insufficient_values"
        );
        assert_eq!(summary(&mut [0.0, 2.0], true, 0)["value"], 1.0);
        assert_eq!(statistic(&mut [1.0, 2.0, 8.0, 90.0], true), Some(5.0));
    }
    #[test]
    fn bucket_edges_and_proportional_ranges_keep_arena_conventions() {
        assert_eq!(bucket(1999.0, true), (1950.0, Some(2000.0)));
        assert_eq!(bucket(2000.0, true), (2000.0, Some(2100.0)));
        assert_eq!(bucket(3000.0, false), (3000.0, None));
        assert_eq!(proportional(1.1, 10).min, 1.1 * 0.9);
    }
    #[test]
    fn validation_rejects_modes_statistics_and_reversed_ranges() {
        assert!(parse_cohort(&[json!(1), json!("bad")]).is_err());
        assert!(parse_average(&[json!({"mode":"overall","minHours":20,"maxHours":10})]).is_err());
        assert!(
            parse_average(&[json!({"mode":"overall","metric":"kd_ratio","dimension":"hours"})])
                .is_ok()
        );
    }
    fn database() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE arena_mode_stats(aid INTEGER,arena_mode TEXT,hours REAL,games_count INTEGER,kd_ratio REAL,win_rate REAL,headshot_rate REAL,kills_per_match REAL,damage_per_match REAL,parser_version INTEGER,PRIMARY KEY(aid,arena_mode));CREATE TABLE excluded_players(aid INTEGER PRIMARY KEY);").unwrap();
        db
    }

    #[test]
    fn overall_allows_unknown_hours_and_named_modes_never_use_population_fallback() {
        let mut db = database();
        db.execute_batch("INSERT INTO arena_mode_stats(aid,arena_mode,hours,games_count,parser_version)VALUES(1,'overall',NULL,1,5),(1,'lastHero',100,100,5);").unwrap();
        for aid in 2..=21 {
            db.execute("INSERT INTO arena_mode_stats(aid,arena_mode,hours,games_count,kd_ratio,parser_version)VALUES(?1,'overall',NULL,10,2,5)",[aid]).unwrap();
            db.execute("INSERT INTO arena_mode_stats(aid,arena_mode,hours,games_count,kd_ratio,parser_version)VALUES(?1,'lastHero',1000,100,2,5)",[aid]).unwrap();
        }
        let input = parse_cohort(&[json!(1), json!("overall")]).unwrap();
        let result = cohort(&mut db, &input).unwrap();
        assert_eq!(result["sampleN"], 20);
        assert_eq!(result["strategy"], "population");
        assert!(result["target"]["hours"].is_null());
        assert_eq!(result["metrics"]["kd_ratio"]["value"], 2.0);
        let input = parse_cohort(&[json!(1), json!("lastHero")]).unwrap();
        let result = cohort(&mut db, &input).unwrap();
        assert_eq!(result["sampleN"], 0);
        assert_eq!(result["strategy"], "matched");
        assert_eq!(result["reason"], "insufficient_cohort");
        assert_eq!(result["metrics"]["kd_ratio"]["count"], 0);
        db.execute_batch("INSERT INTO excluded_players VALUES(1)")
            .unwrap();
        assert_eq!(
            cohort(&mut db, &input).unwrap()["reason"],
            "target_unavailable"
        );
    }

    #[test]
    fn population_keeps_sparse_metrics_and_strict_played_account_counts() {
        let mut db = database();
        db.execute_batch("INSERT INTO arena_mode_stats(aid,arena_mode,hours,games_count,kd_ratio,parser_version)VALUES(1,'overall',NULL,0,99,5),(2,'teamFight',0,1,99,5),(3,'teamFight',NULL,10,0,5),(4,'teamFight',50,10.5,NULL,5),(5,'teamFight',100,100,99,4);").unwrap();
        let input = parse_average(&[json!({"mode":"teamFight"})]).unwrap();
        let result = average(&mut db, &input).unwrap();
        assert_eq!(result["sampleN"], 2);
        assert_eq!(
            result["metrics"]["kd_ratio"],
            json!({"value":0.0,"count":1,"reason":null})
        );
        assert_eq!(result["population"]["scannedAccounts"], 1);
        assert_eq!(result["population"]["playedAccounts"]["teamFight"], 2);
        assert_eq!(result["coverage"]["kd_ratio"], 0.5);
        assert_eq!(result["bounds"]["hours"], json!({"min":50.0,"max":50.0}));
    }

    #[test]
    fn malformed_numeric_values_are_missing_evidence_instead_of_errors() {
        let mut db = database();
        db.execute_batch("INSERT INTO arena_mode_stats(aid,arena_mode,hours,games_count,kd_ratio,win_rate,headshot_rate,parser_version)VALUES(1,'overall','bad',10,'bad',X'01',1e999,5),(2,'overall',10,10,-1,0,0,5);").unwrap();
        let input = parse_average(&[json!({"mode":"overall"})]).unwrap();
        let result = average(&mut db, &input).unwrap();
        assert_eq!(result["sampleN"], 2);
        assert_eq!(result["metrics"]["kd_ratio"]["count"], 1);
        assert_eq!(result["metrics"]["kd_ratio"]["value"], -1.0);
        assert_eq!(result["metrics"]["win_rate"]["count"], 1);
        assert_eq!(result["metrics"]["headshot_rate"]["count"], 1);
        let input = parse_cohort(&[json!(1), json!("overall")]).unwrap();
        assert!(cohort(&mut db, &input).is_ok());
        db.execute_batch("UPDATE arena_mode_stats SET games_count='bad' WHERE aid=1")
            .unwrap();
        assert_eq!(
            cohort(&mut db, &input).unwrap()["reason"],
            "target_unavailable"
        );
    }
}
