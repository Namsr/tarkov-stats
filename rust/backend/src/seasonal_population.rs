//! Seasonal population HTTP: published standards, bounded dynamic calculations,
//! and the same durable cache values/keys as the existing TypeScript routes.
use crate::{
    arena,
    cache::Cache,
    config::{self, Config},
    persistent::{self, PersistentResponse},
    storage::{PublicationScope, Storage},
};
use axum::{
    extract::{RawQuery, State},
    http::{HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    sync::{Arc, Mutex},
    time::Instant,
};

#[derive(Clone, Debug)]
pub struct Query {
    pub cycle: String,
    pub statistic: String,
    pub period: String,
    pub dimension: String,
    pub metric: String,
    pub min: Option<f64>,
    pub max: Option<f64>,
}
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
fn params(raw: &str) -> Vec<(String, String)> {
    url::form_urlencoded::parse(raw.as_bytes())
        .into_owned()
        .collect()
}
fn first<'a>(values: &'a [(String, String)], name: &str) -> Option<&'a str> {
    values
        .iter()
        .find(|(key, _)| key == name)
        .map(|(_, v)| v.as_str())
}
impl Query {
    pub fn parse(raw: &str, cycle: &str, metrics: bool) -> Result<Self, &'static str> {
        if raw.len() > 65536 {
            return Err(if metrics {
                "Invalid metric series query"
            } else {
                "Invalid range"
            });
        }
        let values = params(raw);
        let get = |name: &str| first(&values, name);
        if metrics {
            let mut seen = HashSet::new();
            if get("mode") != Some("seasonal")
                || values.iter().any(|(k, _)| {
                    !["mode", "cycle", "period", "statistic"].contains(&k.as_str())
                        || !seen.insert(k)
                })
            {
                return Err("Invalid metric series query");
            }
        }
        if metrics
            && (get("statistic").is_some_and(|v| !["median", "trimmed_mean"].contains(&v))
                || get("period").is_some_and(|v| !["all", "90d"].contains(&v)))
        {
            return Err("Invalid metric series query");
        }
        let selected = get("cycle").map(config::trim).unwrap_or("");
        if selected.is_empty()
            || selected != cycle
            || values.iter().filter(|(k, _)| k == "cycle").count() != 1
        {
            return Err(if metrics {
                "Invalid cycle"
            } else {
                "Invalid Seasonal cycle"
            });
        }
        let statistic = get("statistic").unwrap_or("trimmed_mean");
        let period = get("period").unwrap_or("all");
        if !["median", "trimmed_mean"].contains(&statistic) {
            return Err(if metrics {
                "Invalid metric series query"
            } else {
                "Invalid statistic"
            });
        }
        if !["all", "90d"].contains(&period) {
            return Err(if metrics {
                "Invalid metric series query"
            } else {
                "Invalid period"
            });
        }
        let dimension = get("dimension").unwrap_or("hours");
        if !["hours", "pmc_raids"].contains(&dimension) {
            return Err("Invalid dimension");
        }
        let bound = |key: &str| -> Result<Option<f64>, &'static str> {
            get(key)
                .filter(|v| !v.is_empty())
                .map(|v| {
                    arena::number(v)
                        .filter(|v| *v >= 0.0)
                        .ok_or("Invalid range")
                })
                .transpose()
        };
        let min = bound("min")?;
        let max = bound("max")?;
        if min.zip(max).is_some_and(|(a, b)| a > b) {
            return Err("Invalid range");
        }
        Ok(Self {
            cycle: selected.into(),
            statistic: statistic.into(),
            period: period.into(),
            dimension: dimension.into(),
            metric: get("metric")
                .filter(|m| METRICS.contains(m))
                .unwrap_or("players")
                .into(),
            min,
            max,
        })
    }
    pub fn job(&self, metrics: bool) -> Value {
        let input = if metrics {
            json!({"cycleId":self.cycle,"period":self.period,"statistic":self.statistic})
        } else {
            json!({"cycleId":self.cycle,"period":self.period,"statistic":self.statistic,"dimension":self.dimension,"metric":self.metric,"min":self.min,"max":self.max})
        };
        json!({"kind":if metrics{"seasonal_metrics"}else{"seasonal_average"},"args":[input]})
    }
    pub fn standard(&self) -> bool {
        self.dimension == "hours"
            && self.metric == "players"
            && self.min.is_none()
            && self.max.is_none()
    }
    fn fallback_key(&self, metrics: bool) -> String {
        persistent::json_key(&if metrics {
            json!([
                "metric-series-v1",
                "seasonal",
                self.cycle,
                self.statistic,
                self.period
            ])
        } else {
            json!([
                "seasonal",
                self.cycle,
                self.period,
                self.statistic,
                self.dimension,
                self.metric,
                self.min,
                self.max
            ])
        })
    }
}
fn count(value: Option<&Value>) -> bool {
    value.and_then(Value::as_f64).is_some_and(|n| {
        n.is_finite() && (0.0..=9007199254740991.0).contains(&n) && n.fract() == 0.0
    })
}
fn finite(value: Option<&Value>) -> bool {
    value.and_then(Value::as_f64).is_some_and(f64::is_finite)
}
fn nullable(value: Option<&Value>) -> bool {
    value.is_some_and(|v| v.is_null() || finite(Some(v)))
}
fn buckets(value: Option<&Value>) -> bool {
    value.and_then(Value::as_array).is_some_and(|rows| {
        rows.iter().all(|r| {
            finite(r.get("lo"))
                && nullable(r.get("hi"))
                && count(r.get("n"))
                && nullable(r.get("sum"))
        })
    })
}
fn input(job: &Value) -> Option<&Value> {
    let args = job.get("args")?.as_array()?;
    if args.len() != 1 {
        return None;
    }
    let v = &args[0];
    config::cycle(v.get("cycleId")?.as_str()?)?;
    if !matches!(v.get("statistic")?.as_str()?, "median" | "trimmed_mean")
        || !matches!(v.get("period")?.as_str()?, "all" | "90d")
    {
        return None;
    }
    if job.get("kind").and_then(Value::as_str) == Some("seasonal_average") {
        if !matches!(v.get("dimension")?.as_str()?, "hours" | "pmc_raids")
            || !METRICS.contains(&v.get("metric")?.as_str()?)
        {
            return None;
        }
        for key in ["min", "max"] {
            let n = v.get(key)?;
            if !n.is_null() && !n.as_f64().is_some_and(|n| n.is_finite() && n >= 0.0) {
                return None;
            }
        }
        if v["min"]
            .as_f64()
            .zip(v["max"].as_f64())
            .is_some_and(|(a, b)| a > b)
        {
            return None;
        }
    }
    Some(v)
}
fn valid_body(body: &Value, input: &Value, metrics: bool) -> bool {
    if body.get("mode").and_then(Value::as_str) != Some("seasonal")
        || body.get("cycleId") != input.get("cycleId")
        || body.get("statistic") != input.get("statistic")
        || body.get("period") != input.get("period")
    {
        return false;
    }
    if metrics {
        return body.get("series").is_some_and(|series| {
            persistent::SERIES_METRICS
                .iter()
                .all(|key| buckets(series.get(*key)))
        });
    }
    let averages = body.get("averages");
    count(body.get("total"))
        && body.get("dimension") == input.get("dimension")
        && body.get("metric") == input.get("metric")
        && averages.is_some_and(|v| {
            if v.is_null() {
                body["total"].as_f64() == Some(0.0)
            } else {
                count(v.get("n"))
                    && persistent::AVERAGE_COLUMNS
                        .iter()
                        .all(|k| nullable(v.get(*k)))
            }
        })
        && body
            .get("metricCounts")
            .is_some_and(|v| persistent::AVERAGE_COLUMNS.iter().all(|k| count(v.get(*k))))
        && body
            .get("bounds")
            .is_some_and(|v| finite(v.get("min")) && finite(v.get("max")))
        && buckets(body.get("buckets"))
}
pub fn valid_worker(value: &Value, job: &Value, metrics: bool) -> bool {
    let Some(input) = input(job) else {
        return false;
    };
    if metrics {
        return value.is_null() || valid_body(value, input, true);
    }
    match (
        value.get("available").and_then(Value::as_bool),
        value.get("result"),
    ) {
        (Some(_), Some(result)) if result.is_null() => true,
        (Some(true), Some(result)) => valid_body(result, input, false),
        _ => false,
    }
}
pub fn valid_cached(value: &Value, job: &Value, metrics: bool) -> bool {
    let Some(input) = input(job) else {
        return false;
    };
    if metrics {
        return value.is_null() || valid_body(value, input, true);
    }
    match value.get("status").and_then(Value::as_str) {
        Some("ready") => value
            .get("result")
            .is_some_and(|v| valid_body(v, input, false)),
        Some("not-found") => true,
        _ => false,
    }
}
#[derive(Clone)]
pub struct SeasonalService {
    cache: Cache,
    storage: Storage,
    pub config: Config,
    publication_enabled: bool,
    limiter: Arc<Mutex<arena::Limiter>>,
    trusted_header: String,
}
impl SeasonalService {
    pub fn new(cache: Cache, storage: Storage, config: Config) -> Self {
        let enabled = std::env::var("AVERAGE_PUBLICATIONS_ENABLED").ok();
        Self {
            cache,
            storage,
            config,
            publication_enabled: enabled.as_deref() != Some("false")
                && std::env::var("SQLITE_PATH").is_ok_and(|v| !v.is_empty())
                && (enabled.as_deref() == Some("true")
                    || std::env::var("NODE_ENV").as_deref() == Ok("production")),
            limiter: Arc::new(Mutex::new(arena::Limiter::default())),
            trusted_header: config::trim(
                &std::env::var("TRUSTED_IP_HEADER").unwrap_or_else(|_| "x-real-ip".into()),
            )
            .to_lowercase(),
        }
    }
    pub fn ready(&self, now: i64) -> bool {
        self.config
            .cycle
            .as_deref()
            .is_some_and(|cycle| self.config.ready(cycle, now))
    }
    pub fn allow(&self, headers: &HeaderMap, now: i64) -> bool {
        let ip = headers
            .get(&self.trusted_header)
            .and_then(|v| v.to_str().ok())
            .map(config::trim)
            .filter(|v| !v.is_empty() && v.len() <= 128)
            .unwrap_or("unknown");
        self.limiter.lock().unwrap().allow_max(ip, now, 480)
    }
    fn error(
        status: u16,
        message: &str,
        retry: bool,
        metrics: bool,
        source: Option<&'static str>,
    ) -> PersistentResponse {
        let mut response = PersistentResponse::error(
            status,
            message,
            retry,
            metrics,
            Some("seasonal".into()),
            source,
        );
        if status == 404 {
            response.outcome = "not_found";
        }
        response
    }
    pub async fn response(
        &self,
        raw: &str,
        headers: &HeaderMap,
        now: i64,
        metrics: bool,
    ) -> PersistentResponse {
        if !self.ready(now) {
            return Self::error(
                404,
                "Seasonal average unavailable",
                false,
                metrics,
                metrics.then_some("dynamic"),
            );
        }
        if !self.allow(headers, now) {
            return Self::error(
                429,
                "Rate limit exceeded",
                false,
                metrics,
                metrics.then_some("dynamic"),
            );
        }
        match Query::parse(raw, self.config.cycle.as_deref().unwrap(), metrics) {
            Ok(query) => self.load(&query, now, metrics).await,
            Err(message) => Self::error(400, message, false, metrics, metrics.then_some("dynamic")),
        }
    }
    pub async fn load(&self, query: &Query, now: i64, metrics: bool) -> PersistentResponse {
        let publication = if self.publication_enabled {
            self.storage
                .scoped_publication(
                    PublicationScope::Seasonal(format!("seasonal:{}", query.cycle)),
                    format!("standard:{}:{}", query.statistic, query.period),
                    now,
                )
                .await
        } else {
            None
        };
        if !metrics && query.standard() && self.publication_enabled {
            let Some(publication) =
                publication.filter(|p| valid_body(&p.payload, &query.job(false)["args"][0], false))
            else {
                return Self::error(
                    503,
                    "Seasonal averages are warming",
                    true,
                    false,
                    Some("publication"),
                );
            };
            let mut headers = persistent::publication_headers(&publication);
            headers.remove("x-average-cache");
            headers.insert(
                "x-seasonal-average-cache",
                HeaderValue::from_static("publication"),
            );
            return PersistentResponse {
                status: StatusCode::OK,
                body: publication.payload,
                headers,
                mode: Some("seasonal".into()),
                source: Some("publication"),
                cache: Some("hit"),
                averages_ms: None,
                phases: None,
                outcome: "success",
            };
        }
        let started = Instant::now();
        let fallback = query.fallback_key(metrics);
        let loaded = self
            .cache
            .load(
                persistent::json_key(&json!([
                    fallback,
                    publication.map_or(0.0, |p| p.generation)
                ])),
                fallback,
                query.job(metrics),
                now,
            )
            .await;
        let mut response = match loaded {
            Ok(loaded)
                if metrics && !loaded.value.is_null()
                    || !metrics && loaded.value["status"] == "ready" =>
            {
                let mut headers =
                    persistent::statistics_headers(loaded.stale, loaded.generated_at, false);
                if !metrics {
                    headers.insert(
                        "x-seasonal-average-cache",
                        HeaderValue::from_static("next-data"),
                    );
                }
                PersistentResponse {
                    status: StatusCode::OK,
                    body: if metrics {
                        loaded.value
                    } else {
                        loaded.value["result"].clone()
                    },
                    headers,
                    mode: Some("seasonal".into()),
                    source: Some("dynamic"),
                    cache: Some(loaded.cache),
                    averages_ms: None,
                    phases: loaded.phases,
                    outcome: "success",
                }
            }
            Ok(loaded) if !metrics && loaded.value["status"] == "not-found" => {
                Self::error(404, "Season cycle not found", false, false, None)
            }
            Err(error) if error.reason == "calculation_error" => Self::error(
                500,
                if metrics {
                    "Failed to calculate metric series"
                } else {
                    "Failed to query Seasonal average"
                },
                false,
                metrics,
                Some("dynamic"),
            ),
            Err(error) if error.reason == "seasonal_storage_unavailable" => Self::error(
                503,
                "Seasonal average unavailable",
                true,
                metrics,
                Some("dynamic"),
            ),
            _ => Self::error(
                503,
                if metrics {
                    "Metric series are warming"
                } else {
                    "Seasonal averages are warming"
                },
                true,
                metrics,
                Some("dynamic"),
            ),
        };
        response.averages_ms = Some(started.elapsed().as_millis() as u64);
        if response.status == StatusCode::SERVICE_UNAVAILABLE {
            response.cache = Some("miss");
        }
        response
    }
}
pub async fn get(
    State(service): State<persistent::PersistentService>,
    RawQuery(raw): RawQuery,
    headers: HeaderMap,
) -> Response {
    let started = Instant::now();
    let response = service
        .seasonal()
        .response(
            raw.as_deref().unwrap_or(""),
            &headers,
            crate::now_ms(),
            false,
        )
        .await;
    service.record(&response, &headers, started.elapsed().as_millis() as u64);
    response.into_response()
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cycle_and_numeric_parser_keep_endpoint_differences() {
        let q = Query::parse(
            "cycle=%20s1%20&min=%20&max=0x10&metric=bad&dimension=pmc_raids",
            "s1",
            false,
        )
        .unwrap();
        assert_eq!(q.cycle, "s1");
        assert_eq!(q.min, Some(0.0));
        assert_eq!(q.max, Some(16.0));
        assert_eq!(q.metric, "players");
        for raw in [
            "cycle=s1&cycle=s1",
            "cycle=s1&min=-1",
            "cycle=s1&min=10&max=1",
            "cycle=s1&period=bad",
        ] {
            assert!(Query::parse(raw, "s1", false).is_err(), "{raw}");
        }
        assert!(Query::parse("cycle=s1&unknown=1", "s1", false).is_ok());
        assert!(Query::parse("mode=seasonal&cycle=%20s1%20", "s1", true).is_ok());
        for raw in [
            "mode=seasonal&cycle=s1&unknown=1",
            "mode=seasonal&cycle=s1&period=all&period=90d",
            "mode=regular&cycle=s1",
        ] {
            assert!(Query::parse(raw, "s1", true).is_err(), "{raw}");
        }
    }
    #[test]
    fn keys_keep_cross_runtime_filter_identity() {
        let q = Query::parse("cycle=s1&min=-0&max=0x10&dimension=pmc_raids", "s1", false).unwrap();
        assert_eq!(
            q.fallback_key(false),
            r#"["seasonal","s1","all","trimmed_mean","pmc_raids","players",0,16]"#
        );
        assert_eq!(
            q.fallback_key(true),
            r#"["metric-series-v1","seasonal","s1","trimmed_mean","all"]"#
        );
    }
    #[test]
    fn worker_envelopes_and_durable_wrappers_keep_cycle_and_metrics_identity() {
        let query = Query::parse("cycle=s1&min=1", "s1", false).unwrap();
        let job = query.job(false);
        let mut averages = serde_json::Map::new();
        let mut counts = serde_json::Map::new();
        for key in persistent::AVERAGE_COLUMNS {
            averages.insert(key.into(), json!(1));
            counts.insert(key.into(), json!(1));
        }
        averages.insert("n".into(), json!(1));
        let body = json!({"mode":"seasonal","cycleId":"s1","statistic":"trimmed_mean","period":"all","dimension":"hours","metric":"players","total":1,"averages":averages,"metricCounts":counts,"bounds":{"min":0,"max":100},"buckets":[{"lo":0,"hi":50,"n":1,"sum":0}]});
        assert!(valid_worker(
            &json!({"available":true,"result":body}),
            &job,
            false
        ));
        assert!(valid_cached(
            &json!({"status":"ready","result":body}),
            &job,
            false
        ));
        assert!(!valid_cached(
            &json!({"available":true,"result":body}),
            &job,
            false
        ));
        assert!(!valid_worker(
            &json!({"status":"ready","result":body}),
            &job,
            false
        ));
        let mut wrong = body.clone();
        wrong["cycleId"] = json!("s2");
        assert!(!valid_worker(
            &json!({"available":true,"result":wrong}),
            &job,
            false
        ));
        let mut wrong = body.clone();
        wrong["averages"]["kd_ratio"] = json!("1");
        assert!(!valid_cached(
            &json!({"status":"ready","result":wrong}),
            &job,
            false
        ));
        assert!(valid_worker(
            &json!({"available":false,"result":null}),
            &job,
            false
        ));
        assert!(!valid_worker(
            &json!({"available":false,"result":body}),
            &job,
            false
        ));
        assert_eq!(
            Query::parse("mode=seasonal&cycle=wrong&statistic=bad", "s1", true).unwrap_err(),
            "Invalid metric series query"
        );
    }
}
