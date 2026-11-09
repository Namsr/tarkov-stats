use crate::{
    arena,
    cache::Cache,
    compute::{Computed, Failure},
    reference::{Mode, Reference},
    storage::Storage,
};
use axum::{
    extract::{RawQuery, State},
    http::{HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Instant,
};

// JSON.parse followed by JavaScript Number(). Missing properties remain invalid,
// whereas explicit null/boolean/radix strings and one-element arrays coerce.
pub fn number(value: &Value) -> Option<f64> {
    match value {
        Value::Null => Some(0.0),
        Value::Bool(value) => Some(if *value { 1.0 } else { 0.0 }),
        Value::Number(value) => value.as_f64().filter(|value| value.is_finite()),
        Value::String(value) => arena::number(value),
        Value::Array(_) => arena::number(&primitive_string(value)?),
        _ => None,
    }
}
fn primitive_string(value: &Value) -> Option<String> {
    match value {
        Value::Null => Some(String::new()),
        Value::Bool(value) => Some(value.to_string()),
        Value::String(value) => Some(value.clone()),
        Value::Number(value) => value
            .as_f64()
            .filter(|value| value.is_finite())
            .map(arena::number_key),
        Value::Array(values) => values
            .iter()
            .map(primitive_string)
            .collect::<Option<Vec<_>>>()
            .map(|values| values.join(",")),
        _ => None,
    }
}
fn nonnegative(value: Option<&Value>) -> Option<f64> {
    number(value?).filter(|value| *value >= 0.0)
}
pub fn parse_published(row: &Value, now: i64) -> Option<Value> {
    let mode = row.get("mode")?.as_str()?;
    if !["regular", "pve"].contains(&mode) {
        return None;
    }
    number(row.get("generation")?)?;
    number(row.get("generated_at")?)?;
    let total = nonnegative(row.get("total"))?;
    let entries = row.get("achievements")?.as_array()?;
    let mut rows = Vec::with_capacity(entries.len());
    for entry in entries {
        let id = entry
            .get("ach_id")?
            .as_str()
            .filter(|value| !value.is_empty())?;
        let owners = nonnegative(entry.get("owners"))?;
        let mean = nonnegative(entry.get("meanHours"))?;
        let std = nonnegative(entry.get("stdHours"))?;
        let early = nonnegative(entry.get("earlyHours"))?;
        let unlock = nonnegative(
            entry
                .get("unlockHours")
                .filter(|value| !value.is_null())
                .or_else(|| entry.get("earlyHours")),
        )?;
        rows.push(json!({"id":id,"owners":owners,"samplePct":if total>0.0{owners/total*100.0}else{0.0},"meanHours":mean,"stdHours":std,"earlyHours":early,"unlockHours":unlock}));
    }
    // Stable sort: equal owner counts retain the publication array order.
    rows.sort_by(|left, right| {
        right["owners"]
            .as_f64()
            .unwrap()
            .partial_cmp(&left["owners"].as_f64().unwrap())
            .unwrap()
    });
    Some(json!({"total":total,"rows":rows,"ts":now,"storage":"sqlite"}))
}
pub fn valid_baseline(value: &Value, job: &Value) -> bool {
    job.get("kind").and_then(Value::as_str) == Some("achievement_baseline")
        && matches!(
            job.get("mode").and_then(Value::as_str),
            Some("regular" | "pve")
        )
        && value.get("storage").and_then(Value::as_str) == Some("sqlite")
        && nonnegative(value.get("total")).is_some()
        && value
            .get("ts")
            .and_then(Value::as_f64)
            .is_some_and(f64::is_finite)
        && value
            .get("rows")
            .and_then(Value::as_array)
            .is_some_and(|rows| {
                rows.iter().all(|row| {
                    row.get("id")
                        .and_then(Value::as_str)
                        .is_some_and(|id| !id.is_empty())
                        && [
                            "owners",
                            "meanHours",
                            "stdHours",
                            "earlyHours",
                            "unlockHours",
                        ]
                        .iter()
                        .all(|field| {
                            row.get(*field)
                                .and_then(Value::as_f64)
                                .is_some_and(|value| value.is_finite() && value >= 0.0)
                        })
                        && row.get("samplePct").is_some_and(|value| {
                            value.is_null()
                                || value
                                    .as_f64()
                                    .is_some_and(|value| value.is_finite() && value >= 0.0)
                        })
                })
            })
}
#[derive(Clone)]
pub struct AchievementsService {
    cache: Cache,
    storage: Storage,
    reference: Reference,
}
pub struct AchievementResponse {
    pub status: StatusCode,
    pub body: Value,
    pub headers: HeaderMap,
    pub mode: Option<String>,
    pub storage: Option<&'static str>,
    pub memo: Option<&'static str>,
    pub baseline_ms: Option<u64>,
    pub metadata_ms: Option<u64>,
    pub store_open_ms: Option<u64>,
    pub outcome: &'static str,
}
impl AchievementResponse {
    fn error(status: u16, message: &str, mode: Option<String>) -> Self {
        let mut headers = HeaderMap::new();
        headers.insert("cache-control", HeaderValue::from_static("no-store"));
        Self {
            status: StatusCode::from_u16(status).unwrap(),
            body: json!({"error":message}),
            headers,
            mode,
            storage: None,
            memo: None,
            baseline_ms: None,
            metadata_ms: None,
            store_open_ms: None,
            outcome: if status == 400 {
                "invalid"
            } else if status == 404 {
                "not_found"
            } else {
                "error"
            },
        }
    }
}
impl IntoResponse for AchievementResponse {
    fn into_response(mut self) -> Response {
        arena::normalize_zero(&mut self.body);
        let mut response = (self.status, axum::Json(self.body)).into_response();
        response
            .headers_mut()
            .insert("content-type", HeaderValue::from_static("application/json"));
        response.headers_mut().extend(self.headers);
        response
    }
}
impl AchievementsService {
    pub fn new(cache: Cache, storage: Storage, reference: Reference) -> Self {
        Self {
            cache,
            storage,
            reference,
        }
    }
    pub async fn load(&self, mode: &str, now: i64) -> AchievementResponse {
        if !["regular", "pve", "arena"].contains(&mode) {
            return AchievementResponse::error(400, "Invalid game mode", None);
        }
        let started = Instant::now();
        let storage = self.storage.clone();
        let selected = mode.to_owned();
        let key = format!("achievement-baseline:{mode}");
        let observation = Arc::new(Mutex::new(None));
        let observed = observation.clone();
        let baseline = self
            .cache
            .load_with(
                key.clone(),
                key,
                json!({"kind":"achievement_baseline","mode":mode,"args":[mode]}),
                now,
                async move {
                    let read = storage
                        .achievement_baseline(selected, now)
                        .await
                        .ok_or_else(|| Failure {
                            reason: "achievement_storage_unavailable",
                            message: "Achievement baseline is unavailable".into(),
                        })?;
                    *observed.lock().unwrap() = Some(read.store_open_ms);
                    if read.error {
                        return Err(Failure {
                            reason: "calculation_error",
                            message: "Achievement publication query failed".into(),
                        });
                    }
                    let value = read.value.ok_or_else(|| Failure {
                        reason: "achievement_storage_unavailable",
                        message: "Achievement baseline is unavailable".into(),
                    })?;
                    Ok(Computed {
                        value,
                        queue_ms: 0,
                        worker_ms: 0,
                    })
                },
            )
            .await;
        let elapsed = started.elapsed().as_millis() as u64;
        let loaded = match baseline {
            Ok(value) => value,
            Err(error) => {
                let mut response = AchievementResponse::error(
                    if error.reason == "achievement_storage_unavailable" {
                        503
                    } else {
                        500
                    },
                    "Failed to compute achievement baseline",
                    None,
                );
                response.store_open_ms = *observation.lock().unwrap();
                return response;
            }
        };
        let started = Instant::now();
        let reference = self.reference.clone();
        let key = "achievement-metadata:regular".to_string();
        let metadata = self
            .cache
            .load_with(
                key.clone(),
                key,
                json!({"kind":"achievement_metadata","mode":"regular","args":["regular"]}),
                crate::now_ms(),
                async move {
                    Ok(Computed {
                        value: reference.get(Mode::Regular).await,
                        queue_ms: 0,
                        worker_ms: 0,
                    })
                },
            )
            .await
            .ok();
        let metadata_ms = started.elapsed().as_millis() as u64;
        let meta: HashMap<&str, &Value> = metadata
            .as_ref()
            .and_then(|value| value.value.as_array())
            .map(|entries| {
                entries
                    .iter()
                    .filter_map(|entry| Some((entry.get(0)?.as_str()?, entry.get(1)?)))
                    .collect()
            })
            .unwrap_or_default();
        let rows = loaded.value["rows"]
            .as_array()
            .expect("validated baseline rows");
        let achievements:Vec<Value>=rows.iter().map(|row|{
            let id=row["id"].as_str().unwrap();let metadata=meta.get(id).copied();
            let field=|name:&str|metadata.and_then(|value|value.get(name)).cloned().unwrap_or(Value::Null);
            json!({"id":id,"name":metadata.and_then(|value|value.get("name")).and_then(Value::as_str).unwrap_or(id),"nameRu":field("nameRu"),"description":field("descriptionEn"),"descriptionRu":field("descriptionRu"),"imageUrl":crate::reference::image(metadata.and_then(|value|value.get("imageUrl"))),"side":metadata.and_then(|value|value.get("side")).and_then(Value::as_str).unwrap_or(""),"rarity":metadata.and_then(|value|value.get("rarity")).and_then(Value::as_str).unwrap_or(""),"owners":row["owners"],"samplePct":row["samplePct"],"officialPct":metadata.and_then(|value|value.get("playersCompletedPercent")).cloned().unwrap_or(json!(0)),"meanHours":row["meanHours"],"stdHours":row["stdHours"],"earlyHours":row["earlyHours"],"unlockHours":row["unlockHours"]})
        }).collect();
        let stale = loaded.stale || metadata.as_ref().is_none_or(|value| value.stale);
        let mut headers = HeaderMap::new();
        headers.insert("cache-control", HeaderValue::from_static("no-store"));
        headers.insert(
            "x-statistics-stale",
            HeaderValue::from_static(if stale { "1" } else { "0" }),
        );
        headers.insert(
            "x-statistics-generated-at",
            HeaderValue::from_str(&arena::number_key(loaded.generated_at)).unwrap(),
        );
        if stale {
            headers.insert("retry-after", HeaderValue::from_static("5"));
        }
        AchievementResponse {
            status: StatusCode::OK,
            body: json!({"total":loaded.value["total"],"achievements":achievements}),
            headers,
            mode: Some(mode.into()),
            storage: Some("sqlite"),
            memo: Some(loaded.cache),
            baseline_ms: Some(elapsed),
            metadata_ms: Some(metadata_ms),
            store_open_ms: *observation.lock().unwrap(),
            outcome: "success",
        }
    }
    fn record(&self, response: &AchievementResponse, headers: &HeaderMap, elapsed: u64) {
        // Preserve the source route's catch timing: it records500 even for the
        // AchievementBaselineUnavailableError whose actual HTTP status is503.
        let status = if response.status == StatusCode::SERVICE_UNAVAILABLE {
            500
        } else {
            response.status.as_u16()
        };
        let stage = match response.outcome {
            "success" => None,
            "invalid" => Some("request"),
            "not_found" => Some("application"),
            _ => Some("application"),
        };
        let mut event = json!({"event":"request_timing_v1","entry":"api","at":crate::now_ms(),"pid":std::process::id(),"operation":"average_achievements","outcome":response.outcome,"status":status,"total_ms":elapsed});
        if let Some(mode) = &response.mode {
            event["mode"] = json!(mode);
        }
        if let Some(storage) = response.storage {
            event["storage"] = json!(storage);
        }
        if let Some(memo) = response.memo {
            event["memo"] = json!(memo);
        }
        for (field, value) in [
            ("baseline_ms", response.baseline_ms),
            ("metadata_ms", response.metadata_ms),
            ("store_open_ms", response.store_open_ms),
        ] {
            if let Some(value) = value {
                event[field] = json!(value);
            }
        }
        if let Some(stage) = stage {
            event["failure_stage"] = json!(stage);
            event["error_code"] = json!(format!(
                "average_achievements_{}_{status}",
                response.outcome
            ));
        }
        if let Some(host) = headers
            .get("x-forwarded-host")
            .or_else(|| headers.get("host"))
            .and_then(|value| value.to_str().ok())
            .and_then(arena::normalized_host)
        {
            event["host"] = json!(host);
        }
        if elapsed >= 1000 {
            event["slow"] = json!(true);
        }
        if elapsed >= 1000 || arena::sampled() {
            crate::log_json(&event);
        }
        self.storage.event(event);
    }
}
pub async fn get(
    State(service): State<AchievementsService>,
    RawQuery(raw): RawQuery,
    headers: HeaderMap,
) -> Response {
    let started = Instant::now();
    let raw = raw.unwrap_or_default();
    let mode = url::form_urlencoded::parse(raw.as_bytes())
        .find(|(name, _)| name == "mode")
        .map_or_else(|| "regular".to_string(), |(_, value)| value.into_owned());
    let response = if mode == "seasonal" {
        AchievementResponse::error(404, "Seasonal average unavailable", Some(mode))
    } else {
        service.load(&mode, crate::now_ms()).await
    };
    service.record(&response, &headers, started.elapsed().as_millis() as u64);
    response.into_response()
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn publication_parser_preserves_zero_fallback_coercion_and_owner_tie_order() {
        let row = json!({"mode":"pve","generation":"0x10","generated_at":null,"total":"10","achievements":[{"ach_id":"first","owners":2,"meanHours":100,"stdHours":0,"earlyHours":0},{"ach_id":"second","owners":"2","meanHours":"50","stdHours":true,"earlyHours":5,"unlockHours":null}]});
        let value = parse_published(&row, 100).unwrap();
        assert_eq!(value["rows"][0]["id"], "first");
        assert_eq!(value["rows"][0]["unlockHours"], 0.0);
        assert_eq!(value["rows"][1]["unlockHours"], 5.0);
        assert_eq!(value["rows"][0]["samplePct"], 20.0);
        assert_eq!(value["rows"][1]["stdHours"], 1.0);
    }
    #[test]
    fn malformed_publication_never_becomes_a_successful_empty_baseline() {
        let mut row = json!({"mode":"pve","generation":1,"generated_at":1,"total":10,"achievements":[{"ach_id":"id","owners":1,"meanHours":2,"stdHours":0,"earlyHours":1}]});
        assert!(parse_published(&row, 10).is_some());
        row["achievements"][0]["stdHours"] = json!("unknown");
        assert!(parse_published(&row, 10).is_none());
        assert_eq!(number(&json!([])), Some(0.0));
        assert_eq!(number(&json!(["0x10"])), Some(16.0));
        assert_eq!(number(&json!({})), None);
    }
}
