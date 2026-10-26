use rusqlite::{Connection, OpenFlags, params};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::env;
use std::io::{self, BufRead, Write};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const MAX_FRAME: usize = 65_536;
const TARGET: usize = 20;
const MAX_VECTOR_BYTES: usize = 128 * 1024 * 1024;
const MEMORY_LIMIT_ERROR: &str = "Regular cohort exceeds 128 MiB computation budget";
const PERCENTAGES: [u32; 4] = [10, 15, 20, 30];
const METRICS: [&str; 7] = [
    "kd_ratio",
    "pmc_kd_ratio",
    "kills_per_raid",
    "killed_pmc_per_raid",
    "pmc_survival_rate",
    "longest_win_streak",
    "level",
];
const ELIGIBLE: &str = "hours > 0 AND pmc_raids > 0 AND aid != ?1 AND pvp_stats_known = 1 AND profile_updated_at >= ?2 AND NOT EXISTS (SELECT 1 FROM excluded_players tombstone WHERE tombstone.aid = players.aid)";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    version: u32,
    id: u64,
    args: [Job; 1],
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Job {
    kind: String,
    mode: String,
    args: Vec<Value>,
}

struct Input {
    hours: f64,
    raids: f64,
    aid: i64,
    dimension: String,
    median: bool,
    player: [Option<f64>; 7],
}

impl Input {
    fn parse(job: &Job) -> Result<Self, String> {
        if job.kind != "persistent" || job.mode != "regular" {
            return Err("Only persistent Regular cohorts are supported".into());
        }
        if !(3..=7).contains(&job.args.len()) {
            return Err("Expected 3 to 7 cohort arguments".into());
        }
        let number = |index: usize| {
            job.args[index]
                .as_f64()
                .filter(|n| n.is_finite())
                .ok_or_else(|| "Cohort centers must be finite numbers".to_string())
        };
        let hours = number(0)?;
        let raids = number(1)?;
        let aid = job.args[2]
            .as_i64()
            .filter(|n| *n > 0 && *n <= 9_007_199_254_740_991)
            .ok_or_else(|| "Invalid excluded account ID".to_string())?;
        let dimension = match job.args.get(3) {
            None | Some(Value::Null) => "hours",
            Some(value) => value.as_str().ok_or("Invalid dimension")?,
        };
        if !["hours", "pmc_raids"].contains(&dimension) {
            return Err("Invalid dimension".into());
        }
        let statistic = match job.args.get(4) {
            None | Some(Value::Null) => "trimmed_mean",
            Some(value) => value.as_str().ok_or("Invalid statistic")?,
        };
        if !["median", "trimmed_mean"].contains(&statistic) {
            return Err("Invalid statistic".into());
        }
        let period = match job.args.get(5) {
            None | Some(Value::Null) => "all",
            Some(value) => value.as_str().ok_or("Invalid period")?,
        };
        if !["all", "90d"].contains(&period) {
            return Err("Invalid period".into());
        }
        if job
            .args
            .get(6)
            .is_some_and(|metrics| !metrics.is_null() && !metrics.is_object())
        {
            return Err("Invalid player metrics".into());
        }
        let player = std::array::from_fn(|index| {
            job.args
                .get(6)
                .and_then(|m| m.get(METRICS[index]))
                .and_then(Value::as_f64)
                .filter(|n| n.is_finite() && *n >= 0.0)
        });
        Ok(Self {
            hours,
            raids,
            aid,
            dimension: dimension.into(),
            median: statistic == "median",
            player,
        })
    }
}

#[derive(Clone, Copy)]
struct Bounds {
    min: f64,
    max: f64,
}

impl Bounds {
    fn json(self) -> Value {
        json!({ "min": self.min, "max": self.max })
    }
}

fn bounds(center: f64, percent: u32, hours: bool) -> Bounds {
    let ratio = f64::from(percent) / 100.0;
    let epsilon = 1e-9 * center.abs().max(1.0);
    let scale = if hours { 10.0 } else { 1.0 };
    let maximum = ((center * (1.0 + ratio) - epsilon) * scale).ceil() / scale;
    Bounds {
        min: (((center * (1.0 - ratio) + epsilon) * scale).floor() / scale).max(0.0),
        max: if hours && maximum == 0.0 {
            0.0
        } else {
            maximum
        },
    }
}

struct Population {
    n: usize,
    hours: Option<Bounds>,
    raids: Option<Bounds>,
    values: [Vec<f64>; 7],
}

