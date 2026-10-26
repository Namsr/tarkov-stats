use crate::{
    arena,
    cache::Cache,
    storage::{Publication, PublicationScope, Storage},
};
use axum::{
    extract::{RawQuery, State},
    http::{HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use std::{collections::HashSet, time::Instant};

pub const AVERAGE_COLUMNS: [&str; 17] = [
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
pub const SERIES_METRICS: [&str; 6] = [
    "kd_ratio",
    "survival_rate",
    "kills_per_raid",
    "total_kills",
    "deaths",
    "total_raids",
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
const MAX_BINS: u32 = 36;
fn params(raw: &str) -> Vec<(String, String)> {
    url::form_urlencoded::parse(raw.as_bytes())
        .into_owned()
        .collect()
}
fn first<'a>(params: &'a [(String, String)], name: &str) -> Option<&'a str> {
    params
        .iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.as_str())
}
fn known_mode(value: &str) -> bool {
    ["regular", "pve"].contains(&value)
}
fn statistic(raw: Option<&str>) -> Option<&str> {
    match raw {
        None => Some("trimmed_mean"),
        Some("trimmed_mean" | "median") => raw,
        _ => None,
    }
}
fn period(raw: Option<&str>) -> Option<&str> {
    match raw {
        None => Some("all"),
        Some("all" | "90d") => raw,
        _ => None,
    }
}
fn range(raw: Option<&str>) -> Result<Option<f64>, &'static str> {
    raw.filter(|value| !value.is_empty())
        .map(|value| {
            arena::number(value)
                .filter(|number| *number >= 0.0)
                .ok_or("Range values must be finite and non-negative")
        })
        .transpose()
}
pub(crate) fn json_key(value: &Value) -> String {
    match value {
        Value::Array(values) => format!(
            "[{}]",
            values.iter().map(json_key).collect::<Vec<_>>().join(",")
        ),
        Value::Number(number) => arena::number_key(number.as_f64().unwrap()),
        _ => value.to_string(),
    }
}
fn scoped(mode: &str) -> PublicationScope {
    if mode == "pve" {
        PublicationScope::Pve
    } else {
        PublicationScope::Regular
    }
}
fn variant(statistic: &str, period: &str) -> String {
    format!("standard:{statistic}:{period}")
}

