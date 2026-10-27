use super::{MAX_VECTOR_BYTES, METRICS, PERCENTAGES, Population, TARGET, VectorBudget, bounds};
use rusqlite::{Connection, OptionalExtension, types::Value as SqlValue};
use serde_json::{Map, Value, json};

const NORMALIZED: &str = "WITH normalized AS (
 SELECT aid,profile_updated_at,lifetime_pvp_hours AS hours,pmc_raids,
 CASE WHEN deaths IS NULL OR total_kills IS NULL THEN NULL WHEN deaths>0 THEN 1.0*total_kills/deaths ELSE total_kills END AS kd_ratio,
 CASE WHEN pmc_deaths>0 THEN 1.0*killed_pmc/pmc_deaths ELSE killed_pmc END AS pmc_kd_ratio,
 CASE WHEN total_raids>0 THEN 1.0*total_kills/total_raids END AS kills_per_raid,
 CASE WHEN pvp_stats_version=1 AND pmc_raids>0 THEN 1.0*pmc_killed_pmc/pmc_raids END AS killed_pmc_per_raid,
 CASE WHEN pmc_raids>0 THEN 100.0*pmc_survived/pmc_raids END AS pmc_survival_rate,
 longest_win_streak,level
 FROM player_profiles WHERE mode='seasonal' AND cycle_id=?1 AND confirmed_banned=0
 AND NOT EXISTS(SELECT 1 FROM excluded_players e WHERE e.aid=player_profiles.aid)
 AND lifetime_pvp_hours>0 AND pmc_raids>0 )";

pub(super) struct Input {
    aid: i64,
    cycle: String,
    dimension: String,
    median: bool,
    recent: bool,
    now: f64,
}

pub(super) fn parse(args: &[Value]) -> Result<Input, String> {
    if args.len() != 2 || !args[0].is_object() {
        return Err("Invalid Seasonal cohort arguments".into());
    }
    let value = &args[0];
    let aid = value
        .get("aid")
        .and_then(Value::as_i64)
        .filter(|aid| *aid > 0 && *aid <= 9_007_199_254_740_991)
        .ok_or("Invalid Seasonal account ID")?;
    let cycle = value
        .get("cycleId")
        .and_then(Value::as_str)
        .filter(|cycle| {
            !cycle.is_empty()
                && cycle.len() <= 64
                && cycle.bytes().enumerate().all(|(index, ch)| {
                    ch.is_ascii_alphanumeric() || (index > 0 && b"._-".contains(&ch))
                })
        })
        .ok_or("Invalid Seasonal cycle")?
        .to_string();
    let option = |key: &str, default: &str| -> Result<String, String> {
        match value.get(key) {
            None | Some(Value::Null) => Ok(default.into()),
            Some(value) => value
                .as_str()
                .map(str::to_string)
                .ok_or_else(|| "Invalid Seasonal option".into()),
        }
    };
    let dimension = option("dimension", "hours")?;
    if !["hours", "pmc_raids"].contains(&dimension.as_str()) {
        return Err("Invalid Seasonal dimension".into());
    }
    let statistic = option("statistic", "trimmed_mean")?;
    if !["median", "trimmed_mean"].contains(&statistic.as_str()) {
        return Err("Invalid Seasonal statistic".into());
    }
    let period = option("period", "all")?;
    if !["all", "90d"].contains(&period.as_str()) {
        return Err("Invalid Seasonal period".into());
    }
    let now = args[1]
        .as_f64()
        .filter(|now| now.is_finite())
        .ok_or("Seasonal computation requires explicit finite time")?;
    Ok(Input {
        aid,
        cycle,
        dimension,
        median: statistic == "median",
        recent: period == "90d",
        now,
    })
}

pub(super) fn ready(db: &Connection) -> bool {
    db.prepare(&format!(
        "{NORMALIZED} SELECT hours,pmc_raids,{} FROM normalized LIMIT 0",
        METRICS.join(",")
    ))
    .is_ok()
}

fn parameters(input: &Input) -> (String, Vec<SqlValue>) {
    let mut params = vec![
        SqlValue::Text(input.cycle.clone()),
        SqlValue::Integer(input.aid),
    ];
    let recent = if input.recent {
        params.push(SqlValue::Real((input.now - 90.0 * 86_400_000.0).floor()));
        " AND profile_updated_at>=?3"
    } else {
        ""
    };
    (format!("aid!=?2{recent}"), params)
}