impl Population {
    fn empty() -> Self {
        Self {
            n: 0,
            hours: None,
            raids: None,
            values: std::array::from_fn(|_| Vec::new()),
        }
    }
    fn include_range(current: &mut Option<Bounds>, value: f64) {
        match current {
            Some(range) => {
                range.min = range.min.min(value);
                range.max = range.max.max(value);
            }
            None => {
                *current = Some(Bounds {
                    min: value,
                    max: value,
                })
            }
        }
    }
}

// Account for all seven vectors together. A population fallback must fail
// explicitly rather than silently truncate or exhaust the web container.
struct VectorBudget {
    used: usize,
    limit: usize,
}

impl VectorBudget {
    fn push(&mut self, values: &mut Vec<f64>, value: f64) -> Result<(), String> {
        if values.len() == values.capacity() {
            let remaining = self.limit.saturating_sub(self.used) / size_of::<f64>();
            if remaining == 0 {
                return Err(MEMORY_LIMIT_ERROR.into());
            }
            let previous_capacity = values.capacity();
            let growth = previous_capacity.max(4).min(remaining);
            values
                .try_reserve_exact(growth)
                .map_err(|_| "Cohort exceeds available memory".to_string())?;
            let bytes = (values.capacity() - previous_capacity)
                .checked_mul(size_of::<f64>())
                .ok_or(MEMORY_LIMIT_ERROR)?;
            self.used = self
                .used
                .checked_add(bytes)
                .filter(|used| *used <= self.limit)
                .ok_or(MEMORY_LIMIT_ERROR)?;
        }
        values.push(value);
        Ok(())
    }
}
fn read_population(
    db: &Connection,
    input: &Input,
    cutoff: i64,
    percent: Option<u32>,
) -> Result<Population, String> {
    let range_sql = if percent.is_some() {
        " AND hours >= ?3 AND hours <= ?4 AND pmc_raids >= ?5 AND pmc_raids <= ?6"
    } else {
        ""
    };
    // Match the existing covering-index read, avoiding profile JSON/table lookups.
    let sql = format!(
        "SELECT hours, pmc_raids, kd_ratio, pmc_kd_ratio, kills_per_raid, CASE WHEN pvp_stats_known = 1 AND pvp_stats_version = 1 AND pmc_raids > 0 THEN 1.0 * pmc_killed_pmc / pmc_raids END, pmc_survival_rate, longest_win_streak, level FROM players INDEXED BY idx_players_cohort WHERE {ELIGIBLE}{range_sql}"
    );
    let mut statement = db.prepare_cached(&sql).map_err(|e| e.to_string())?;
    let mut rows = if let Some(percent) = percent {
        let h = bounds(input.hours, percent, true);
        let r = bounds(input.raids, percent, false);
        statement.query(params![input.aid, cutoff, h.min, h.max, r.min, r.max])
    } else {
        statement.query(params![input.aid, cutoff])
    }
    .map_err(|e| e.to_string())?;
    let mut population = Population::empty();
    let mut budget = VectorBudget {
        used: 0,
        limit: MAX_VECTOR_BYTES,
    };
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let hours = row.get::<_, f64>(0).map_err(|e| e.to_string())?;
        let raids = row.get::<_, f64>(1).map_err(|e| e.to_string())?;
        population.n += 1;
        Population::include_range(&mut population.hours, hours);
        Population::include_range(&mut population.raids, raids);
        for index in 0..METRICS.len() {
            if let Some(value) = row
                .get::<_, Option<f64>>(index + 2)
                .map_err(|e| e.to_string())?
            {
                // Survival zero is missing evidence in the existing SQL. Other
                // legacy negative numeric metrics retain their SQL semantics.
                if index == 4 && value <= 0.0 {
                    continue;
                }
                budget.push(&mut population.values[index], value)?;
            }
        }
    }
    Ok(population)
}