#[derive(Clone, Debug)]
pub struct AverageQuery {
    pub mode: String,
    pub dimension: String,
    pub metric: String,
    pub max_bins: u32,
    pub statistic: String,
    pub period: String,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub max_inclusive: bool,
}
impl AverageQuery {
    pub fn parse(raw: &str) -> Result<Self, &'static str> {
        if raw.len() > 65536 {
            return Err("Invalid average query");
        }
        let values = params(raw);
        let get = |name: &str| first(&values, name);
        let mode = get("mode").unwrap_or("regular");
        if !known_mode(mode) {
            return Err("Invalid game mode");
        }
        let statistic = statistic(get("statistic")).ok_or("Invalid statistic")?;
        let period = period(get("period")).ok_or("Invalid period")?;
        let dimension = get("dimension").unwrap_or("hours");
        if !["hours", "pmc_raids"].contains(&dimension) {
            return Err("Invalid dimension");
        }
        if get("minHours").is_some() || get("maxHours").is_some() {
            return Err("Invalid average range: use min and max");
        }
        let min = range(get("min"))?;
        let max = range(get("max"))?;
        if min.zip(max).is_some_and(|(min, max)| min > max) {
            return Err("Range minimum cannot exceed maximum");
        }
        let metric = get("metric")
            .filter(|value| Y_METRICS.contains(value))
            .unwrap_or("players");
        let max_bins = get("maxBins")
            .and_then(arena::number)
            .filter(|value| *value > 0.0)
            .map_or(MAX_BINS, |value| {
                value.floor().clamp(1.0, MAX_BINS as f64) as u32
            });
        Ok(Self {
            mode: mode.into(),
            dimension: dimension.into(),
            metric: metric.into(),
            max_bins,
            statistic: statistic.into(),
            period: period.into(),
            min,
            max,
            max_inclusive: true,
        })
    }
    pub fn job(&self) -> Value {
        json!({"kind":"persistent_average","mode":self.mode,"args":[self.dimension,self.metric,self.max_bins,self.statistic,self.period,self.min,self.max,self.max_inclusive]})
    }
    pub fn fallback_key(&self) -> String {
        json_key(&json!([
            self.mode,
            self.dimension,
            self.metric,
            self.max_bins,
            self.statistic,
            self.period,
            self.min,
            self.max,
            self.max_inclusive
        ]))
    }
    pub fn cache_key(&self, generation: f64) -> String {
        json_key(&json!([self.fallback_key(), generation]))
    }
    pub fn standard(&self) -> bool {
        self.dimension == "hours"
            && self.metric == "players"
            && self.max_bins == MAX_BINS
            && self.min.is_none()
            && self.max.is_none()
    }
    fn from_job(job: &Value) -> Option<Self> {
        if job.get("kind")?.as_str()? != "persistent_average" {
            return None;
        }
        let mode = job.get("mode")?.as_str()?;
        let args = job.get("args")?.as_array()?;
        if !known_mode(mode) || args.len() != 8 {
            return None;
        }
        let dimension = args[0].as_str()?;
        let metric = args[1].as_str()?;
        let bins = args[2].as_u64()?;
        let statistic = statistic(args[3].as_str()).filter(|_| args[3].is_string())?;
        let period = period(args[4].as_str()).filter(|_| args[4].is_string())?;
        let bound = |value: &Value| {
            if value.is_null() {
                Some(None)
            } else {
                value
                    .as_f64()
                    .filter(|number| number.is_finite() && *number >= 0.0)
                    .map(Some)
            }
        };
        let min = bound(&args[5])?;
        let max = bound(&args[6])?;
        if !["hours", "pmc_raids"].contains(&dimension)
            || !Y_METRICS.contains(&metric)
            || !(1..=MAX_BINS as u64).contains(&bins)
            || min.zip(max).is_some_and(|(min, max)| min > max)
        {
            return None;
        }
        Some(Self {
            mode: mode.into(),
            dimension: dimension.into(),
            metric: metric.into(),
            max_bins: bins as u32,
            statistic: statistic.into(),
            period: period.into(),
            min,
            max,
            max_inclusive: args[7].as_bool()?,
        })
    }
}
#[derive(Clone, Debug)]
pub struct MetricsQuery {
    pub mode: String,
    pub statistic: String,
    pub period: String,
}
impl MetricsQuery {
    pub fn parse(raw: &str) -> Result<Self, &'static str> {
        if raw.len() > 65536 {
            return Err("Invalid metric series query");
        }
        let values = params(raw);
        let get = |name: &str| first(&values, name);
        let mode = get("mode").unwrap_or("regular");
        let statistic = statistic(get("statistic"));
        let period = period(get("period"));
        let mut unique = HashSet::new();
        if !known_mode(mode)
            || statistic.is_none()
            || period.is_none()
            || values.iter().any(|(key, _)| {
                !["mode", "cycle", "period", "statistic"].contains(&key.as_str())
                    || !unique.insert(key)
            })
        {
            return Err("Invalid metric series query");
        }
        if get("cycle").is_some_and(|cycle| cycle != "persistent") {
            return Err("Invalid cycle");
        }
        Ok(Self {
            mode: mode.into(),
            statistic: statistic.unwrap().into(),
            period: period.unwrap().into(),
        })
    }
    pub fn job(&self) -> Value {
        json!({"kind":"persistent_metrics","mode":self.mode,"args":[self.statistic,self.period]})
    }
    pub fn fallback_key(&self) -> String {
        json!([
            "metric-series-v1",
            self.mode,
            "persistent",
            self.statistic,
            self.period
        ])
        .to_string()
    }
    pub fn cache_key(&self, generation: f64) -> String {
        json_key(&json!([self.fallback_key(), generation]))
    }
    fn from_job(job: &Value) -> Option<Self> {
        let mode = job.get("mode")?.as_str()?;
        let args = job.get("args")?.as_array()?;
        if job.get("kind")?.as_str()? != "persistent_metrics"
            || !known_mode(mode)
            || args.len() != 2
        {
            return None;
        }
        Some(Self {
            mode: mode.into(),
            statistic: statistic(args[0].as_str())
                .filter(|_| args[0].is_string())?
                .into(),
            period: period(args[1].as_str())
                .filter(|_| args[1].is_string())?
                .into(),
        })
    }
}
fn count(value: Option<&Value>) -> bool {
    value.and_then(Value::as_f64).is_some_and(|number| {
        number.is_finite() && (0.0..=9007199254740991.0).contains(&number) && number.fract() == 0.0
    })
}
fn finite(value: Option<&Value>) -> bool {
    value.and_then(Value::as_f64).is_some_and(f64::is_finite)
}
fn nullable(value: Option<&Value>) -> bool {
    value.is_some_and(|value| value.is_null() || finite(Some(value)))
}
fn bucket(value: &Value) -> bool {
    value.is_object()
        && finite(value.get("lo"))
        && nullable(value.get("hi"))
        && count(value.get("n"))
        && nullable(value.get("sum"))
}
fn buckets(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_array)
        .is_some_and(|values| values.iter().all(bucket))
}
// The legacy body does not echo min/max/inclusivity. Those remain correlated by
// the request ID and exact complete cache key; do not invent a public API field.
pub fn valid_average(value: &Value, job: &Value) -> bool {
    let Some(query) = AverageQuery::from_job(job) else {
        return false;
    };
    let Some(body) = value.get("body").filter(|body| body.is_object()) else {
        return false;
    };
    let storage = value.get("storage").and_then(Value::as_str);
    if !matches!(storage, Some("sqlite" | "unavailable"))
        || body.get("mode").and_then(Value::as_str) != Some(&query.mode)
        || body.get("cycleId").and_then(Value::as_str) != Some("persistent")
        || body.get("dimension").and_then(Value::as_str) != Some(&query.dimension)
        || body.get("metric").and_then(Value::as_str) != Some(&query.metric)
        || body.get("statistic").and_then(Value::as_str) != Some(&query.statistic)
        || body.get("period").and_then(Value::as_str) != Some(&query.period)
        || !count(body.get("total"))
    {
        return false;
    }
    let average = if storage == Some("unavailable") {
        body.get("averages").is_some_and(Value::is_null)
    } else {
        body.get("averages")
            .filter(|value| value.is_object())
            .is_some_and(|values| {
                count(values.get("n"))
                    && AVERAGE_COLUMNS.iter().all(|key| nullable(values.get(*key)))
            })
    };
    let metric_counts = body
        .get("metricCounts")
        .filter(|value| value.is_object())
        .is_some_and(|counts| {
            if storage == Some("unavailable") {
                counts.as_object().is_some_and(|values| values.is_empty())
            } else {
                AVERAGE_COLUMNS.iter().all(|key| count(counts.get(*key)))
            }
        });
    let bounds = body.get("bounds").is_some_and(|bounds| {
        bounds.is_object() && nullable(bounds.get("min")) && nullable(bounds.get("max"))
    });
    let brackets = body
        .get("brackets")
        .and_then(Value::as_array)
        .is_some_and(|values| {
            values.iter().all(|value| {
                value.get("bracket_key").is_some_and(Value::is_string)
                    && count(value.get("n"))
                    && nullable(value.get("sum"))
            })
        });
    let histogram = body
        .get("histogram")
        .and_then(Value::as_array)
        .is_some_and(|values| {
            values.len() <= query.max_bins as usize
                && values.iter().all(|value| {
                    bucket(value)
                        && nullable(value.get("avg"))
                        && value.get("label").is_some_and(Value::is_string)
                })
        });
    average && metric_counts && bounds && brackets && buckets(body.get("buckets")) && histogram
}
pub fn valid_metrics(value: &Value, job: &Value) -> bool {
    let Some(query) = MetricsQuery::from_job(job) else {
        return false;
    };
    value.is_null()
        || value.is_object()
            && value.get("mode").and_then(Value::as_str) == Some(&query.mode)
            && value.get("cycleId").and_then(Value::as_str) == Some("persistent")
            && value.get("statistic").and_then(Value::as_str) == Some(&query.statistic)
            && value.get("period").and_then(Value::as_str) == Some(&query.period)
            && value
                .get("series")
                .filter(|value| value.is_object())
                .is_some_and(|series| {
                    SERIES_METRICS
                        .iter()
                        .all(|metric| buckets(series.get(*metric)))
                })
}

