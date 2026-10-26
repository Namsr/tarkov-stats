use crate::{arena::number_key, config::Config, storage::Storage};
use axum::{
    Json,
    extract::{RawQuery, State},
    http::{HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
};
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde_json::{Value, json};
use std::{collections::HashMap, env, time::Duration};

const REFRESH_MS: f64 = 6.0 * 60.0 * 60_000.0;
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;

pub struct Published {
    pub value: Value,
    pub generated_at: f64,
    pub stale: bool,
}

// Match the existing publication identity guard. These are scheduled public
// snapshots: this reader never initializes storage or starts a history scan.
fn valid(value: &Value, mode: &str, cycle: &str) -> bool {
    value.get("mode").and_then(Value::as_str) == Some(mode)
        && value.get("cycleId").and_then(Value::as_str) == Some(cycle)
        && value.get("series").is_some_and(|series| match series {
            Value::Null => false,
            Value::Bool(value) => *value,
            Value::Number(value) => value.as_f64().is_some_and(|n| n != 0.0),
            Value::String(value) => !value.is_empty(),
            Value::Array(_) | Value::Object(_) => true,
        })
}

// Called only by the existing bounded storage thread; no unbounded blocking
// tasks, persistent history handles, migrations, or writes are introduced.
fn open() -> Option<Connection> {
    let path = ["PROGRESSION_SQLITE_PATH", "PROGRESSION_DB_PATH"]
        .into_iter()
        .find_map(|key| env::var(key).ok().filter(|value| !value.is_empty()))
        .unwrap_or_else(|| "/data/progression.db".into());
    let db = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()?;
    db.busy_timeout(Duration::from_millis(100)).ok()?;
    Some(db)
}
pub fn read(mode: &str, cycle: &str, now: i64) -> Option<Published> {
    read_from(&open()?, mode, cycle, now)
}

fn read_from(db: &Connection, mode: &str, cycle: &str, now: i64) -> Option<Published> {
    let row: Option<(f64, String)> = db
        .prepare_cached(
            "SELECT g.generated_at, substr(json_extract(g.payload, '$.average'),1,1048577)
         FROM progression_population_current c JOIN progression_population_generations g
         ON g.mode=c.mode AND g.cycle_id=c.cycle_id AND g.generation=c.generation
         WHERE c.mode=?1 AND c.cycle_id=?2",
        )
        .ok()?
        .query_row([mode, cycle], |row| {
            if let rusqlite::types::ValueRef::Integer(value) = row.get_ref(0)?
                && !(-9_007_199_254_740_991..=9_007_199_254_740_991).contains(&value)
            {
                return Err(rusqlite::Error::IntegralValueOutOfRange(0, value));
            }
            Ok((row.get(0)?, row.get(1)?))
        })
        .optional()
        .ok()?;
    let (generated_at, text) = row?;
    if !generated_at.is_finite() || text.len() > MAX_RESPONSE_BYTES {
        return None;
    }
    let value: Value = serde_json::from_str(&text).ok()?;
    valid(&value, mode, cycle).then_some(Published {
        value,
        generated_at,
        stale: now as f64 - generated_at >= REFRESH_MS,
    })
}

// Read only the compact published baseline on the bounded storage thread.
// The source requires truthy metrics and an array riskBaselines for a valid
// population publication; do not accept an arbitrary standalone baseline.
pub fn read_achievement_baseline(cycle: &str, now: i64) -> Option<Value> {
    let db = open()?;
    read_achievement_baseline_from(&db, cycle, now)
}
fn read_achievement_baseline_from(db: &Connection, cycle: &str, now: i64) -> Option<Value> {
    let row=db.prepare_cached("SELECT g.generation,g.generated_at,substr(json_extract(g.payload,'$.achievementBaseline'),1,1048577),json_extract(g.payload,'$.metrics'),json_type(g.payload,'$.riskBaselines') FROM progression_population_current c JOIN progression_population_generations g ON g.mode=c.mode AND g.cycle_id=c.cycle_id AND g.generation=c.generation WHERE c.mode='seasonal' AND c.cycle_id=?").ok()?.query_row([cycle],|row|{
        for index in 0..5 {if let rusqlite::types::ValueRef::Integer(n)=row.get_ref(index)? && !(-9_007_199_254_740_991..=9_007_199_254_740_991).contains(&n){return Err(rusqlite::Error::IntegralValueOutOfRange(index,n));}}
        let metrics=match row.get_ref(3)? {rusqlite::types::ValueRef::Null=>false,rusqlite::types::ValueRef::Integer(n)=>n!=0,rusqlite::types::ValueRef::Real(n)=>n!=0.0,rusqlite::types::ValueRef::Text(v)=>!v.is_empty(),_=>false};
        Ok((row.get::<_,f64>(0)?,row.get::<_,f64>(1)?,row.get::<_,String>(2)?,metrics,row.get::<_,String>(4)?))
    }).optional().ok()??;
    if !row.0.is_finite()
        || !row.1.is_finite()
        || row.2.len() > MAX_RESPONSE_BYTES
        || !row.3
        || row.4 != "array"
    {
        return None;
    }
    crate::achievements::parse_seasonal(&serde_json::from_str::<Value>(&row.2).ok()?, now)
}

#[derive(Clone)]
pub struct ProgressionService {
    storage: Storage,
    config: Config,
}
impl ProgressionService {
    pub fn new(storage: Storage, config: Config) -> Self {
        Self { storage, config }
    }
    pub async fn load(&self, mode: &str, cycle: &str, now: i64) -> Option<Published> {
        if let Some(published) = self
            .storage
            .progression(mode.into(), cycle.into(), now)
            .await
        {
            return Some(published);
        }
        let key = match mode {
            "seasonal" => format!(
                "statistics-v1:{}",
                json!(["average-progression-seasonal-v2", cycle])
            ),
            "pve" => "statistics-v1:average-progression-pve-v1".into(),
            "regular" => "statistics-v1:average-progression-regular-v2".into(),
            _ => return None,
        };
        let saved = self.storage.read(key).await?;
        let value = saved.get("value")?;
        let generated_at = saved
            .get("generatedAt")?
            .as_f64()
            .filter(|v| v.is_finite())?;
        valid(value, mode, cycle).then(|| Published {
            value: value.clone(),
            generated_at,
            stale: true,
        })
    }
    pub async fn response(&self, raw: &str, now: i64) -> Response {
        let mut params = HashMap::<String, Vec<String>>::new();
        for (name, value) in url::form_urlencoded::parse(raw.as_bytes()) {
            params
                .entry(name.into_owned())
                .or_default()
                .push(value.into_owned());
        }
        let first = |key: &str| {
            params
                .get(key)
                .and_then(|values| values.first())
                .map(String::as_str)
        };
        let mode = first("mode").unwrap_or("regular");
        let cycle = if mode == "seasonal" {
            let configured = self.config.cycle.as_deref().unwrap_or("");
            if !self.config.ready(configured, now) {
                return error(404, "Seasonal progression unavailable", false);
            }
            let cycle = first("cycle").unwrap_or("");
            if cycle != configured || params.get("cycle").map(Vec::len) != Some(1) {
                return error(400, "Invalid Seasonal cycle", false);
            }
            cycle
        } else if mode == "regular" || mode == "pve" {
            // Legacy persistent callers ignore cycle/unknown/duplicate extras.
            "persistent"
        } else {
            return error(400, "Invalid progression mode", false);
        };
        let Some(published) = self.load(mode, cycle, now).await else {
            return error(503, "Progression averages are warming", true);
        };
        let headers = HeaderMap::from_iter([
            (
                axum::http::header::CACHE_CONTROL,
                HeaderValue::from_static("no-store"),
            ),
            (
                axum::http::HeaderName::from_static("x-statistics-stale"),
                HeaderValue::from_static("0"),
            ),
            (
                axum::http::HeaderName::from_static("x-statistics-generated-at"),
                HeaderValue::from_str(&number_key(published.generated_at))
                    .expect("finite timestamp"),
            ),
            (
                axum::http::HeaderName::from_static("x-average-stale"),
                HeaderValue::from_static(if published.stale { "1" } else { "0" }),
            ),
        ]);
        (headers, Json(published.value)).into_response()
    }
}
fn error(status: u16, message: &str, warming: bool) -> Response {
    let mut response = (
        StatusCode::from_u16(status).unwrap(),
        Json(json!({"error":message})),
    )
        .into_response();
    if warming {
        response
            .headers_mut()
            .insert("retry-after", HeaderValue::from_static("5"));
        response
            .headers_mut()
            .insert("cache-control", HeaderValue::from_static("no-store"));
    }
    response
}
pub async fn get(State(service): State<ProgressionService>, RawQuery(raw): RawQuery) -> Response {
    service
        .response(raw.as_deref().unwrap_or(""), crate::now_ms())
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE progression_population_current(mode TEXT,cycle_id TEXT,generation INTEGER);
          CREATE TABLE progression_population_generations(mode TEXT,cycle_id TEXT,generation INTEGER,generated_at INTEGER,payload TEXT);
          INSERT INTO progression_population_current VALUES('pve','persistent',2);").unwrap();
        db
    }
    #[test]
    fn reads_only_current_average_and_preserves_freshness_boundary() {
        let db = fixture();
        let value = json!({"mode":"pve","cycleId":"persistent","axis":"pmc_raids","series":{"cumulative":{"overall":[]}}});
        let payload = json!({"average":value,"unrelatedPrivateHistory":[1,2,3]}).to_string();
        db.execute(
            "INSERT INTO progression_population_generations VALUES('pve','persistent',2,1000,?1)",
            [payload],
        )
        .unwrap();
        let published = read_from(&db, "pve", "persistent", 1000 + REFRESH_MS as i64 - 1).unwrap();
        assert_eq!(published.value, value);
        assert!(!published.stale);
        assert!(
            read_from(&db, "pve", "persistent", 1000 + REFRESH_MS as i64)
                .unwrap()
                .stale
        );
        assert!(read_from(&db, "regular", "persistent", 1000).is_none());
    }
    #[test]
    fn missing_or_wrong_generation_identity_and_corrupt_projection_are_unavailable() {
        let db = fixture();
        assert!(read_from(&db, "pve", "persistent", 1000).is_none());
        for payload in [
            "{}",
            "not-json",
            r#"{"average":{"mode":"regular","cycleId":"persistent","series":{}}}"#,
            r#"{"average":{"mode":"pve","cycleId":"old","series":{}}}"#,
            r#"{"average":{"mode":"pve","cycleId":"persistent","series":null}}"#,
        ] {
            db.execute("DELETE FROM progression_population_generations", [])
                .unwrap();
            db.execute("INSERT INTO progression_population_generations VALUES('pve','persistent',2,1000,?1)",[payload]).unwrap();
            assert!(
                read_from(&db, "pve", "persistent", 1000).is_none(),
                "{payload}"
            );
        }
    }
    #[test]
    fn seasonal_baseline_uses_current_compact_publication_and_zero_unlock_hours() {
        let db = fixture();
        db.execute(
            "INSERT INTO progression_population_current VALUES('seasonal','s1',2)",
            [],
        )
        .unwrap();
        let payload = json!({"metrics":{},"riskBaselines":[],"achievementBaseline":{"eligibleN":10,"achievements":[{"id":"zero","owners":2,"samplePct":20,"meanHours":90,"stdHours":0,"earlyHours":5,"unlockHours":0},{"id":"fallback","owners":1,"samplePct":10,"meanHours":20,"stdHours":0,"earlyHours":null}]}});
        db.execute(
            "INSERT INTO progression_population_generations VALUES('seasonal','s1',2,1000,?1)",
            [payload.to_string()],
        )
        .unwrap();
        let value = read_achievement_baseline_from(&db, "s1", 5000).unwrap();
        assert_eq!(value["total"], 10.0);
        assert_eq!(value["rows"][0]["unlockHours"], 0.0);
        assert_eq!(value["rows"][1]["earlyHours"], 20.0);
        assert_eq!(value["rows"][1]["unlockHours"], 20.0);
        assert!(read_achievement_baseline_from(&db, "s2", 5000).is_none());
        let mut corrupt = payload.clone();
        corrupt["riskBaselines"] = json!({});
        db.execute(
            "UPDATE progression_population_generations SET payload=?1",
            [corrupt.to_string()],
        )
        .unwrap();
        assert!(read_achievement_baseline_from(&db, "s1", 5000).is_none());
        db.execute("UPDATE progression_population_generations SET payload=?1,generated_at=9007199254740993",[payload.to_string()]).unwrap();
        assert!(read_achievement_baseline_from(&db, "s1", 5000).is_none());
    }
}
