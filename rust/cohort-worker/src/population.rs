// Persistent population portraits/distributions. The SQL mirrors lib/db.ts;
// these are deliberately not the per-player comparison-cohort filters.
use super::MAX_VECTOR_BYTES;
use rusqlite::{
    Connection, params_from_iter,
    types::{Value as SqlValue, ValueRef},
};
use serde_json::{Map, Value, json};
use std::rc::Rc;

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
fn sql_number(value: ValueRef<'_>) -> Result<f64, String> {
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
// Read and sort ordinary numeric metrics once, but let SQLite perform AVG on
// their original storage classes. Exceptional values and metrics with mixed
// INTEGER/REAL storage classes retain the original SQL path. The option is deliberately
// opportunistic: allocation or virtual-table failure cannot reject a job that
// the existing SQL path could handle.
fn numeric_value(value: ValueRef<'_>) -> Option<(SqlValue, bool)> {
    match value {
        ValueRef::Integer(v) if (-SAFE_INTEGER..=SAFE_INTEGER).contains(&v) => {
            Some((SqlValue::Integer(v), false))
        }
        ValueRef::Real(v) if v.is_finite() && !(v == 0.0 && v.is_sign_negative()) => {
            Some((SqlValue::Real(v), true))
        }
        _ => None,
    }
}
fn numeric_averages(
    db: &Connection,
    input: &AverageInput,
    conditions: &str,
    parameters: &[SqlValue],
    counts: &[usize],
    limit: usize,
) -> Option<Vec<Option<Value>>> {
    let mut vectors: Vec<Option<Vec<SqlValue>>> = counts
        .iter()
        .map(|&count| {
            let sorted = input.statistic == "median" || count >= 20;
            if sorted && count > 0 {
                Some(Vec::new())
            } else {
                None
            }
        })
        .collect();
    if vectors.iter().all(Option::is_none) {
        return Some(vec![None; COLUMNS.len()]);
    }
    // A schema object can shadow the eponymous module. Avoid calling any
    // unrelated table-valued function that happens to use the same name.
    let occupied: i64 = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM main.sqlite_schema WHERE name = 'rarray' COLLATE NOCASE UNION ALL SELECT 1 FROM temp.sqlite_schema WHERE name = 'rarray' COLLATE NOCASE)",
        [],
        |row| row.get(0),
    ).ok()?;
    if occupied != 0 {
        return None;
    }
    let projection = COLUMNS
        .iter()
        .map(|column| {
            if ["pmc_kd_ratio", "killed_pmc"].contains(column) {
                format!("CASE WHEN pvp_stats_known = 1 THEN {column} END")
            } else {
                column.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join(",");
    let mut stmt = db
        .prepare(&format!(
            "SELECT {projection} FROM {} WHERE {conditions}",
            table(&input.mode)
        ))
        .ok()?;
    let mut rows = stmt.query(params_from_iter(parameters.iter())).ok()?;
    let mut used = 0usize;
    let mut kinds = [None; COLUMNS.len()];
    while let Some(row) = rows.next().ok()? {
        for (i, slot) in vectors.iter_mut().enumerate() {
            let Some(vector) = slot.as_mut() else {
                continue;
            };
            let value = row.get_ref(i).ok()?;
            if value == ValueRef::Null {
                continue;
            }
            let value = numeric_value(value);
            let Some((value, kind)) =
                value.filter(|(_, kind)| kinds[i].is_none_or(|previous| previous == *kind))
            else {
                used -= vector.capacity() * size_of::<SqlValue>();
                *slot = None;
                continue;
            };
            kinds[i] = Some(kind);
            if vector.len() == vector.capacity() {
                let remaining = limit.saturating_sub(used) / size_of::<SqlValue>();
                if remaining == 0 {
                    return None;
                }
                let previous = vector.capacity();
                vector
                    .try_reserve_exact(previous.max(4).min(remaining))
                    .ok()?;
                let bytes = (vector.capacity() - previous).checked_mul(size_of::<SqlValue>())?;
                used = used.checked_add(bytes).filter(|used| *used <= limit)?;
            }
            vector.push(value);
        }
    }
    drop(rows);
    drop(stmt);
    let mut average = db.prepare("SELECT AVG(value) FROM rarray(?)").ok()?;
    let mut output = vec![None; COLUMNS.len()];
    for (i, slot) in vectors.iter_mut().enumerate() {
        let Some(mut vector) = slot.take() else {
            continue;
        };
        if vector.len() != counts[i] {
            continue;
        }
        let as_number = |v: &SqlValue| match v {
            SqlValue::Integer(n) => *n as f64,
            SqlValue::Real(n) => *n,
            _ => unreachable!(),
        };
        vector.sort_unstable_by(|a, b| as_number(a).partial_cmp(&as_number(b)).unwrap());
        let (offset, length) = if input.statistic == "median" {
            (
                (vector.len() - 1) / 2,
                if vector.len().is_multiple_of(2) { 2 } else { 1 },
            )
        } else {
            let trim = (vector.len() as f64 * 0.05).floor() as usize;
            (trim, vector.len() - 2 * trim)
        };
        vector.truncate(offset + length);
        vector.drain(..offset);
        let array = Rc::new(vector);
        let mut result = average.query([array]).ok()?;
        output[i] = Some(
            result
                .next()
                .ok()?
                .map(|row| nullable_at(row, 0))
                .transpose()
                .ok()?
                .unwrap_or(Value::Null),
        );
    }
    Some(output)
}
fn averages(
    db: &Connection,
    input: &AverageInput,
    base: &str,
    base_parameters: &[SqlValue],
) -> Result<(Value, Value), String> {
    averages_impl(db, input, base, base_parameters, true, MAX_VECTOR_BYTES)
}
fn averages_impl(
    db: &Connection,
    input: &AverageInput,
    base: &str,
    base_parameters: &[SqlValue],
    use_numeric: bool,
    limit: usize,
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
    let counts = (0..COLUMNS.len())
        .map(|i| number_at(row, i + 1).map(|n| n as usize))
        .collect::<Result<Vec<_>, _>>()?;
    drop(rows);
    drop(counted);
    let fast = use_numeric
        .then(|| numeric_averages(db, input, &conditions, &parameters, &counts, limit))
        .flatten();
    let mut values = Map::new();
    let mut metric_counts = Map::new();
    values.insert("n".into(), json!(n as u64));
    for (i, column) in COLUMNS.iter().enumerate() {
        let count = counts[i];
        metric_counts.insert(column.to_string(), json!(count));
        if count == 0 {
            values.insert(column.to_string(), Value::Null);
            continue;
        }
        if let Some(Some(value)) = fast.as_ref().map(|v| &v[i]) {
            values.insert(column.to_string(), value.clone());
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
        rusqlite::vtab::array::load_module(&db).unwrap();
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
    fn array_name_conflict_falls_back_to_original_sql() {
        let db = database();
        db.execute_batch(
            "CREATE VIRTUAL TABLE rarray USING fts5(value); INSERT INTO rarray(value) VALUES('1');",
        )
        .unwrap();
        for i in 1..=21 {
            db.execute(
                "INSERT INTO mode_players(mode,aid,hours,kd_ratio) VALUES('pve',?,100,?)",
                rusqlite::params![i, i as f64 / 7.0],
            )
            .unwrap();
        }
        let q = input(json!({}));
        let (base, params) = base_where("pve", "all", 0.0);
        let mut counts = [0; COLUMNS.len()];
        counts[0] = 21;
        counts[5] = 21;
        assert!(numeric_averages(&db, &q, &base, &params, &counts, MAX_VECTOR_BYTES).is_none());
        assert_eq!(
            averages(&db, &q, &base, &params).unwrap(),
            averages_impl(&db, &q, &base, &params, false, MAX_VECTOR_BYTES).unwrap()
        );
        db.execute_batch("DROP TABLE rarray; CREATE TEMP TABLE RARRAY(value);")
            .unwrap();
        assert!(numeric_averages(&db, &q, &base, &params, &counts, MAX_VECTOR_BYTES).is_none());
        assert_eq!(
            averages(&db, &q, &base, &params).unwrap(),
            averages_impl(&db, &q, &base, &params, false, MAX_VECTOR_BYTES).unwrap()
        );
    }

    #[test]
    fn numeric_guard_rejects_negative_zero_and_non_finite_or_unsafe_values() {
        assert!(numeric_value(ValueRef::Real(-0.0)).is_none());
        assert!(numeric_value(ValueRef::Real(0.0)).is_some());
        assert!(numeric_value(ValueRef::Real(f64::INFINITY)).is_none());
        assert!(numeric_value(ValueRef::Real(f64::NAN)).is_none());
        assert!(numeric_value(ValueRef::Integer(SAFE_INTEGER + 1)).is_none());
        assert!(numeric_value(ValueRef::Text(b"4")).is_none());
        assert!(numeric_value(ValueRef::Blob(b"4")).is_none());
    }

    #[test]
    fn numeric_path_matches_original_sql_and_falls_back_on_exceptional_values_and_budget() {
        let db = Connection::open_in_memory().unwrap();
        let fields = COLUMNS.join(",");
        db.execute_batch(&format!("CREATE TABLE players(aid INTEGER PRIMARY KEY,profile_updated_at INTEGER,pvp_stats_known INTEGER,{fields});CREATE TABLE mode_players(mode TEXT,aid INTEGER,profile_updated_at INTEGER,pvp_stats_known INTEGER,{fields});CREATE TABLE excluded_players(aid INTEGER PRIMARY KEY);")).unwrap();
        rusqlite::vtab::array::load_module(&db).unwrap();
        for mode in ["regular", "pve"] {
            let table = table(mode);
            for i in 1..=41 {
                let known = if i % 3 == 0 { 0 } else { 1 };
                let mixed = if i % 2 == 0 {
                    SqlValue::Integer(i)
                } else {
                    SqlValue::Real(i as f64 + 0.25)
                };
                let text_or_blob = if i % 2 == 0 {
                    SqlValue::Text("bad".into())
                } else {
                    SqlValue::Blob(vec![50])
                };
                let stmt = format!(
                    "INSERT INTO {table}(aid,profile_updated_at,pvp_stats_known,hours,pmc_raids,total_raids,kd_ratio,pmc_kd_ratio,scav_raids,run_through,killed_pmc) VALUES(?,?,?,?,?,?,?,?,?,?,?)"
                );
                // mode_players defaults to NULL mode; assign it immediately below.
                db.execute(
                    &stmt,
                    rusqlite::params![
                        i,
                        if i % 5 == 0 { 0 } else { 100 },
                        known,
                        100.0f64,
                        i,
                        i,
                        i as f64 / 7.0,
                        mixed,
                        text_or_blob,
                        i64::MAX,
                        f64::INFINITY
                    ],
                )
                .unwrap();
                if mode == "pve" {
                    db.execute("UPDATE mode_players SET mode='pve' WHERE aid=?", [i])
                        .unwrap();
                }
            }
        }
        db.execute("INSERT INTO excluded_players VALUES(3)", [])
            .unwrap();
        db.execute_batch("PRAGMA query_only=ON;").unwrap();
        let cutoff_now = 100.0 + 90.0 * 86_400_000.0;
        for mode in ["regular", "pve"] {
            for statistic in ["median", "trimmed_mean"] {
                for period in ["all", "90d"] {
                    for (min, max, inclusive) in [
                        (None, None, true),
                        (Some(10.0), Some(30.0), true),
                        (Some(10.0), Some(30.0), false),
                    ] {
                        let mut q = input(json!({}));
                        q.mode = mode.into();
                        q.dimension = "pmc_raids".into();
                        q.statistic = statistic.into();
                        q.period = period.into();
                        q.min = min;
                        q.max = max;
                        q.inclusive = inclusive;
                        let (base, params) = base_where(mode, period, cutoff_now);
                        let old = averages_impl(&db, &q, &base, &params, false, MAX_VECTOR_BYTES)
                            .unwrap();
                        assert_eq!(
                            averages_impl(&db, &q, &base, &params, true, MAX_VECTOR_BYTES).unwrap(),
                            old,
                            "{mode}/{statistic}/{period}/{min:?}/{max:?}/{inclusive}"
                        );
                        assert_eq!(
                            averages_impl(&db, &q, &base, &params, true, 0).unwrap(),
                            old,
                            "budget fallback"
                        );
                    }
                }
            }
            let q = input(json!({}));
            let (base, params) = base_where(mode, "all", cutoff_now);
            let fast = numeric_averages(
                &db,
                &AverageInput {
                    mode: mode.into(),
                    ..q
                },
                &base,
                &params,
                &[40; COLUMNS.len()],
                MAX_VECTOR_BYTES,
            )
            .unwrap();
            assert!(fast[0].is_some(), "ordinary REAL column takes fast path");
            assert!(fast[1].is_some(), "ordinary INTEGER column takes fast path");
            assert!(fast[3].is_none(), "TEXT/BLOB fallback");
            assert!(fast[6].is_none(), "mixed INTEGER/REAL fallback");
            assert!(fast[10].is_none(), "infinity fallback");
            assert!(fast[11].is_none(), "unsafe INTEGER fallback");
        }
    }

    #[test]
    fn missing_array_module_falls_back_on_readonly_query_only_database() {
        let path = std::env::temp_dir().join(format!(
            "population-array-fallback-{}-{}.sqlite",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        {
            let db = Connection::open(&path).unwrap();
            let fields = COLUMNS
                .iter()
                .map(|c| format!("{c} REAL"))
                .collect::<Vec<_>>()
                .join(",");
            db.execute_batch(&format!("CREATE TABLE players(aid INTEGER PRIMARY KEY,profile_updated_at INTEGER,pvp_stats_known INTEGER,{fields});CREATE TABLE mode_players(mode TEXT,aid INTEGER,profile_updated_at INTEGER,pvp_stats_known INTEGER,{fields});CREATE TABLE excluded_players(aid INTEGER PRIMARY KEY);")).unwrap();
            for i in 1..=21 {
                db.execute(
                    "INSERT INTO mode_players(mode,aid,hours,kd_ratio) VALUES('pve',?,100,?)",
                    rusqlite::params![i, i as f64 / 7.0],
                )
                .unwrap();
            }
        }
        {
            let db = Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                .unwrap();
            db.execute_batch("PRAGMA query_only=ON").unwrap();
            assert!(db.execute("DELETE FROM mode_players", []).is_err());
            assert!(db.prepare("SELECT AVG(value) FROM rarray(?)").is_err());
            let q = input(json!({}));
            let (base, params) = base_where("pve", "all", 0.0);
            let expected = averages_impl(&db, &q, &base, &params, false, MAX_VECTOR_BYTES).unwrap();
            assert_eq!(averages(&db, &q, &base, &params).unwrap(), expected);
            assert_eq!(compute_average(&db, &q, 0.0).unwrap()["storage"], "sqlite");
            rusqlite::vtab::array::load_module(&db).unwrap();
            let mut counts = [0; COLUMNS.len()];
            counts[0] = 21;
            counts[5] = 21;
            assert!(
                numeric_averages(&db, &q, &base, &params, &counts, MAX_VECTOR_BYTES).unwrap()[5]
                    .is_some()
            );
            assert_eq!(averages(&db, &q, &base, &params).unwrap(), expected);
            // Registration also succeeds after the fast-path query completes.
            rusqlite::vtab::array::load_module(&db).unwrap();
        }
        std::fs::remove_file(path).unwrap();
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