#[derive(Clone)]
pub struct PersistentService {
    cache: Cache,
    storage: Storage,
    publication_enabled: bool,
    limiter: arena::ArenaService,
    seasonal: crate::seasonal_population::SeasonalService,
}
pub struct PersistentResponse {
    pub status: StatusCode,
    pub body: Value,
    pub headers: HeaderMap,
    pub mode: Option<String>,
    pub source: Option<&'static str>,
    pub cache: Option<&'static str>,
    pub averages_ms: Option<u64>,
    pub phases: Option<(u64, u64)>,
    pub outcome: &'static str,
}
impl PersistentResponse {
    pub(crate) fn error(
        status: u16,
        message: &str,
        retry: bool,
        metrics: bool,
        mode: Option<String>,
        source: Option<&'static str>,
    ) -> Self {
        let mut headers = HeaderMap::new();
        if retry {
            headers.insert("retry-after", HeaderValue::from_static("5"));
        }
        if metrics || status == 429 {
            headers.insert("cache-control", HeaderValue::from_static("no-store"));
        }
        Self {
            status: StatusCode::from_u16(status).unwrap(),
            body: json!({"error":message}),
            headers,
            mode,
            source,
            cache: None,
            averages_ms: None,
            phases: None,
            outcome: match status {
                429 => "rate_limited",
                503 => "unavailable",
                500 => "error",
                _ => "invalid",
            },
        }
    }
}
impl IntoResponse for PersistentResponse {
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
pub(crate) fn publication_headers(publication: &Publication) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        "cache-control",
        HeaderValue::from_static("public, max-age=60, s-maxage=300, stale-while-revalidate=600"),
    );
    headers.insert("x-average-cache", HeaderValue::from_static("publication"));
    headers.insert("x-average-source", HeaderValue::from_static("publication"));
    for (key, value) in [
        (
            "x-average-generation",
            arena::number_key(publication.generation),
        ),
        (
            "x-average-generated-at",
            arena::number_key(publication.generated_at),
        ),
        (
            "x-average-stale",
            if publication.stale { "1" } else { "0" }.into(),
        ),
    ] {
        headers.insert(key, HeaderValue::from_str(&value).unwrap());
    }
    headers
}
pub(crate) fn statistics_headers(stale: bool, generated_at: f64, average: bool) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert("cache-control", HeaderValue::from_static("no-store"));
    headers.insert(
        "x-statistics-stale",
        HeaderValue::from_static(if stale { "1" } else { "0" }),
    );
    headers.insert(
        "x-statistics-generated-at",
        HeaderValue::from_str(&arena::number_key(generated_at)).unwrap(),
    );
    headers.insert("x-average-source", HeaderValue::from_static("dynamic"));
    if average {
        headers.insert("x-average-cache", HeaderValue::from_static("next-data"));
    }
    if stale {
        headers.insert("retry-after", HeaderValue::from_static("5"));
    }
    headers
}
impl PersistentService {
    pub fn new(cache: Cache, storage: Storage, limiter: arena::ArenaService) -> Self {
        let enabled = std::env::var("AVERAGE_PUBLICATIONS_ENABLED").ok();
        let publication_enabled = enabled.as_deref() != Some("false")
            && std::env::var("SQLITE_PATH").is_ok_and(|value| !value.is_empty())
            && (enabled.as_deref() == Some("true")
                || std::env::var("NODE_ENV").as_deref() == Ok("production"));
        let seasonal = crate::seasonal_population::SeasonalService::new(
            cache.clone(),
            storage.clone(),
            crate::config::Config::from_env(),
        );
        Self {
            cache,
            storage,
            publication_enabled,
            limiter,
            seasonal,
        }
    }
    pub(crate) fn seasonal(&self) -> crate::seasonal_population::SeasonalService {
        self.seasonal.clone()
    }
    /// Admit one public request before an SSR caller fans out to both data reads.
    pub fn allow(&self, headers: &HeaderMap, now: i64) -> bool {
        self.limiter.allow(headers, now)
    }
    pub async fn load_average(&self, query: &AverageQuery, now: i64) -> PersistentResponse {
        let publication = if self.publication_enabled {
            self.storage
                .scoped_publication(
                    scoped(&query.mode),
                    variant(&query.statistic, &query.period),
                    now,
                )
                .await
        } else {
            None
        };
        if query.standard() && self.publication_enabled {
            let Some(publication) = publication.filter(|publication| {
                valid_average(
                    &json!({"storage":"sqlite","body":publication.payload}),
                    &query.job(),
                )
            }) else {
                return PersistentResponse::error(
                    503,
                    "Average statistics are warming",
                    true,
                    false,
                    Some(query.mode.clone()),
                    Some("publication"),
                );
            };
            let headers = publication_headers(&publication);
            return PersistentResponse {
                status: StatusCode::OK,
                body: publication.payload,
                headers,
                mode: Some(query.mode.clone()),
                source: Some("publication"),
                cache: Some("hit"),
                averages_ms: None,
                phases: None,
                outcome: "success",
            };
        }
        let started = Instant::now();
        let loaded = self
            .cache
            .load(
                query.cache_key(publication.map_or(0.0, |publication| publication.generation)),
                query.fallback_key(),
                query.job(),
                now,
            )
            .await;
        let elapsed = started.elapsed().as_millis() as u64;
        let mut response = match loaded {
            Ok(loaded) if loaded.value.get("storage").and_then(Value::as_str) == Some("sqlite") => {
                PersistentResponse {
                    status: StatusCode::OK,
                    body: loaded.value["body"].clone(),
                    headers: statistics_headers(loaded.stale, loaded.generated_at, true),
                    mode: Some(query.mode.clone()),
                    source: Some("dynamic"),
                    cache: Some(loaded.cache),
                    averages_ms: Some(elapsed),
                    phases: None,
                    outcome: "success",
                }
            }
            Ok(_) => PersistentResponse::error(
                503,
                "Average statistics are warming",
                true,
                false,
                Some(query.mode.clone()),
                Some("dynamic"),
            ),
            Err(error) if error.reason == "calculation_error" => {
                eprintln!("Average stats failed: {}", error.message);
                PersistentResponse::error(
                    500,
                    "Failed to compute averages",
                    false,
                    false,
                    Some(query.mode.clone()),
                    None,
                )
            }
            Err(_) => PersistentResponse::error(
                503,
                "Average statistics are warming",
                true,
                false,
                Some(query.mode.clone()),
                Some("dynamic"),
            ),
        };
        response.averages_ms = Some(elapsed);
        if response.status == StatusCode::SERVICE_UNAVAILABLE {
            response.cache = Some("miss");
        }
        response
    }
    pub async fn load_metrics(&self, query: &MetricsQuery, now: i64) -> PersistentResponse {
        let publication = if self.publication_enabled {
            self.storage
                .scoped_publication(
                    scoped(&query.mode),
                    variant(&query.statistic, &query.period),
                    now,
                )
                .await
        } else {
            None
        };
        let started = Instant::now();
        let loaded = self
            .cache
            .load(
                query.cache_key(publication.map_or(0.0, |publication| publication.generation)),
                query.fallback_key(),
                query.job(),
                now,
            )
            .await;
        let elapsed = started.elapsed().as_millis() as u64;
        let mut response = match loaded {
            Ok(loaded) if !loaded.value.is_null() => PersistentResponse {
                status: StatusCode::OK,
                body: loaded.value,
                headers: statistics_headers(loaded.stale, loaded.generated_at, false),
                mode: Some(query.mode.clone()),
                source: Some("dynamic"),
                cache: Some(loaded.cache),
                averages_ms: Some(elapsed),
                phases: loaded.phases,
                outcome: "success",
            },
            Ok(_) => PersistentResponse::error(
                503,
                "Metric series are warming",
                true,
                true,
                Some(query.mode.clone()),
                Some("dynamic"),
            ),
            Err(error) if error.reason == "calculation_error" => {
                eprintln!("Metric series failed: {}", error.message);
                PersistentResponse::error(
                    500,
                    "Failed to calculate metric series",
                    false,
                    true,
                    Some(query.mode.clone()),
                    Some("dynamic"),
                )
            }
            Err(_) => PersistentResponse::error(
                503,
                "Metric series are warming",
                true,
                true,
                Some(query.mode.clone()),
                Some("dynamic"),
            ),
        };
        response.averages_ms = Some(elapsed);
        response
    }
    pub(crate) fn record(&self, response: &PersistentResponse, headers: &HeaderMap, elapsed: u64) {
        let stage = match response.outcome {
            "success" => None,
            "invalid" => Some("request"),
            "rate_limited" => Some("rate_limit"),
            "unavailable" => Some("dependency"),
            _ => Some("application"),
        };
        let mut event = json!({"event":"request_timing_v1","entry":"api","at":crate::now_ms(),"pid":std::process::id(),"operation":"average","outcome":response.outcome,"status":response.status.as_u16(),"total_ms":elapsed});
        if let Some(mode) = &response.mode {
            event["mode"] = json!(mode);
        }
        if elapsed >= 1000 {
            event["slow"] = json!(true);
        }
        for (key, value) in [
            ("source", response.source),
            ("cache", response.cache),
            (
                "storage",
                (response.outcome == "success").then_some("sqlite"),
            ),
            ("failure_stage", stage),
        ] {
            if let Some(value) = value {
                event[key] = json!(value);
            }
        }
        if let Some(value) = response.averages_ms {
            event["averages_ms"] = json!(value);
        }
        if let Some((queue, worker)) = response.phases {
            event["queue_ms"] = json!(queue);
            event["worker_ms"] = json!(worker);
        }
        if stage.is_some() {
            event["error_code"] = json!(format!(
                "average_{}_{}",
                response.outcome,
                response.status.as_u16()
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
        if elapsed >= 1000 || arena::sampled() {
            crate::log_json(&event);
        }
        self.storage.event(event);
    }
}
pub async fn average_get(
    State(service): State<PersistentService>,
    RawQuery(raw): RawQuery,
    headers: HeaderMap,
) -> Response {
    let raw = raw.unwrap_or_default();
    if first(&params(&raw), "mode") == Some("arena") {
        return arena::get(State(service.limiter.clone()), RawQuery(Some(raw)), headers).await;
    }
    let started = Instant::now();
    let now = crate::now_ms();
    let response = if !service.allow(&headers, now) {
        PersistentResponse::error(429, "Rate limit exceeded", false, false, None, None)
    } else {
        match AverageQuery::parse(&raw) {
            Ok(query) => service.load_average(&query, now).await,
            Err(message) => PersistentResponse::error(
                400,
                message,
                false,
                false,
                first(&params(&raw), "mode")
                    .or(Some("regular"))
                    .filter(|mode| known_mode(mode))
                    .map(String::from),
                None,
            ),
        }
    };
    service.record(&response, &headers, started.elapsed().as_millis() as u64);
    response.into_response()
}
pub async fn metrics_get(
    State(service): State<PersistentService>,
    RawQuery(raw): RawQuery,
    headers: HeaderMap,
) -> Response {
    let raw = raw.unwrap_or_default();
    let started = Instant::now();
    let now = crate::now_ms();
    let mode = first(&params(&raw), "mode")
        .unwrap_or("regular")
        .to_string();
    if mode == "seasonal" {
        let response = service.seasonal.response(&raw, &headers, now, true).await;
        service.record(&response, &headers, started.elapsed().as_millis() as u64);
        return response.into_response();
    }
    let response = if !service.allow(&headers, now) {
        PersistentResponse::error(
            429,
            "Rate limit exceeded",
            false,
            true,
            known_mode(&mode).then_some(mode),
            Some("dynamic"),
        )
    } else {
        match MetricsQuery::parse(&raw) {
            Ok(query) => service.load_metrics(&query, now).await,
            Err(message) => PersistentResponse::error(
                400,
                message,
                false,
                true,
                known_mode(&mode).then_some(mode),
                Some("dynamic"),
            ),
        }
    };
    service.record(&response, &headers, started.elapsed().as_millis() as u64);
    response.into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn average_defaults_first_values_metric_fallback_and_js_bounds() {
        let query=AverageQuery::parse("mode=pve&mode=bad&metric=invalid&dimension=pmc_raids&min=%20&max=0x10&maxBins=.5&ignored=1").unwrap();
        assert_eq!(query.mode, "pve");
        assert_eq!(query.metric, "players");
        assert_eq!(query.max_bins, 1);
        assert_eq!(query.min, Some(0.0));
        assert_eq!(query.max, Some(16.0));
        assert_eq!(AverageQuery::parse("").unwrap().statistic, "trimmed_mean");
        for query in [
            "mode=seasonal",
            "statistic=",
            "period=",
            "dimension=",
            "minHours=",
            "maxHours=1",
            "min=NaN",
            "max=Infinity",
            "min=-1",
            "min=2&max=1",
        ] {
            assert!(AverageQuery::parse(query).is_err(), "{query}");
        }
        assert_eq!(
            AverageQuery::parse("min=16&max=-0").unwrap_err(),
            "Range minimum cannot exceed maximum"
        );
    }
    #[test]
    fn cache_keys_keep_complete_filters_and_javascript_number_spelling() {
        let first = AverageQuery::parse("mode=pve&min=0x10&max=1e21").unwrap();
        assert_eq!(
            first.fallback_key(),
            "[\"pve\",\"hours\",\"players\",36,\"trimmed_mean\",\"all\",16,1e+21,true]"
        );
        assert_eq!(
            first.fallback_key(),
            AverageQuery::parse("mode=pve&min=16.0&max=1.0e21")
                .unwrap()
                .fallback_key()
        );
        assert_ne!(
            first.fallback_key(),
            AverageQuery::parse("mode=regular&min=16&max=1e21")
                .unwrap()
                .fallback_key()
        );
    }
    #[test]
    fn metrics_reject_duplicates_unknown_keys_and_nonpersistent_cycle() {
        assert_eq!(
            MetricsQuery::parse("mode=pve&cycle=persistent&period=90d")
                .unwrap()
                .period,
            "90d"
        );
        for query in [
            "mode=pve&mode=pve",
            "metric=players",
            "cycle= persistent",
            "cycle=",
            "mode=arena",
            "dimension=hours",
            "period=",
        ] {
            assert!(MetricsQuery::parse(query).is_err(), "{query}");
        }
    }
    #[test]
    fn validators_reject_cross_mode_statistic_and_malformed_nested_series() {
        let query = MetricsQuery::parse("mode=pve").unwrap();
        let mut value = json!({"mode":"pve","cycleId":"persistent","statistic":"trimmed_mean","period":"all","series":{}});
        for metric in SERIES_METRICS {
            value["series"][metric] = json!([{"lo":0,"hi":25,"n":2,"sum":4}]);
        }
        assert!(valid_metrics(&value, &query.job()));
        value["mode"] = json!("regular");
        assert!(!valid_metrics(&value, &query.job()));
        value["mode"] = json!("pve");
        value["series"]["kd_ratio"] = json!([null]);
        assert!(!valid_metrics(&value, &query.job()));
        assert!(!valid_average(
            &json!({"storage":"sqlite","body":7}),
            &AverageQuery::parse("mode=pve").unwrap().job()
        ));
    }
    #[test]
    fn average_validation_keeps_unknowns_and_negative_metrics_but_rejects_wrong_identity() {
        let query = AverageQuery::parse("mode=pve&dimension=pmc_raids&maxBins=8").unwrap();
        let mut averages = json!({"n":2});
        let mut counts = json!({});
        for metric in AVERAGE_COLUMNS {
            averages[metric] = json!(null);
            counts[metric] = json!(0);
        }
        averages["kd_ratio"] = json!(-1.0);
        counts["kd_ratio"] = json!(2);
        let mut value = json!({"storage":"sqlite","body":{"mode":"pve","cycleId":"persistent","dimension":"pmc_raids","metric":"players","statistic":"trimmed_mean","period":"all","total":2,"averages":averages,"metricCounts":counts,"brackets":[],"buckets":[],"histogram":[],"bounds":{"min":0,"max":100}}});
        assert!(valid_average(&value, &query.job()));
        value["body"]["mode"] = json!("regular");
        assert!(!valid_average(&value, &query.job()));
        value["body"]["mode"] = json!("pve");
        value["body"]["histogram"] = json!([null]);
        assert!(!valid_average(&value, &query.job()));
    }
}