fn selected_percent(db: &Connection, input: &Input, cutoff: i64) -> Result<Option<u32>, String> {
    let wide_h = bounds(input.hours, 30, true);
    let wide_r = bounds(input.raids, 30, false);
    let clauses = PERCENTAGES.iter().enumerate().map(|(index, _)| {
        let first = 7 + index * 4;
        format!("SUM(CASE WHEN hours >= ?{first} AND hours <= ?{} AND pmc_raids >= ?{} AND pmc_raids <= ?{} THEN 1 ELSE 0 END)", first + 1, first + 2, first + 3)
    }).collect::<Vec<_>>().join(", ");
    let sql = format!(
        "SELECT {clauses} FROM players WHERE {ELIGIBLE} AND hours >= ?3 AND hours <= ?4 AND pmc_raids >= ?5 AND pmc_raids <= ?6"
    );
    let mut sql_parameters = vec![
        rusqlite::types::Value::Integer(input.aid),
        rusqlite::types::Value::Integer(cutoff),
        rusqlite::types::Value::Real(wide_h.min),
        rusqlite::types::Value::Real(wide_h.max),
        rusqlite::types::Value::Real(wide_r.min),
        rusqlite::types::Value::Real(wide_r.max),
    ];
    for percent in PERCENTAGES {
        let h = bounds(input.hours, percent, true);
        let r = bounds(input.raids, percent, false);
        sql_parameters.extend([h.min, h.max, r.min, r.max].map(rusqlite::types::Value::Real));
    }
    let mut statement = db.prepare_cached(&sql).map_err(|e| e.to_string())?;
    let counts = statement
        .query_row(rusqlite::params_from_iter(sql_parameters), |row| {
            let mut counts = [0; 4];
            for (index, count) in counts.iter_mut().enumerate() {
                *count = row.get::<_, Option<i64>>(index)?.unwrap_or(0);
            }
            Ok(counts)
        })
        .map_err(|e| e.to_string())?;
    Ok(PERCENTAGES
        .into_iter()
        .zip(counts)
        .find(|(_, count)| *count >= TARGET as i64)
        .map(|(percent, _)| percent))
}

fn average(sorted: &[f64], median: bool) -> Option<f64> {
    let n = sorted.len();
    if n == 0 {
        return None;
    }
    let (offset, count) = if median {
        ((n - 1) / 2, 2 - n % 2)
    } else {
        let trim = if n >= TARGET {
            (n as f64 * 0.05).floor() as usize
        } else {
            0
        };
        (trim, n - 2 * trim)
    };
    // Neumaier compensated summation follows modern SQLite AVG for numeric
    // inputs; cross-runtime parity tests permit only floating roundoff.
    let mut sum: f64 = 0.0;
    let mut error: f64 = 0.0;
    for value in &sorted[offset..offset + count] {
        let next = sum + value;
        error += if sum.abs() > value.abs() {
            (sum - next) + value
        } else {
            (value - next) + sum
        };
        sum = next;
    }
    let result = (if error.is_finite() { sum + error } else { sum }) / count as f64;
    result.is_finite().then_some(result)
}

fn result(
    input: &Input,
    percent: u32,
    mut population: Population,
    strategy: &str,
    reason: Option<&str>,
) -> Value {
    let h = bounds(input.hours, percent, true);
    let r = bounds(input.raids, percent, false);
    let mut averages = Map::new();
    let mut percentiles = Map::new();
    for (index, metric) in METRICS.iter().enumerate() {
        let values = &mut population.values[index];
        values.sort_unstable_by(f64::total_cmp);
        let n = values.len();
        let (below, equal) = if let Some(player) = input.player[index] {
            let below = values.partition_point(|n| *n < player);
            let upper = values.partition_point(|n| *n <= player);
            (below, upper - below)
        } else {
            (0, 0)
        };
        let percentile = if input.player[index].is_some() && n >= TARGET {
            Some(
                ((below as f64 + (equal as f64 - 1.0) / 2.0) / (n - 1) as f64 * 100.0)
                    .clamp(0.0, 100.0),
            )
        } else {
            None
        };
        let required = if strategy == "population" || index == 4 {
            1
        } else {
            TARGET
        };
        let value = if n >= required {
            average(values, input.median)
        } else {
            None
        };
        averages.insert((*metric).into(), json!({ "value": value, "count": n }));
        percentiles.insert(
            (*metric).into(),
            json!({ "percentile": percentile, "count": n, "below": below, "equal": equal }),
        );
    }
    let sufficient = reason.is_none()
        && if strategy == "population" {
            population.n > 0
        } else {
            population.n >= TARGET
        };
    let resolved_reason = reason.or(if sufficient {
        None
    } else {
        Some("insufficient_cohort")
    });
    json!({
        "mode": "regular", "cycleId": "persistent", "aid": input.aid,
        "identity": { "aid": input.aid, "mode": "regular", "cycleId": "persistent" },
        "center": if input.dimension == "hours" { input.hours } else { input.raids },
        "dimension": input.dimension,
        "bounds": if input.dimension == "hours" { h.json() } else { r.json() },
        "axes": { "hours": { "center": input.hours, "bounds": h.json() }, "pmcRaids": { "center": input.raids, "bounds": r.json() } },
        "actualRanges": { "hours": population.hours.map(Bounds::json), "pmcRaids": population.raids.map(Bounds::json), "raids": population.raids.map(Bounds::json) },
        "target": TARGET, "required": TARGET, "targetN": TARGET, "twoDimensional": true,
        "strategy": strategy, "percent": percent, "n": population.n,
        "quality": if sufficient { "sufficient" } else { "unavailable" },
        "reliability": if sufficient { "sufficient" } else { "insufficient" },
        "reason": resolved_reason, "averages": averages, "percentiles": percentiles,
        "ranges": { "hours": { "min": h.min, "max": h.max, "percent": percent }, "pmcRaids": { "min": r.min, "max": r.max, "percent": percent }, "raids": { "min": r.min, "max": r.max, "percent": percent } }
    })
}

