// Seasonal population portraits use latest snapshots, enriched by the live account profile.
// Keep this separate from the per-player seasonal comparison cohort.
use super::{MAX_VECTOR_BYTES, VectorBudget, population};
use rusqlite::{Connection, types::ValueRef};
use serde_json::{Map, Value, json};
use std::time::{SystemTime, UNIX_EPOCH};
const PORTRAIT: &str = "WITH latest AS (
 SELECT s.* FROM progression_snapshots s JOIN (
 SELECT aid,cycle_id,MAX(profile_updated_at) AS profile_updated_at FROM progression_snapshots
 WHERE mode='seasonal' AND cycle_id=? GROUP BY aid,cycle_id
 ) current ON current.aid=s.aid AND current.cycle_id=s.cycle_id AND current.profile_updated_at=s.profile_updated_at
 WHERE s.mode='seasonal' AND s.cycle_id=?
),portrait AS (
 SELECT p.aid,p.profile_updated_at,p.lifetime_pvp_hours AS hours,latest.total_raids,latest.pmc_raids,latest.scav_raids,
 latest.survived,latest.deaths,latest.total_kills,latest.killed_pmc,latest.run_through,latest.longest_win_streak,
 latest.level,latest.prestige,CASE WHEN latest.achievements IS NOT NULL AND json_valid(latest.achievements)
 THEN COALESCE(latest.achv_count,json_array_length(latest.achievements)) ELSE NULL END AS achv_count,
 latest.pmc_survived,latest.pmc_deaths,latest.pmc_kills
 FROM player_profiles p JOIN latest ON latest.aid=p.aid AND latest.mode=p.mode AND latest.cycle_id=p.cycle_id
 WHERE p.mode='seasonal' AND p.cycle_id=? AND p.confirmed_banned=0
 AND NOT EXISTS(SELECT 1 FROM excluded_players e WHERE e.aid=p.aid)
 AND(p.pmc_raids>=1 OR p.scav_raids>=1)
),normalized AS(SELECT portrait.*,
 CASE WHEN total_raids>0 THEN 100.0*survived/total_raids END AS survival_rate,
 CASE WHEN deaths IS NULL OR total_kills IS NULL THEN NULL WHEN deaths>0 THEN 1.0*total_kills/deaths ELSE total_kills END AS kd_ratio,
 CASE WHEN pmc_deaths>0 THEN 1.0*killed_pmc/pmc_deaths ELSE killed_pmc END AS pmc_kd_ratio,
 CASE WHEN total_raids>0 THEN 1.0*total_kills/total_raids END AS kills_per_raid,
 CASE WHEN pmc_raids>0 THEN 100.0*pmc_survived/pmc_raids END AS pmc_survival_rate FROM portrait)
 SELECT aid,profile_updated_at,hours,total_raids,pmc_raids,scav_raids,survived,deaths,total_kills,killed_pmc,
 run_through,longest_win_streak,level,prestige,achv_count,pmc_survived,pmc_deaths,pmc_kills,
 survival_rate,kd_ratio,pmc_kd_ratio,kills_per_raid,pmc_survival_rate FROM normalized";