fn append_range(params: &mut Vec<SqlValue>, center: (f64, f64), percent: u32) {
    let h = bounds(center.0, percent, true);
    let r = bounds(center.1, percent, false);
    params.extend([h.min, h.max, r.min, r.max].map(SqlValue::Real));
}

fn result(
    input: &Input,
    center: (f64, f64),
    percent: u32,
    population: Population,
    strategy: &str,
    reason: Option<&str>,
) -> Value {
    // Reuse the established comparison result/range math. Seasonal has its own
    // identity and deliberately publishes no percentile distributions.
    let common = super::Input {
        mode: super::Mode::Regular,
        recent: input.recent,
        hours: center.0,
        raids: center.1,
        aid: input.aid,
        dimension: input.dimension.clone(),
        median: input.median,
        player: [None; 7],
    };
    let mut answer = super::result(&common, percent, population, strategy, reason);
    answer["mode"] = json!("seasonal");
    answer["cycleId"] = json!(input.cycle);
    answer["identity"] = json!({"aid":input.aid,"mode":"seasonal","cycleId":input.cycle});
    let empty: Map<String, Value> = METRICS
        .iter()
        .map(|metric| {
            (
                (*metric).into(),
                json!({"percentile":null,"count":0,"below":0,"equal":0}),
            )
        })
        .collect();
    answer["percentiles"] = Value::Object(empty);
    answer
}