fn compute(db: &mut Connection, input: &Input) -> Result<Value, String> {
    if input.hours <= 0.0 || input.raids <= 0.0 {
        return Ok(result(
            input,
            30,
            Population::empty(),
            "matched",
            Some("no_activity"),
        ));
    }
    let cutoff = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis() as i64
        - 90 * 86_400_000;
    // Count, selection, metrics and tombstones see one consistent WAL snapshot.
    let transaction = db.transaction().map_err(|e| e.to_string())?;
    let percent = selected_percent(&transaction, input, cutoff)?;
    let population = read_population(&transaction, input, cutoff, percent)?;
    transaction.commit().map_err(|e| e.to_string())?;
    Ok(result(
        input,
        percent.unwrap_or(30),
        population,
        if percent.is_some() {
            "matched"
        } else {
            "population"
        },
        None,
    ))
}

fn open_database() -> Result<Connection, String> {
    let path = env::var("SQLITE_PATH")
        .ok()
        .filter(|p| !p.is_empty())
        .unwrap_or_else(|| "/data/players.db".into());
    let db = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| e.to_string())?;
    db.busy_timeout(Duration::from_millis(250))
        .map_err(|e| e.to_string())?;
    Ok(db)
}

fn handle(frame: &[u8], database: &mut Option<Connection>) -> Value {
    let raw: Value = match serde_json::from_slice(frame) {
        Ok(value) => value,
        Err(_) => return json!({ "id": null, "error": "Invalid JSON request" }),
    };
    let id = raw.get("id").and_then(Value::as_u64);
    let execute = || -> Result<Value, String> {
        let request: Request =
            serde_json::from_value(raw).map_err(|_| "Invalid request envelope".to_string())?;
        if request.version != 1 || request.id == 0 || request.id > 9_007_199_254_740_991 {
            return Err("Unsupported protocol version or request ID".into());
        }
        let input = Input::parse(&request.args[0])?;
        if database.is_none() {
            *database = Some(open_database()?);
        }
        compute(database.as_mut().unwrap(), &input)
    };
    match execute() {
        Ok(value) => json!({ "id": id, "result": value }),
        Err(error) => json!({ "id": id, "error": error.chars().take(512).collect::<String>() }),
    }
}

fn serve(reader: &mut impl BufRead, writer: &mut impl Write) -> io::Result<()> {
    let mut database = None;
    let mut frame = Vec::with_capacity(4096);
    let mut oversized = false;
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            if !frame.is_empty() || oversized {
                emit(
                    writer,
                    &json!({ "id": null, "error": "Unterminated request frame" }),
                )?;
            }
            return Ok(());
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let consumed = newline.map_or(available.len(), |index| index + 1);
        if !oversized {
            if frame.len() + consumed > MAX_FRAME {
                oversized = true;
                frame.clear();
            } else {
                frame.extend_from_slice(&available[..consumed]);
            }
        }
        reader.consume(consumed);
        if newline.is_some() {
            let reply = if oversized {
                json!({ "id": null, "error": "Request frame exceeds 64 KiB" })
            } else {
                handle(&frame, &mut database)
            };
            emit(writer, &reply)?;
            frame.clear();
            oversized = false;
        }
    }
}

fn emit(writer: &mut impl Write, reply: &Value) -> io::Result<()> {
    serde_json::to_writer(&mut *writer, reply)?;
    writer.write_all(b"\n")?;
    writer.flush()
}