const OVERLAYS: [&str; 6] = [
    "kd_ratio",
    "survival_rate",
    "kills_per_raid",
    "total_kills",
    "deaths",
    "total_raids",
];
const METRICS: [&str; 14] = [
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
// Indices correspond to population::COLUMNS in the exact TS portrait projection.
const COLUMNS: [usize; 17] = [2, 3, 4, 5, 18, 19, 20, 21, 8, 7, 9, 10, 11, 14, 12, 13, 22];
type Row = [f64; 23];
pub struct Input {
    cycle: String,
    period: String,
    statistic: String,
    dimension: String,
    metric: String,
    min: Option<f64>,
    max: Option<f64>,
    now: Option<f64>,
}
fn now_ms() -> Result<f64, String> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis() as f64)
}
pub fn parse(args: &[Value], metrics: bool) -> Result<Input, String> {
    if args.len() != 1 || !args[0].is_object() {
        return Err("Expected one Seasonal population input object".into());
    }
    let v = &args[0];
    let cycle = v
        .get("cycleId")
        .and_then(Value::as_str)
        .filter(|s| {
            !s.is_empty()
                && s.len() <= 64
                && s.bytes()
                    .enumerate()
                    .all(|(i, c)| c.is_ascii_alphanumeric() || (i > 0 && b"._-".contains(&c)))
        })
        .ok_or("Invalid Seasonal population cycle")?
        .to_string();
    let option = |key: &str, allowed: &[&str]| -> Result<String, String> {
        v.get(key)
            .and_then(Value::as_str)
            .filter(|s| allowed.contains(s))
            .map(str::to_string)
            .ok_or_else(|| format!("Invalid Seasonal population {key}"))
    };
    let period = option("period", &["all", "90d"])?;
    let statistic = option("statistic", &["median", "trimmed_mean"])?;
    let dimension = if metrics {
        "pmc_raids".into()
    } else {
        option("dimension", &["hours", "pmc_raids"])?
    };
    let metric = v
        .get("metric")
        .and_then(Value::as_str)
        .filter(|s| METRICS.contains(s))
        .unwrap_or("players")
        .to_string();
    let bound = |key: &str| -> Result<Option<f64>, String> {
        match v.get(key) {
            None | Some(Value::Null) => Ok(None),
            Some(x) => x
                .as_f64()
                .filter(|x| x.is_finite() && *x >= 0.0)
                .map(Some)
                .ok_or_else(|| format!("Invalid Seasonal population {key}")),
        }
    };
    let min = if metrics { None } else { bound("min")? };
    let max = if metrics { None } else { bound("max")? };
    if min.zip(max).is_some_and(|(a, b)| a > b) {
        return Err("Reversed Seasonal population range".into());
    }
    let now = match v.get("now") {
        None => None,
        Some(Value::Null) if !metrics => None,
        Some(Value::Null) => Some(0.0),
        Some(x) => Some(
            x.as_f64()
                .filter(|x| x.is_finite())
                .ok_or("Invalid Seasonal population time")?,
        ),
    };
    Ok(Input {
        cycle,
        period,
        statistic,
        dimension,
        metric,
        min,
        max,
        now: if metrics {
            Some(now.unwrap_or(now_ms()?))
        } else {
            now
        },
    })
}
pub fn ready(db: &Connection) -> bool {
    db.prepare(&format!("{PORTRAIT} LIMIT 0")).is_ok()
}
fn scan(db: &mut Connection, input: &Input, budget: &mut VectorBudget) -> Result<Vec<Row>, String> {
    let tx = db.transaction().map_err(|e| e.to_string())?;
    let mut output = Vec::new();
    {
        let mut statement = tx.prepare(PORTRAIT).map_err(|e| e.to_string())?;
        let mut rows = statement
            .query([&input.cycle, &input.cycle, &input.cycle])
            .map_err(|e| e.to_string())?;
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let mut values = [f64::NAN; 23];
            for (i, value) in values.iter_mut().enumerate() {
                let raw = row.get_ref(i).map_err(|e| e.to_string())?;
                if raw == ValueRef::Null {
                    if i == 1 {
                        *value = 0.0;
                    }
                } else {
                    *value = population::sql_number(raw)?;
                }
            }
            budget.push_item(&mut output, values)?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(output)
}
fn in_period(row: &Row, input: &Input, now: f64) -> bool {
    input.period == "all" || row[1] >= (now - 90.0 * 86_400_000.0).floor()
}
fn numeric(v: f64) -> Value {
    json!(if v == 0.0 { 0.0 } else { v })
}
fn statistic(values: &mut [f64], median: bool) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    let n = values.len();
    let off = if n >= 20 {
        (n as f64 * 0.05).floor() as usize
    } else {
        0
    };
    if median || off > 0 {
        values.sort_unstable_by(f64::total_cmp);
    }
    if median {
        return Some(if n % 2 == 1 {
            values[n / 2]
        } else {
            (values[n / 2 - 1] + values[n / 2]) / 2.0
        });
    }
    Some(
        values[off..n - off]
            .iter()
            .fold(0.0, |sum, value| sum + value)
            / (n - off * 2) as f64,
    )
}
fn coordinate(input: &Input) -> usize {
    if input.dimension == "hours" { 2 } else { 4 }
}
fn metric_column(name: &str) -> Option<usize> {
    population::COLUMNS
        .iter()
        .position(|v| *v == name)
        .map(|i| COLUMNS[i])
}
fn bucket(hours: bool, value: f64) -> (f64, Option<f64>) {
    let (first, step, second, high) = if hours {
        (2000.0, 50.0, 100.0, 10000.0)
    } else {
        (1000.0, 25.0, 50.0, 3000.0)
    };
    if value >= high {
        return (high, None);
    }
    let lo = if value < first {
        (value / step).trunc() * step
    } else {
        first + ((value - first) / second).trunc() * second
    };
    (
        if lo == 0.0 { 0.0 } else { lo },
        Some(lo + if value < first { step } else { second }),
    )
}
struct Point {
    lo: f64,
    hi: Option<f64>,
    value: f64,
    order: usize,
}
fn buckets(
    rows: &[Row],
    input: &Input,
    now: f64,
    metric: &str,
    budget: &mut VectorBudget,
) -> Result<(Value, Value), String> {
    let axis = coordinate(input);
    let column = metric_column(metric);
    let mut points = Vec::new();
    let mut low: Option<f64> = None;
    let mut high: Option<f64> = None;
    for (order, row) in rows.iter().enumerate() {
        let x = row[axis];
        if !in_period(row, input, now) || !x.is_finite() {
            continue;
        }
        low = Some(low.map_or(x, |old| old.min(x)));
        high = Some(high.map_or(x, |old| old.max(x)));
        let value = column.map_or(0.0, |index| row[index]);
        if !value.is_finite() {
            continue;
        }
        let (lo, hi) = bucket(input.dimension == "hours", x);
        budget.push_item(
            &mut points,
            Point {
                lo,
                hi,
                value,
                order,
            },
        )?;
    }
    points.sort_unstable_by(|a, b| a.lo.total_cmp(&b.lo).then(a.order.cmp(&b.order)));
    let mut output = Vec::new();
    let mut begin = 0;
    while begin < points.len() {
        let mut end = begin + 1;
        while end < points.len() && points[end].lo == points[begin].lo {
            end += 1;
        }
        let n = end - begin;
        let sum = if column.is_none() {
            0.0
        } else if input.statistic == "median" {
            let mut values = Vec::new();
            for p in &points[begin..end] {
                budget.push(&mut values, p.value)?;
            }
            let median = statistic(&mut values, true).unwrap_or(0.0);
            budget.release(&values);
            median * n as f64
        } else {
            points[begin..end].iter().fold(0.0, |sum, p| sum + p.value)
        };
        budget.push_item(&mut output,json!({"lo":numeric(points[begin].lo),"hi":points[begin].hi.map(numeric),"n":n,"sum":numeric(sum)}))?;
        begin = end;
    }
    budget.release(&points);
    let bounds = low.zip(high).map_or_else(
        || json!({"min":0,"max":if input.dimension=="hours"{5000}else{1000}}),
        |(lo, hi)| json!({"min":numeric(lo.floor().max(0.0)),"max":numeric(hi.ceil())}),
    );
    Ok((Value::Array(output), bounds))
}
pub fn average(db: &mut Connection, input: &Input) -> Result<Value, String> {
    let mut budget = VectorBudget {
        used: 0,
        limit: MAX_VECTOR_BYTES,
    };
    let rows = scan(db, input, &mut budget)?;
    let now = input.now.unwrap_or(now_ms()?);
    let total = rows.iter().filter(|row| in_period(row, input, now)).count();
    let axis = coordinate(input);
    let scoped = |row: &&Row| {
        in_period(row, input, now)
            && if row[axis].is_finite() {
                input.min.is_none_or(|v| row[axis] >= v) && input.max.is_none_or(|v| row[axis] <= v)
            } else {
                input.min.is_none() && input.max.is_none()
            }
    };
    let n = rows.iter().filter(scoped).count();
    let mut averages = Map::new();
    let mut counts = Map::new();
    averages.insert("n".into(), json!(n));
    for (i, column) in population::COLUMNS.iter().enumerate() {
        let mut values = Vec::new();
        for row in rows.iter().filter(scoped) {
            let value = row[COLUMNS[i]];
            if value.is_finite() {
                budget.push(&mut values, value)?;
            }
        }
        counts.insert((*column).into(), json!(values.len()));
        averages.insert(
            (*column).into(),
            statistic(&mut values, input.statistic == "median").map_or(Value::Null, numeric),
        );
        budget.release(&values);
    }
    let (buckets, bounds) = buckets(&rows, input, now, &input.metric, &mut budget)?;
    Ok(
        json!({"available":true,"result":{"mode":"seasonal","cycleId":input.cycle,"period":input.period,"statistic":input.statistic,"dimension":input.dimension,"metric":input.metric,"total":total,"averages":if total==0{Value::Null}else{Value::Object(averages)},"metricCounts":counts,"buckets":buckets,"bounds":bounds}}),
    )
}
pub fn metrics(db: &mut Connection, input: &Input) -> Result<Value, String> {
    let mut budget = VectorBudget {
        used: 0,
        limit: MAX_VECTOR_BYTES,
    };
    let rows = scan(db, input, &mut budget)?;
    let now = input.now.unwrap_or(now_ms()?);
    let mut series = Map::new();
    for metric in OVERLAYS {
        let (values, _) = buckets(&rows, input, now, metric, &mut budget)?;
        series.insert(metric.into(), values);
    }
    Ok(
        json!({"mode":"seasonal","cycleId":input.cycle,"statistic":input.statistic,"period":input.period,"series":series}),
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bucket_edges_and_raw_bucket_sum_are_distinct_from_portrait_trim() {
        assert_eq!(bucket(true, 1999.9), (1950.0, Some(2000.0)));
        assert_eq!(bucket(true, 2000.0), (2000.0, Some(2100.0)));
        assert_eq!(bucket(false, 3000.0), (3000.0, None));
        let mut values = (0..20)
            .map(|v| if v == 19 { 10000.0 } else { v as f64 })
            .collect::<Vec<_>>();
        assert_eq!(statistic(&mut values, false), Some(9.5));
    }
    #[test]
    fn row_vector_budget_counts_actual_item_capacities_and_releases_scratch_space() {
        let mut budget = VectorBudget {
            used: 0,
            limit: size_of::<Row>() * 2,
        };
        let mut rows = Vec::new();
        budget.push_item(&mut rows, [0.0; 23]).unwrap();
        budget.push_item(&mut rows, [0.0; 23]).unwrap();
        assert!(budget.push_item(&mut rows, [0.0; 23]).is_err());
        assert_eq!(rows.len(), 2);
        assert_eq!(budget.used, rows.capacity() * size_of::<Row>());
        budget.release(&rows);
        assert_eq!(budget.used, 0);
    }
    #[test]
    fn strict_input_retains_metric_fallback_and_explicit_time() {
        let v = json!({"cycleId":"s1","period":"all","statistic":"median","dimension":"hours","metric":"unknown","now":0});
        let input = parse(&[v], false).unwrap();
        assert_eq!(input.metric, "players");
        assert_eq!(input.now, Some(0.0));
        assert!(parse(&[json!({"cycleId":"s1"})], false).is_err());
    }
}