// The TS target lookup applies Number(value) after an explicit NULL check.
// Unlike Arena's strict numberOrNull, numeric strings and a one-byte SQLite
// blob (returned by Node as Uint8Array) can therefore describe a target.
fn target_number(row: &rusqlite::Row<'_>, index: usize) -> rusqlite::Result<Option<f64>> {
    use rusqlite::types::ValueRef;
    Ok(match row.get_ref(index)? {
        ValueRef::Null => None,
        ValueRef::Integer(value) => Some(value as f64),
        ValueRef::Real(value) => Some(value),
        ValueRef::Blob(bytes) => match bytes { [] => Some(0.0), [byte] => Some(f64::from(*byte)), _ => None },
        ValueRef::Text(bytes) => std::str::from_utf8(bytes).ok().and_then(|text| {
            let text=text.trim_matches(|ch:char|matches!(ch,'\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}'));
            if text.is_empty(){return Some(0.0)}
            let radix=if text.starts_with("0x")||text.starts_with("0X"){Some(16)}else if text.starts_with("0b")||text.starts_with("0B"){Some(2)}else if text.starts_with("0o")||text.starts_with("0O"){Some(8)}else{None};
            if let Some(radix)=radix{
                if text.len()==2{return None}
                text[2..].chars().try_fold(0.0,|value,ch|ch.to_digit(radix).map(|digit|value*f64::from(radix)+f64::from(digit)))
            }else{text.parse::<f64>().ok()}
        }),
    })
}
pub(super) fn compute(db: &mut Connection, input: &Input) -> Result<Value, String> {
    let tx = db.transaction().map_err(|e| e.to_string())?;
    let mut statement=tx.prepare_cached("SELECT lifetime_pvp_hours,pmc_raids FROM player_profiles WHERE mode='seasonal' AND cycle_id=? AND aid=? LIMIT 1").map_err(|e|e.to_string())?;
    let target = statement
        .query_row(rusqlite::params![input.cycle, input.aid], |row| {
            Ok((target_number(row, 0)?, target_number(row, 1)?))
        })
        .optional()
        .map_err(|e| e.to_string())?;
    drop(statement);
    let Some((Some(hours), Some(raids))) = target else {
        return Ok(json!({"available":true,"result":null}));
    };
    if !hours.is_finite() || !raids.is_finite() || hours < 0.0 || raids < 0.0 {
        return Ok(json!({"available":true,"result":null}));
    }
    let center = (hours, raids);
    if hours <= 0.0 || raids <= 0.0 {
        return Ok(
            json!({"available":true,"result":result(input,center,30,Population::empty(),"matched",Some("no_activity"))}),
        );
    }
    let (eligible, mut params) = parameters(input);
    let wide = super::range_clause(params.len() + 1);
    append_range(&mut params, center, 30);
    let first = params.len() + 1;
    let conditions=PERCENTAGES.iter().enumerate().map(|(index,percent)|{
        let first=first+index*4;append_range(&mut params,center,*percent);
        format!("SUM(CASE WHEN hours>=?{first} AND hours<=?{} AND pmc_raids>=?{} AND pmc_raids<=?{} THEN 1 ELSE 0 END)",first+1,first+2,first+3)
    }).collect::<Vec<_>>().join(",");
    let mut statement = tx
        .prepare_cached(&format!(
            "{NORMALIZED} SELECT {conditions} FROM normalized WHERE {eligible}{wide}"
        ))
        .map_err(|e| e.to_string())?;
    let counts = statement
        .query_row(rusqlite::params_from_iter(params), |row| {
            let mut counts = [0_i64; 4];
            for (index, count) in counts.iter_mut().enumerate() {
                *count = row.get::<_, Option<i64>>(index)?.unwrap_or(0);
            }
            Ok(counts)
        })
        .map_err(|e| e.to_string())?;
    drop(statement);
    let selected = counts.iter().position(|count| *count >= TARGET as i64);
    let percent = selected.map_or(30, |index| PERCENTAGES[index]);
    let (eligible, mut params) = parameters(input);
    let range = if selected.is_some() {
        let range = super::range_clause(params.len() + 1);
        append_range(&mut params, center, percent);
        range
    } else {
        String::new()
    };
    let mut statement = tx
        .prepare_cached(&format!(
            "{NORMALIZED} SELECT hours,pmc_raids,{} FROM normalized WHERE {eligible}{range}",
            METRICS.join(",")
        ))
        .map_err(|e| e.to_string())?;
    let mut rows = statement
        .query(rusqlite::params_from_iter(params))
        .map_err(|e| e.to_string())?;
    let mut population = Population::empty();
    let mut budget = VectorBudget {
        used: 0,
        limit: MAX_VECTOR_BYTES,
    };
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let h = row.get::<_, f64>(0).map_err(|e| e.to_string())?;
        let r = row.get::<_, f64>(1).map_err(|e| e.to_string())?;
        population.n += 1;
        Population::include_range(&mut population.hours, h);
        Population::include_range(&mut population.raids, r);
        for index in 0..METRICS.len() {
            if let Some(value) = row
                .get::<_, Option<f64>>(index + 2)
                .map_err(|e| e.to_string())?
            {
                budget.push(&mut population.values[index], value)?;
            }
        }
    }
    drop(rows);
    drop(statement);
    tx.commit().map_err(|e| e.to_string())?;
    Ok(
        json!({"available":true,"result":result(input,center,percent,population,if selected.is_some(){"matched"}else{"population"},None)}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn explicit_time_and_null_options_are_validated() {
        let input = parse(&[
            json!({"aid":1,"cycleId":"s1","period":"90d","now":999}),
            json!(100),
        ])
        .unwrap();
        assert_eq!(input.now, 100.0);
        assert!(input.recent);
        assert!(parse(&[json!({"aid":1,"cycleId":"s1"})]).is_err());
        assert!(
            !parse(&[json!({"aid":1,"cycleId":"s1","period":null}), json!(0)])
                .unwrap()
                .recent
        );
    }
    #[test]
    fn zero_survival_and_empty_percentiles_keep_seasonal_contract() {
        let input = parse(&[json!({"aid":1,"cycleId":"s1"}), json!(0)]).unwrap();
        let mut population = Population::empty();
        population.n = 1;
        population.values[4].push(0.0);
        let answer = result(&input, (10.0, 10.0), 30, population, "population", None);
        assert_eq!(answer["averages"]["pmc_survival_rate"]["value"], 0.0);
        assert_eq!(answer["percentiles"]["pmc_survival_rate"]["count"], 0);
        assert_eq!(answer["identity"]["cycleId"], "s1");
    }
    const SCHEMA: &str = "CREATE TABLE player_profiles(mode TEXT,cycle_id TEXT,aid INTEGER,lifetime_pvp_hours REAL,pmc_raids INTEGER,profile_updated_at INTEGER,confirmed_banned INTEGER DEFAULT 0,deaths INTEGER,total_kills INTEGER,pmc_deaths INTEGER,killed_pmc INTEGER,total_raids INTEGER,pmc_killed_pmc INTEGER,pvp_stats_version INTEGER DEFAULT 0,pmc_survived INTEGER DEFAULT 0,longest_win_streak INTEGER,level INTEGER,PRIMARY KEY(mode,cycle_id,aid));CREATE TABLE excluded_players(aid INTEGER PRIMARY KEY);";

    #[test]
    fn readiness_can_recover_after_external_schema_initialization() {
        let db = Connection::open_in_memory().unwrap();
        assert!(!ready(&db));
        db.execute_batch(SCHEMA).unwrap();
        assert!(ready(&db));
    }

    #[test]
    fn target_can_be_excluded_and_peers_preserve_cycle_time_and_unknown_deaths() {
        let mut db = Connection::open_in_memory().unwrap();
        db.execute_batch(SCHEMA).unwrap();
        db.execute_batch("INSERT INTO player_profiles(mode,cycle_id,aid,lifetime_pvp_hours,pmc_raids,profile_updated_at,confirmed_banned,deaths,total_kills,total_raids,killed_pmc,pmc_deaths,pmc_survived)VALUES('seasonal','s1',1,100,20,100,1,1,999,20,999,1,10),('seasonal','s1',2,100,20,100,0,NULL,560,20,2,0,0),('seasonal','s1',3,100,20,100,0,100,100,20,2,1,0),('seasonal','s2',2,100,20,100,0,1,999,20,999,1,10);INSERT INTO excluded_players VALUES(1);").unwrap();
        let input = parse(&[json!({"aid":1,"cycleId":"s1"}), json!(100)]).unwrap();
        let result = compute(&mut db, &input).unwrap();
        assert_eq!(result["result"]["n"], 2);
        assert_eq!(
            result["result"]["averages"]["kd_ratio"],
            json!({"value":1.0,"count":1})
        );
        assert_eq!(
            result["result"]["averages"]["pmc_survival_rate"],
            json!({"value":0.0,"count":2})
        );
        assert_eq!(result["result"]["averages"]["pmc_kd_ratio"]["value"], 2.0);
        let input = parse(&[
            json!({"aid":1,"cycleId":"s1","period":"90d","now":100}),
            json!(100000000000_i64),
        ])
        .unwrap();
        assert_eq!(compute(&mut db, &input).unwrap()["result"]["n"], 0);
    }

    #[test]
    fn malformed_target_is_unavailable_without_disabling_healthy_peers() {
        let mut db = Connection::open_in_memory().unwrap();
        db.execute_batch(SCHEMA).unwrap();
        db.execute_batch("INSERT INTO player_profiles(mode,cycle_id,aid,lifetime_pvp_hours,pmc_raids,profile_updated_at)VALUES('seasonal','s1',1,'bad',20,100);").unwrap();
        let input = parse(&[json!({"aid":1,"cycleId":"s1"}), json!(100)]).unwrap();
        assert_eq!(
            compute(&mut db, &input).unwrap(),
            json!({"available":true,"result":null})
        );
        db.execute_batch("UPDATE player_profiles SET lifetime_pvp_hours=' ' WHERE aid=1")
            .unwrap();
        assert_eq!(
            compute(&mut db, &input).unwrap()["result"]["reason"],
            "no_activity"
        );
        db.execute_batch("UPDATE player_profiles SET lifetime_pvp_hours=X'31' WHERE aid=1")
            .unwrap();
        assert_eq!(
            compute(&mut db, &input).unwrap()["result"]["axes"]["hours"]["center"],
            49.0
        );
        db.execute_batch("UPDATE player_profiles SET lifetime_pvp_hours='0x10' WHERE aid=1")
            .unwrap();
        assert_eq!(
            compute(&mut db, &input).unwrap()["result"]["axes"]["hours"]["center"],
            16.0
        );
    }
    #[test]
    fn target_raids_use_the_same_number_conversion_as_hours() {
        let mut db = Connection::open_in_memory().unwrap();
        db.execute_batch(SCHEMA).unwrap();
        db.execute_batch("INSERT INTO player_profiles(mode,cycle_id,aid,lifetime_pvp_hours,pmc_raids,profile_updated_at)VALUES('seasonal','s1',1,100,'',100);").unwrap();
        let input = parse(&[json!({"aid":1,"cycleId":"s1"}), json!(100)]).unwrap();
        assert_eq!(
            compute(&mut db, &input).unwrap()["result"]["reason"],
            "no_activity"
        );
        db.execute_batch("UPDATE player_profiles SET pmc_raids='unknown' WHERE aid=1")
            .unwrap();
        assert_eq!(
            compute(&mut db, &input).unwrap(),
            json!({"available":true,"result":null})
        );
        db.execute_batch("UPDATE player_profiles SET pmc_raids=X'31' WHERE aid=1")
            .unwrap();
        assert_eq!(
            compute(&mut db, &input).unwrap()["result"]["axes"]["pmcRaids"]["center"],
            49.0
        );
    }
}