fn main() {
    if let Err(error) = serve(&mut io::stdin().lock(), &mut io::stdout().lock()) {
        if error.kind() != io::ErrorKind::BrokenPipe {
            eprintln!("Cohort worker I/O failed: {error}");
        }
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input() -> Input {
        Input {
            hours: 100.0,
            raids: 100.0,
            aid: 1,
            dimension: "hours".into(),
            median: false,
            player: [Some(2.0); 7],
        }
    }

    fn database() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE players (aid INTEGER PRIMARY KEY, hours REAL, pmc_raids INTEGER, pvp_stats_known INTEGER, profile_updated_at INTEGER, kd_ratio REAL, pmc_kd_ratio REAL, kills_per_raid REAL, pmc_survival_rate REAL, longest_win_streak INTEGER, level INTEGER, pvp_stats_version INTEGER, pmc_killed_pmc INTEGER); CREATE TABLE excluded_players (aid INTEGER PRIMARY KEY); CREATE INDEX idx_players_cohort ON players(hours,pmc_raids,pvp_stats_known,profile_updated_at,aid,kd_ratio,pmc_kd_ratio,kills_per_raid,pmc_survival_rate,longest_win_streak,level,pvp_stats_version,pmc_killed_pmc);").unwrap();
        db
    }

    #[test]
    fn bounds_preserve_decimal_edges_and_epsilon() {
        let actual = bounds(100.0, 10, true);
        assert_eq!((actual.min, actual.max), (90.0, 110.0));
        let actual = bounds(1.1, 10, true);
        assert_eq!((actual.min, actual.max), (0.9, 1.3));
        let actual = bounds(100.0, 10, false);
        assert_eq!((actual.min, actual.max), (90.0, 110.0));
    }

    #[test]
    fn median_and_trimming_keep_existing_thresholds() {
        assert_eq!(average(&[1.0, 2.0, 8.0, 90.0], true), Some(5.0));
        assert_eq!(average(&[1.0, 2.0, 8.0], true), Some(2.0));
        assert_eq!(average(&[0.0, 1.0, 2.0], false), Some(1.0));
        let values: Vec<f64> = (0..20).map(f64::from).collect();
        assert_eq!(average(&values, false), Some(9.5));
        assert_eq!(average(&[], false), None);
    }

    #[test]
    fn selection_excludes_owner_bans_old_profiles_and_unknown_pvp() {
        let db = database();
        for aid in 1..=25 {
            db.execute("INSERT INTO players(aid,hours,pmc_raids,pvp_stats_known,profile_updated_at) VALUES (?1,100,100,1,100)", [aid]).unwrap();
        }
        db.execute_batch("INSERT INTO excluded_players VALUES (2); UPDATE players SET profile_updated_at=0 WHERE aid=3; UPDATE players SET pvp_stats_known=0 WHERE aid=4;").unwrap();
        assert_eq!(selected_percent(&db, &input(), 50).unwrap(), Some(10));
        let population = read_population(&db, &input(), 50, Some(10)).unwrap();
        assert_eq!(population.n, 21);
        assert_eq!(selected_percent(&db, &input(), 200).unwrap(), None);
    }

    #[test]
    fn result_keeps_nulls_sparse_survival_and_percentile_ties() {
        let mut population = Population::empty();
        population.n = 20;
        population.values[0] = vec![2.0; 20];
        population.values[4] = vec![50.0];
        let answer = result(&input(), 10, population, "matched", None);
        assert_eq!(answer["percentiles"]["kd_ratio"]["percentile"], 50.0);
        assert_eq!(answer["averages"]["pmc_survival_rate"]["value"], 50.0);
        assert!(answer["averages"]["level"]["value"].is_null());
        assert!(answer["percentiles"]["pmc_survival_rate"]["percentile"].is_null());
        assert_eq!(answer["identity"]["cycleId"], "persistent");
    }

    #[test]
    fn input_rejects_unsupported_modes_and_invalid_identifiers() {
        let job = Job {
            kind: "persistent".into(),
            mode: "pve".into(),
            args: vec![json!(100), json!(100), json!(1)],
        };
        assert!(Input::parse(&job).is_err());
        let job = Job {
            mode: "regular".into(),
            args: vec![json!(100), json!(100), json!(-1)],
            ..job
        };
        assert!(Input::parse(&job).is_err());
    }

    #[test]
    fn malformed_and_oversized_frames_are_bounded_and_do_not_stop_stream() {
        let mut frames = vec![b'x'; MAX_FRAME + 1];
        frames.extend_from_slice(b"\nnot json\n{\"version\":2,\"id\":5,\"args\":[{\"kind\":\"persistent\",\"mode\":\"regular\",\"args\":[1,1,1]}]}\n");
        let mut output = Vec::new();
        serve(&mut io::Cursor::new(frames), &mut output).unwrap();
        let replies: Vec<Value> = String::from_utf8(output)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(replies.len(), 3);
        assert!(replies.iter().all(|reply| reply["error"].is_string()));
        assert_eq!(replies[2]["id"], 5);
    }
    #[test]
    fn reading_preserves_sparse_metrics_versions_and_sql_ratio() {
        let db = database();
        db.execute_batch("INSERT INTO players VALUES (2,100,100,1,100,-1,2,3,0,4,5,1,20); INSERT INTO players VALUES (3,100,100,1,100,10,2,3,50,4,5,0,20);").unwrap();
        let population = read_population(&db, &input(), 50, None).unwrap();
        assert_eq!(population.n, 2);
        assert_eq!(population.values[0], vec![-1.0, 10.0]);
        assert_eq!(population.values[3], vec![0.2]);
        assert_eq!(population.values[4], vec![50.0]);
        let answer = result(&input(), 30, population, "population", None);
        assert_eq!(answer["averages"]["kd_ratio"]["value"], 4.5);
        assert_eq!(answer["averages"]["killed_pmc_per_raid"]["value"], 0.2);
        assert_eq!(answer["actualRanges"]["hours"]["min"], 100.0);
        assert_eq!(answer["quality"], "sufficient");
    }

    #[test]
    fn zero_activity_returns_unavailable_without_sql_queries() {
        let mut db = Connection::open_in_memory().unwrap();
        let mut input = input();
        input.raids = 0.0;
        let answer = compute(&mut db, &input).unwrap();
        assert_eq!(answer["reason"], "no_activity");
        assert_eq!(answer["strategy"], "matched");
        assert_eq!(answer["n"], 0);
        assert!(answer["actualRanges"]["hours"].is_null());
        assert!(answer["averages"]["kd_ratio"]["value"].is_null());
    }

    #[test]
    fn parsing_sanitizes_metrics_without_coercing_strings_or_negative_values() {
        let job: Job = serde_json::from_value(json!({ "kind":"persistent", "mode":"regular", "args":[100,100,1,"hours","median","90d",{"kd_ratio":"2", "pmc_kd_ratio":-1, "level":0}] })).unwrap();
        let input = Input::parse(&job).unwrap();
        assert_eq!(input.player[0], None);
        assert_eq!(input.player[1], None);
        assert_eq!(input.player[6], Some(0.0));
        let job: Job = serde_json::from_value(
            json!({ "kind":"persistent", "mode":"regular", "args":[100,100,1,123] }),
        )
        .unwrap();
        assert!(Input::parse(&job).is_err());
    }
    #[test]
    fn vector_budget_counts_all_capacities_and_rejects_without_truncation() {
        let mut budget = VectorBudget {
            used: 0,
            limit: 4 * size_of::<f64>(),
        };
        let mut first = Vec::new();
        let mut second = Vec::new();
        for value in 0..4 {
            budget.push(&mut first, f64::from(value)).unwrap();
        }
        assert_eq!(budget.used, 4 * size_of::<f64>());
        assert_eq!(
            budget.push(&mut first, 4.0).unwrap_err(),
            MEMORY_LIMIT_ERROR
        );
        assert_eq!(
            budget.push(&mut second, 1.0).unwrap_err(),
            MEMORY_LIMIT_ERROR
        );
        assert_eq!(first, vec![0.0, 1.0, 2.0, 3.0]);
        assert!(second.is_empty());
    }

    #[test]
    fn null_optional_arguments_restore_javascript_undefined_defaults() {
        let job: Job = serde_json::from_value(
            json!({ "kind":"persistent", "mode":"regular", "args":[100,100,1,null,null,null] }),
        )
        .unwrap();
        let input = Input::parse(&job).unwrap();
        assert_eq!(input.dimension, "hours");
        assert!(!input.median);
    }
    #[test]
    fn zero_bounds_preserve_typescript_axis_signed_zero_behavior() {
        assert!(bounds(0.0, 30, true).max.is_sign_positive());
        assert!(bounds(0.0, 30, false).max.is_sign_negative());
        assert_eq!(
            serde_json::to_string(&bounds(0.0, 30, false).json()).unwrap(),
            "{\"max\":-0.0,\"min\":0.0}"
        );
    }
}
