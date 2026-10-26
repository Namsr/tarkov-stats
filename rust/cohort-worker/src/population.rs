// Persistent population portraits/distributions. The SQL mirrors lib/db.ts;
// these are deliberately not the per-player comparison-cohort filters.
use super::MAX_VECTOR_BYTES;
use rusqlite::{
    Connection, params_from_iter,
    types::{Value as SqlValue, ValueRef},
};
use serde_json::{Map, Value, json};

pub const COLUMNS: [&str; 17] = [
    "hours",
    "total_raids",
    "pmc_raids",
    "scav_raids",
    "survival_rate",
    "kd_ratio",
    "pmc_kd_ratio",
    "kills_per_raid",
    "total_kills",
    "deaths",
    "killed_pmc",
    "run_through",
    "longest_win_streak",
    "achv_count",
    "level",
    "prestige",
    "pmc_survival_rate",
];
const Y_METRICS: [&str; 14] = [
    "players",
    "kd_ratio",
    "pmc_kd_ratio",
    "survival_rate",
    "kills_per_raid",
    "total_raids",
    "pmc_raids",
    "total_kills",
    "killed_pmc",
    "deaths",
    "prestige",
    "level",
    "longest_win_streak",
    "achv_count",
];
const OVERLAY: [&str; 6] = [
    "kd_ratio",
    "survival_rate",
    "kills_per_raid",
    "total_kills",
    "deaths",
    "total_raids",
];
const SAFE_INTEGER: i64 = 9_007_199_254_740_991;

#[derive(Clone)]
pub struct AverageInput {
    mode: String,
    dimension: String,
    metric: String,
    max_bins: f64,
    statistic: String,
    period: String,
    min: Option<f64>,
    max: Option<f64>,
    inclusive: bool,
}
pub struct MetricsInput {
    mode: String,
    statistic: String,
    period: String,
}
fn option<'a>(value: &'a Value, allowed: &[&str], description: &str) -> Result<&'a str, String> {
    value
        .as_str()
        .filter(|s| allowed.contains(s))
        .ok_or_else(|| format!("Invalid population {description}"))
}
fn mode(value: &str) -> Result<String, String> {
    if ["regular", "pve"].contains(&value) {
        Ok(value.into())
    } else {
        Err("Only Regular and PvE populations are supported".into())
    }
}
fn bound(value: &Value) -> Result<Option<f64>, String> {
    if value.is_null() {
        return Ok(None);
    }
    value
        .as_f64()
        .filter(|v| v.is_finite() && *v >= 0.0)
        .map(Some)
        .ok_or_else(|| "Invalid population range".into())
}
pub fn parse_average(game_mode: &str, args: &[Value]) -> Result<AverageInput, String> {
    if args.len() != 8 {
        return Err("Expected eight persistent average arguments".into());
    }
    let mode = mode(game_mode)?;
    let dimension = option(&args[0], &["hours", "pmc_raids"], "dimension")?.into();
    let requested = args[1].as_str().ok_or("Invalid population metric")?;
    let metric = if Y_METRICS.contains(&requested) {
        requested
    } else {
        "players"
    }
    .into();
    let max_bins = args[2]
        .as_f64()
        .filter(|v| v.is_finite())
        .ok_or("Invalid population bin count")?;
    let statistic = option(&args[3], &["trimmed_mean", "median"], "statistic")?.into();
    let period = option(&args[4], &["all", "90d"], "period")?.into();
    let min = bound(&args[5])?;
    let max = bound(&args[6])?;
    if min.zip(max).is_some_and(|(a, b)| a > b) {
        return Err("Invalid population range order".into());
    }
    let inclusive = args[7]
        .as_bool()
        .ok_or("Invalid population upper-bound policy")?;
    Ok(AverageInput {
        mode,
        dimension,
        metric,
        max_bins,
        statistic,
        period,
        min,
        max,
        inclusive,
    })
}
pub fn parse_metrics(game_mode: &str, args: &[Value]) -> Result<MetricsInput, String> {
    if args.len() != 2 {
        return Err("Expected statistic and period for persistent metric series".into());
    }
    Ok(MetricsInput {
        mode: mode(game_mode)?,
        statistic: option(&args[0], &["trimmed_mean", "median"], "statistic")?.into(),
        period: option(&args[1], &["all", "90d"], "period")?.into(),
    })
}
fn table(mode: &str) -> &'static str {
    if mode == "regular" {
        "players"
    } else {
        "mode_players"
    }
}
fn base_where(mode: &str, period: &str, now_ms: f64) -> (String, Vec<SqlValue>) {
    let source = table(mode);
    let mut conditions = vec![format!(
        "NOT EXISTS (SELECT 1 FROM excluded_players tombstone WHERE tombstone.aid = {source}.aid)"
    )];
    if mode == "pve" {
        conditions.push("mode = 'pve'".into());
    }
    let mut parameters = Vec::new();
    if period == "90d" {
        conditions.push("profile_updated_at >= ?".into());
        parameters.push(SqlValue::Real((now_ms - 90.0 * 86_400_000.0).floor()));
    }
    (conditions.join(" AND "), parameters)
}
fn metric_where(base: &str, column: &str) -> String {
    format!(
        "{base} AND {column} IS NOT NULL{}",
        if ["pmc_kd_ratio", "killed_pmc"].contains(&column) {
            " AND pvp_stats_known = 1"
        } else {
            ""
        }
    )
}
pub fn ready(db: &Connection, game_mode: &str) -> bool {
    if mode(game_mode).is_err() {
        return false;
    }
    db.prepare(&format!(
        "SELECT aid,profile_updated_at,pvp_stats_known,{} FROM {} LIMIT 0",
        COLUMNS.join(","),
        table(game_mode)
    ))
    .is_ok()
        && db
            .prepare("SELECT aid FROM excluded_players LIMIT 0")
            .is_ok()
}
fn js_text_number(text: &str) -> f64 {
    let text = text.trim_matches(|c: char| matches!(c, '\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}'));
    if text.is_empty() {
        return 0.0;
    }
    for (prefix, radix) in [
        ("0x", 16),
        ("0X", 16),
        ("0o", 8),
        ("0O", 8),
        ("0b", 2),
        ("0B", 2),
    ] {
        if let Some(digits) = text.strip_prefix(prefix) {
            if digits.is_empty() {
                return f64::NAN;
            }
            return digits
                .chars()
                .try_fold(0.0, |a, c| {
                    c.to_digit(radix)
                        .map(|n| a * f64::from(radix) + f64::from(n))
                })
                .unwrap_or(f64::NAN);
        }
    }
    if matches!(text, "Infinity" | "+Infinity") {
        return f64::INFINITY;
    }
    if text == "-Infinity" {
        return f64::NEG_INFINITY;
    }
    if text
        .bytes()
        .any(|c| !c.is_ascii_digit() && !b".+-eE".contains(&c))
    {
        return f64::NAN;
    }
    text.parse().unwrap_or(f64::NAN)
}
pub(super) fn sql_number(value: ValueRef<'_>) -> Result<f64, String> {
    match value {
        ValueRef::Null => Ok(0.0),
        ValueRef::Integer(n) if !(-SAFE_INTEGER..=SAFE_INTEGER).contains(&n) => {
            Err("SQLite INTEGER is outside the JavaScript safe integer range".into())
        }
        ValueRef::Integer(n) => Ok(n as f64),
        ValueRef::Real(n) => Ok(n),
        ValueRef::Text(s) => Ok(js_text_number(&String::from_utf8_lossy(s))),
        // node:sqlite returns Uint8Array, whose Number() is 0/one decimal byte/NaN.
        ValueRef::Blob(s) => Ok(if s.is_empty() {
            0.0
        } else if s.len() == 1 {
            f64::from(s[0])
        } else {
            f64::NAN
        }),
    }
}
fn number_at(row: &rusqlite::Row<'_>, index: usize) -> Result<f64, String> {
    sql_number(row.get_ref(index).map_err(|e| e.to_string())?)
}
fn nullable_at(row: &rusqlite::Row<'_>, index: usize) -> Result<Value, String> {
    if row.get_ref(index).map_err(|e| e.to_string())? == ValueRef::Null {
        Ok(Value::Null)
    } else {
        Ok(json!(number_at(row, index)?))
    }
}
fn fallback_bounds(dimension: &str) -> Value {
    json!({"min":0,"max":if dimension=="hours"{5000}else{1000}})
}
pub fn unavailable_average(input: &AverageInput) -> Value {
    json!({"storage":"unavailable","body":{"mode":input.mode,"cycleId":"persistent","total":0,"averages":null,"metricCounts":{},"brackets":[],"buckets":[],"histogram":[],"bounds":fallback_bounds(&input.dimension),"dimension":input.dimension,"metric":input.metric,"statistic":input.statistic,"period":input.period}})
}
fn averages(
    db: &Connection,
    input: &AverageInput,
    base: &str,
    base_parameters: &[SqlValue],
) -> Result<(Value, Value), String> {
    let mut conditions = base.to_string();
    let mut parameters = base_parameters.to_vec();
    if let Some(min) = input.min {
        conditions.push_str(&format!(" AND {} >= ?", input.dimension));
        parameters.push(SqlValue::Real(min));
    }
    if let Some(max) = input.max {
        conditions.push_str(&format!(
            " AND {} {} ?",
            input.dimension,
            if input.inclusive { "<=" } else { "<" }
        ));
        parameters.push(SqlValue::Real(max));
    }
    let counts = COLUMNS
        .iter()
        .map(|c| {
            format!(
                "COUNT({})",
                if ["pmc_kd_ratio", "killed_pmc"].contains(c) {
                    format!("CASE WHEN pvp_stats_known = 1 THEN {c} END")
                } else {
                    c.to_string()
                }
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    let mut counted = db
        .prepare(&format!(
            "SELECT COUNT(*),{counts} FROM {} WHERE {conditions}",
            table(&input.mode)
        ))
        .map_err(|e| e.to_string())?;
    let mut rows = counted
        .query(params_from_iter(parameters.iter()))
        .map_err(|e| e.to_string())?;
    let row = rows
        .next()
        .map_err(|e| e.to_string())?
        .ok_or("Population count missing")?;
    let n = number_at(row, 0)?;
    let mut values = Map::new();
    let mut metric_counts = Map::new();
    values.insert("n".into(), json!(n as u64));
    for (i, column) in COLUMNS.iter().enumerate() {
        let count = number_at(row, i + 1)? as usize;
        metric_counts.insert(column.to_string(), json!(count));
        if count == 0 {
            values.insert(column.to_string(), Value::Null);
            continue;
        }
        let where_metric = metric_where(&conditions, column);
        let trim = if count >= 20 {
            (count as f64 * 0.05).floor() as usize
        } else {
            0
        };
        let bounded_median = input.statistic == "median"
            && (input.mode != "regular" || input.period == "all")
            && input.min.is_none()
            && input.max.is_none();
        let sql = if input.statistic == "median" && !bounded_median {
            format!(
                "WITH ranked AS (SELECT {column} AS v,ROW_NUMBER() OVER(ORDER BY {column}) AS rn,COUNT(*) OVER() AS n FROM {} WHERE {where_metric} AND {column} IS NOT NULL) SELECT AVG(v) FROM ranked WHERE rn IN(CAST((n+1)/2 AS INTEGER),CAST((n+2)/2 AS INTEGER))",
                table(&input.mode)
            )
        } else if input.statistic == "trimmed_mean" && trim == 0 {
            format!(
                "SELECT AVG({column}) FROM {} WHERE {where_metric}",
                table(&input.mode)
            )
        } else {
            format!(
                "SELECT AVG(v) FROM(SELECT {column} AS v FROM {} WHERE {where_metric} ORDER BY {column} LIMIT ? OFFSET ?)",
                table(&input.mode)
            )
        };
        let mut args = parameters.clone();
        if bounded_median {
            args.push(SqlValue::Integer(if count.is_multiple_of(2) {
                2
            } else {
                1
            }));
            args.push(SqlValue::Integer(((count - 1) / 2) as i64));
        } else if input.statistic == "trimmed_mean" && trim > 0 {
            args.push(SqlValue::Integer((count - 2 * trim) as i64));
            args.push(SqlValue::Integer(trim as i64));
        }
        let mut statement = db.prepare(&sql).map_err(|e| e.to_string())?;
        let mut result = statement
            .query(params_from_iter(args.iter()))
            .map_err(|e| e.to_string())?;
        let value = result
            .next()
            .map_err(|e| e.to_string())?
            .map(|r| nullable_at(r, 0))
            .transpose()?
            .unwrap_or(Value::Null);
        values.insert(column.to_string(), value);
    }
    Ok((Value::Object(values), Value::Object(metric_counts)))
}
#[derive(Clone, Debug)]
struct Bucket {
    lo: f64,
    hi: Option<f64>,
    n: f64,
    sum: f64,
}
impl Bucket {
    fn json(&self) -> Value {
        json!({"lo":self.lo,"hi":self.hi,"n":self.n as u64,"sum":self.sum})
    }
}
fn bucket_sql(
    dimension: &str,
    column: Option<&str>,
    source: &str,
    conditions: &str,
    statistic: &str,
) -> String {
    let (top, step_edge, small, large) = if dimension == "hours" {
        (10000, 2000, 50, 100)
    } else {
        (3000, 1000, 25, 50)
    };
    let lo = format!(
        "CASE WHEN {dimension}>={top} THEN {top} WHEN {dimension}<{step_edge} THEN CAST({dimension}/{small} AS INTEGER)*{small} ELSE {step_edge}+CAST(({dimension}-{step_edge})/{large} AS INTEGER)*{large} END"
    );
    let hi = format!(
        "CASE WHEN {dimension}>={top} THEN NULL WHEN {dimension}<{step_edge} THEN ({lo})+{small} ELSE ({lo})+{large} END"
    );
    if let Some(column) = column
        && statistic == "median"
    {
        return format!(
            "WITH bucketed AS(SELECT {lo} AS lo,{hi} AS hi,{column} AS value FROM {source} WHERE {conditions}),ranked AS(SELECT lo,hi,value,ROW_NUMBER() OVER(PARTITION BY lo,hi ORDER BY value) AS rn,COUNT(*) OVER(PARTITION BY lo,hi) AS bucket_n FROM bucketed) SELECT lo,hi,MAX(bucket_n),COALESCE(SUM(CASE WHEN rn IN(CAST((bucket_n+1)/2 AS INTEGER),CAST((bucket_n+2)/2 AS INTEGER)) THEN value END)/NULLIF(COUNT(CASE WHEN rn IN(CAST((bucket_n+1)/2 AS INTEGER),CAST((bucket_n+2)/2 AS INTEGER)) THEN 1 END),0)*MAX(bucket_n),0) FROM ranked GROUP BY lo,hi ORDER BY lo"
        );
    }
    format!(
        "SELECT {lo} AS lo,{hi} AS hi,COUNT(*),{} FROM {source} WHERE {conditions} GROUP BY {lo},{hi} ORDER BY lo",
        column
            .map(|c| format!("COALESCE(SUM({c}),0)"))
            .unwrap_or_else(|| "0".into())
    )
}
fn buckets(
    db: &Connection,
    mode: &str,
    dimension: &str,
    column: Option<&str>,
    statistic: &str,
    base: &str,
    parameters: &[SqlValue],
) -> Result<Vec<Bucket>, String> {
    let conditions = column.map_or_else(|| base.to_string(), |c| metric_where(base, c));
    let mut statement = db
        .prepare(&bucket_sql(
            dimension,
            column,
            table(mode),
            &conditions,
            statistic,
        ))
        .map_err(|e| e.to_string())?;
    let mut rows = statement
        .query(params_from_iter(parameters.iter()))
        .map_err(|e| e.to_string())?;
    let mut output = Vec::new();
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        if output.len() == output.capacity() {
            let limit = MAX_VECTOR_BYTES / size_of::<Bucket>();
            let remaining = limit
                .checked_sub(output.capacity())
                .ok_or("Population exceeds 128 MiB computation budget")?;
            if remaining == 0 {
                return Err("Population exceeds 128 MiB computation budget".into());
            }
            let growth = output.capacity().max(4).min(remaining);
            output
                .try_reserve_exact(growth)
                .map_err(|_| "Population exceeds available memory")?;
            if output.capacity() > limit {
                return Err("Population exceeds 128 MiB computation budget".into());
            }
        }
        output.push(Bucket {
            lo: number_at(row, 0)?,
            hi: if row.get_ref(1).map_err(|e| e.to_string())? == ValueRef::Null {
                None
            } else {
                Some(number_at(row, 1)?)
            },
            n: number_at(row, 2)?,
            sum: number_at(row, 3)?,
        });
    }
    Ok(output)
}
fn js_number(value: f64) -> String {
    if value == 0.0 {
        return "0".into();
    }
    if value.abs() >= 1e21 || value.abs() < 1e-6 {
        let value = format!("{value:e}");
        let (coefficient, power) = value.split_once('e').unwrap();
        let exponent: i32 = power.parse().unwrap();
        format!(
            "{coefficient}e{}{exponent}",
            if exponent >= 0 { "+" } else { "" }
        )
    } else {
        value.to_string()
    }
}
fn label_bound(value: f64) -> String {
    if value >= 1000.0 {
        let s = format!("{:.2}", value / 1000.0);
        format!("{}k", s.trim_end_matches('0').trim_end_matches('.'))
    } else {
        js_number(value)
    }
}
fn label(lo: f64, hi: Option<f64>) -> String {
    hi.map_or_else(
        || format!("{}+", label_bound(lo)),
        |hi| format!("{}–{}", label_bound(lo), label_bound(hi)),
    )
}
fn merge(cells: &[Bucket], threshold: f64) -> Vec<Bucket> {
    let mut result: Vec<Bucket> = Vec::new();
    let mut cursor = cells[0].lo;
    let mut hi = None;
    let (mut n, mut sum) = (0.0, 0.0);
    for cell in cells {
        hi = cell.hi;
        n += cell.n;
        sum += cell.sum;
        if n >= threshold {
            result.push(Bucket {
                lo: cursor,
                hi,
                n,
                sum,
            });
            cursor = hi.unwrap_or(cursor);
            n = 0.0;
            sum = 0.0;
        }
    }
    if n > 0.0 {
        if let Some(last) = result.last_mut() {
            last.hi = hi;
            last.n += n;
            last.sum += sum;
        } else {
            result.push(Bucket {
                lo: cursor,
                hi,
                n,
                sum,
            });
        }
    }
    result
}
fn histogram(cells: &[Bucket], max_bins: f64, average: bool) -> Value {
    let mut cells = cells
        .iter()
        .filter(|b| {
            b.lo.is_finite()
                && b.hi.is_none_or(|hi| hi.is_finite() && hi > b.lo)
                && b.n.is_finite()
                && b.sum.is_finite()
                && b.n > 0.0
        })
        .cloned()
        .collect::<Vec<_>>();
    cells.sort_by(|a, b| a.lo.total_cmp(&b.lo));
    if cells.is_empty() {
        return json!([]);
    }
    let cap = max_bins.floor().clamp(1.0, 36.0) as usize;
    let mut threshold = 5.0;
    let mut bins = merge(&cells, threshold);
    while bins.len() > cap && bins.len() > 1 {
        threshold = (threshold * 1.5).ceil();
        bins = merge(&cells, threshold);
    }
    Value::Array(
        bins.iter()
            .map(|b| {
                let mut value = b.json();
                value["label"] = json!(label(b.lo, b.hi));
                value["avg"] = if average && b.n > 0.0 {
                    json!(b.sum / b.n)
                } else {
                    Value::Null
                };
                value
            })
            .collect(),
    )
}
pub fn compute_average(
    db: &Connection,
    input: &AverageInput,
    now_ms: f64,
) -> Result<Value, String> {
    let transaction = db.unchecked_transaction().map_err(|e| e.to_string())?;
    let (base, parameters) = base_where(&input.mode, &input.period, now_ms);
    let (averages, counts) = averages(&transaction, input, &base, &parameters)?;
    let cells = buckets(
        &transaction,
        &input.mode,
        &input.dimension,
        if input.metric == "players" {
            None
        } else {
            Some(&input.metric)
        },
        &input.statistic,
        &base,
        &parameters,
    )?;
    let bounds = {
        let mut stmt = transaction
            .prepare(&format!(
                "SELECT MIN({0}),MAX({0}) FROM {1} WHERE {base}",
                input.dimension,
                table(&input.mode)
            ))
            .map_err(|e| e.to_string())?;
        let mut rows = stmt
            .query(params_from_iter(parameters.iter()))
            .map_err(|e| e.to_string())?;
        let row = rows
            .next()
            .map_err(|e| e.to_string())?
            .ok_or("Population bounds missing")?;
        if row.get_ref(0).map_err(|e| e.to_string())? == ValueRef::Null
            || row.get_ref(1).map_err(|e| e.to_string())? == ValueRef::Null
        {
            fallback_bounds(&input.dimension)
        } else {
            let low = number_at(row, 0)?.floor();
            json!({"min":if low.is_nan(){low}else{low.max(0.0)},"max":number_at(row,1)?.ceil()})
        }
    };
    let total = transaction
        .query_row(
            &format!("SELECT COUNT(*) FROM {} WHERE {base}", table(&input.mode)),
            params_from_iter(parameters.iter()),
            |row| row.get::<_, i64>(0),
        )
        .map_err(|e| e.to_string())?;
    let brackets=cells.iter().map(|b|json!({"bracket_key":b.hi.map_or_else(||format!("{}+",js_number(b.lo)),|hi|format!("{}-{}",js_number(b.lo),js_number(hi))),"n":b.n as u64,"sum":b.sum})).collect::<Vec<_>>();
    let output = json!({"storage":"sqlite","body":{"mode":input.mode,"cycleId":"persistent","total":total,"averages":averages,"metricCounts":counts,"brackets":brackets,"buckets":cells.iter().map(Bucket::json).collect::<Vec<_>>(),"histogram":histogram(&cells,input.max_bins,input.metric!="players"),"bounds":bounds,"dimension":input.dimension,"metric":input.metric,"statistic":input.statistic,"period":input.period}});
    transaction.commit().map_err(|e| e.to_string())?;
    Ok(output)
}
pub fn compute_metrics(
    db: &Connection,
    input: &MetricsInput,
    now_ms: f64,
) -> Result<Value, String> {
    let transaction = db.unchecked_transaction().map_err(|e| e.to_string())?;
    let (base, parameters) = base_where(&input.mode, &input.period, now_ms);
    let mut series = Map::new();
    for metric in OVERLAY {
        series.insert(
            metric.into(),
            Value::Array(
                buckets(
                    &transaction,
                    &input.mode,
                    "pmc_raids",
                    Some(metric),
                    &input.statistic,
                    &base,
                    &parameters,
                )?
                .iter()
                .map(Bucket::json)
                .collect(),
            ),
        );
    }
    let output = json!({"mode":input.mode,"cycleId":"persistent","statistic":input.statistic,"period":input.period,"series":series});
    transaction.commit().map_err(|e| e.to_string())?;
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn database() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        let fields = COLUMNS
            .iter()
            .map(|c| format!("{c} REAL"))
            .collect::<Vec<_>>()
            .join(",");
        db.execute_batch(&format!("CREATE TABLE players(aid INTEGER PRIMARY KEY,profile_updated_at INTEGER,pvp_stats_known INTEGER,{fields});CREATE TABLE mode_players(mode TEXT,aid INTEGER,profile_updated_at INTEGER,pvp_stats_known INTEGER,{fields});CREATE TABLE excluded_players(aid INTEGER PRIMARY KEY);")).unwrap();
        db
    }
    fn input(extra: Value) -> AverageInput {
        let mut args = json!([
            "hours",
            "players",
            36,
            "trimmed_mean",
            "all",
            null,
            null,
            true
        ]);
        for (key, value) in extra.as_object().unwrap() {
            args[key.parse::<usize>().unwrap()] = value.clone();
        }
        parse_average("pve", args.as_array().unwrap()).unwrap()
    }
    #[test]
    fn empty_populations_are_not_unavailable_and_missing_storage_is_not_zero() {
        let db = database();
        let input = input(json!({}));
        assert!(ready(&db, "pve"));
        let result = compute_average(&db, &input, 0.0).unwrap();
        assert_eq!(result["storage"], "sqlite");
        assert_eq!(result["body"]["averages"]["n"], 0);
        assert_eq!(result["body"]["averages"]["kd_ratio"], Value::Null);
        assert_eq!(result["body"]["metricCounts"]["kd_ratio"], 0);
        assert_eq!(unavailable_average(&input)["body"]["averages"], Value::Null);
    }
    #[test]
    fn trims_each_metric_at_twenty_and_retains_zero_pvp_counts() {
        let db = database();
        for i in 1..=20 {
            db.execute("INSERT INTO mode_players(mode,aid,hours,kd_ratio,killed_pmc,pvp_stats_known) VALUES('pve',?,100,?,?,?)",rusqlite::params![i,if i==20{10000}else{i},0,i%2]).unwrap();
        }
        let input = input(json!({"1":"kd_ratio"}));
        let result = compute_average(&db, &input, 0.0).unwrap();
        assert_eq!(result["body"]["averages"]["kd_ratio"], 10.5);
        assert_eq!(result["body"]["metricCounts"]["killed_pmc"], 10);
        assert_eq!(result["body"]["averages"]["killed_pmc"], 0.0);
        // Distribution sums are deliberately untrimmed even for trimmed_mean portraits.
        assert_eq!(result["body"]["buckets"][0]["sum"], 10190.0);
    }
    #[test]
    fn cutoff_is_inclusive_and_population_buckets_ignore_portrait_range() {
        let db = database();
        for (i, timestamp, hours) in [(1, 100, 10.0), (2, 99, 20.0), (3, 101, 30.0)] {
            db.execute(
                "INSERT INTO mode_players(mode,aid,profile_updated_at,hours) VALUES('pve',?,?,?)",
                rusqlite::params![i, timestamp, hours],
            )
            .unwrap();
        }
        let result = compute_average(
            &db,
            &input(json!({"4":"90d","5":30,"6":30})),
            100.0 + 90.0 * 86_400_000.0,
        )
        .unwrap();
        assert_eq!(result["body"]["total"], 2);
        assert_eq!(result["body"]["averages"]["n"], 1);
        assert_eq!(result["body"]["buckets"][0]["n"], 2);
        db.execute("INSERT INTO excluded_players(aid) VALUES(1)", [])
            .unwrap();
        assert_eq!(
            compute_average(&db, &input(json!({"4":"90d"})), 100.0 + 90.0 * 86_400_000.0).unwrap()
                ["body"]["total"],
            1
        );
    }
    #[test]
    fn metric_medians_are_weighted_after_adaptive_pooling_not_recomputed() {
        let db = database();
        for (i, hours, value) in [
            (1, 0.0, 0.0),
            (2, 0.0, 100.0),
            (3, 50.0, 1.0),
            (4, 50.0, 1.0),
            (5, 50.0, 1000.0),
        ] {
            db.execute(
                "INSERT INTO mode_players(mode,aid,hours,kd_ratio) VALUES('pve',?,?,?)",
                rusqlite::params![i, hours, value],
            )
            .unwrap();
        }
        let result =
            compute_average(&db, &input(json!({"1":"kd_ratio","2":1,"3":"median"})), 0.0).unwrap();
        assert_eq!(result["body"]["buckets"][0]["sum"], 100.0);
        assert_eq!(result["body"]["buckets"][1]["sum"], 3.0);
        assert_eq!(result["body"]["histogram"][0]["avg"], 20.6);
    }
    #[test]
    fn sql_failure_rolls_back_read_transaction_and_worker_can_reuse_connection() {
        let db = database();
        db.execute(
            "ALTER TABLE mode_players RENAME COLUMN kd_ratio TO missing_metric",
            [],
        )
        .unwrap();
        assert!(compute_average(&db, &input(json!({})), 0.0).is_err());
        assert!(db.is_autocommit());
        db.execute(
            "ALTER TABLE mode_players RENAME COLUMN missing_metric TO kd_ratio",
            [],
        )
        .unwrap();
        assert!(compute_average(&db, &input(json!({})), 0.0).is_ok());
    }
    #[test]
    fn parsers_reject_wrong_mode_shape_types_and_range_order() {
        assert!(
            parse_average(
                "arena",
                &json!(["hours", "players", 36, "median", "all", null, null, true])
                    .as_array()
                    .unwrap()
                    .clone()
            )
            .is_err()
        );
        for args in [
            json!([]),
            json!(["hours", "players", 36, "median", "all", -1, null, true]),
            json!(["hours", "players", 36, "median", "all", 5, 1, true]),
            json!(["hours", "players", "36", "median", "all", null, null, true]),
            json!(["hours", "players", 36, "median", "all", null, null, 1]),
        ] {
            assert!(parse_average("pve", args.as_array().unwrap()).is_err());
        }
        assert!(parse_metrics("pve", &[json!("median"), json!("bad")]).is_err());
        assert!(parse_metrics("pve", &[json!("median"), json!("all"), Value::Null]).is_err());
    }
    #[test]
    fn integer_bucket_sql_keeps_the_existing_division_and_safe_integer_reader_contract() {
        let db = database();
        db.execute_batch("INSERT INTO mode_players(mode,aid,hours,total_raids) VALUES('pve',1,100,1),('pve',2,100,2)").unwrap();
        // REAL affinity differs from the actual INTEGER total_raids column.
        db.execute_batch("ALTER TABLE mode_players RENAME COLUMN total_raids TO old_total;ALTER TABLE mode_players ADD COLUMN total_raids INTEGER;UPDATE mode_players SET total_raids=old_total").unwrap();
        let result =
            compute_average(&db, &input(json!({"1":"total_raids","3":"median"})), 0.0).unwrap();
        assert_eq!(result["body"]["averages"]["total_raids"], 1.5);
        assert_eq!(result["body"]["buckets"][0]["sum"], 2.0);
        assert!(sql_number(ValueRef::Integer(9_007_199_254_740_993)).is_err());
        assert!(js_text_number("\u{0085}").is_nan());
    }
}
