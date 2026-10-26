use crate::{cache::Cache, config, storage::Storage};
use axum::{
    extract::{RawQuery, State},
    http::{HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex},
    time::Instant,
};

pub const MODES: [&str; 5] = [
    "teamFight",
    "lastHero",
    "checkpoint",
    "blastGang",
    "shootOutDuo",
];
pub const METRICS: [&str; 5] = [
    "kd_ratio",
    "win_rate",
    "headshot_rate",
    "kills_per_match",
    "damage_per_match",
];
pub const PARSER_VERSION: u64 = 5;

#[derive(Clone, Debug)]
pub struct ArenaQuery {
    pub mode: String,
    pub statistic: String,
    pub dimension: String,
    pub metric: String,
    pub ranges: [Option<f64>; 4],
    pub publication_only: bool,
}

// JavaScript Number(), including the radix forms accepted by parseNonNegative.
pub fn number(raw: &str) -> Option<f64> {
    let raw = config::trim(raw);
    if raw.is_empty() {
        return Some(0.0);
    }
    let radix = [
        ("0x", 16),
        ("0X", 16),
        ("0b", 2),
        ("0B", 2),
        ("0o", 8),
        ("0O", 8),
    ];
    for (prefix, base) in radix {
        if let Some(digits) = raw.strip_prefix(prefix) {
            if digits.is_empty() {
                return None;
            }
            let mut value = 0.0;
            for ch in digits.chars() {
                value = value * base as f64 + ch.to_digit(base)? as f64;
            }
            return value.is_finite().then_some(value);
        }
    }
    raw.parse::<f64>().ok().filter(|v| v.is_finite())
}

// JSON.stringify's number notation differs from serde_json at integer values
// and at the decimal/scientific boundaries. Durable cache keys are shared.
pub fn number_key(value: f64) -> String {
    if value == 0.0 {
        return "0".into();
    }
    let text = serde_json::to_string(&value).expect("finite number");
    let (negative, text) = text
        .strip_prefix('-')
        .map_or((false, text.as_str()), |s| (true, s));
    let (mantissa, exponent) = text
        .split_once(['e', 'E'])
        .map_or((text, 0), |(m, e)| (m, e.parse::<i32>().unwrap()));
    let point = mantissa.find('.').unwrap_or(mantissa.len()) as i32 + exponent;
    let digits = mantissa.replace('.', "");
    let digits = digits.trim_end_matches('0');
    let prefix = if negative { "-" } else { "" };
    if point > 0 && point <= 21 {
        if point as usize >= digits.len() {
            return format!(
                "{prefix}{digits}{}",
                "0".repeat(point as usize - digits.len())
            );
        }
        return format!(
            "{prefix}{}.{}",
            &digits[..point as usize],
            &digits[point as usize..]
        );
    }
    if point <= 0 && point > -6 {
        return format!("{prefix}0.{}{digits}", "0".repeat((-point) as usize));
    }
    let exponent = point - 1;
    let tail = if digits.len() > 1 {
        format!(".{}", &digits[1..])
    } else {
        String::new()
    };
    format!(
        "{prefix}{}{tail}e{}{exponent}",
        &digits[..1],
        if exponent >= 0 { "+" } else { "" }
    )
}
fn key(value: &Value) -> String {
    match value {
        Value::Array(values) => {
            format!("[{}]", values.iter().map(key).collect::<Vec<_>>().join(","))
        }
        Value::Number(v) => number_key(v.as_f64().unwrap()),
        _ => value.to_string(),
    }
}
impl ArenaQuery {
    pub fn parse(raw: &str) -> Result<Self, &'static str> {
        if raw.len() > 65_536 {
            return Err("Invalid Arena average query");
        }
        let mut params = HashMap::new();
        for (name, value) in url::form_urlencoded::parse(raw.as_bytes()) {
            params
                .entry(name.into_owned())
                .or_insert(value.into_owned());
        }
        let get = |name: &str| params.get(name).map(String::as_str);
        if get("mode") != Some("arena") {
            return Err("Invalid game mode");
        }
        let mode = get("arenaMode")
            .filter(|v| MODES.contains(v))
            .ok_or("Invalid Arena average query")?;
        let statistic = get("statistic").unwrap_or("trimmed_mean");
        let dimension = get("dimension").unwrap_or("matches");
        let metric = get("metric").unwrap_or("players");
        if !["trimmed_mean", "median"].contains(&statistic)
            || !["matches", "hours"].contains(&dimension)
            || !(metric == "players" || METRICS.contains(&metric))
            || get("period").is_some_and(|p| p != "all")
            || params.contains_key("min")
            || params.contains_key("max")
        {
            return Err("Invalid Arena average query");
        }
        let mut ranges = [None; 4];
        for (index, name) in ["minHours", "maxHours", "minMatches", "maxMatches"]
            .into_iter()
            .enumerate()
        {
            if let Some(raw) = get(name).filter(|s| !s.is_empty()) {
                ranges[index] = Some(
                    number(raw)
                        .filter(|n| *n >= 0.0)
                        .ok_or("Invalid Arena average query")?,
                );
            }
        }
        if (ranges[0].zip(ranges[1]).is_some_and(|(a, b)| a > b))
            || (ranges[2].zip(ranges[3]).is_some_and(|(a, b)| a > b))
        {
            return Err("Invalid Arena average query");
        }
        Ok(Self {
            mode: mode.into(),
            statistic: statistic.into(),
            dimension: dimension.into(),
            metric: metric.into(),
            ranges,
            publication_only: get("publicationOnly") == Some("1"),
        })
    }
    pub fn input(&self) -> Value {
        json!({"mode":self.mode,"statistic":self.statistic,"dimension":self.dimension,"metric":self.metric,"minHours":self.ranges[0],"maxHours":self.ranges[1],"minMatches":self.ranges[2],"maxMatches":self.ranges[3]})
    }
    pub fn cache_key(&self, version: u64) -> String {
        key(&json!([
            "arena",
            self.mode,
            self.statistic,
            self.dimension,
            self.metric,
            self.ranges[0],
            self.ranges[1],
            self.ranges[2],
            self.ranges[3],
            version
        ]))
    }
    pub fn fallback_key(&self) -> String {
        json!([PARSER_VERSION, self.cache_key(0)]).to_string()
    }
    fn standard(&self) -> bool {
        self.dimension == "matches"
            && self.metric == "players"
            && self.ranges.iter().all(Option::is_none)
    }
}

pub fn valid_result(value: &Value, input: &Value) -> bool {
    let Some(identity) = value.get("filterIdentity").filter(|v| v.is_object()) else {
        return false;
    };
    let matches = [
        "mode",
        "statistic",
        "dimension",
        "metric",
        "minHours",
        "maxHours",
        "minMatches",
        "maxMatches",
    ]
    .iter()
    .all(|field| {
        let (Some(a), Some(b)) = (identity.get(*field), input.get(*field)) else {
            return false;
        };
        a == b || a.as_f64().zip(b.as_f64()).is_some_and(|(a, b)| a == b)
    });
    let finite = |v: &Value| v.as_f64().is_some_and(f64::is_finite);
    let nullable = |v: Option<&Value>| v.is_some_and(|v| v.is_null() || finite(v));
    let count = |v: Option<&Value>| {
        v.and_then(Value::as_f64).is_some_and(|n| {
            n.is_finite() && (0.0..=9007199254740991.0).contains(&n) && n.fract() == 0.0
        })
    };
    let summary =
        |v: Option<&Value>| v.is_some_and(|v| count(v.get("count")) && nullable(v.get("value")));
    let metrics = |v: Option<&Value>| v.is_some_and(|v| METRICS.iter().all(|m| summary(v.get(*m))));
    let bounds = value.get("bounds").is_some_and(|bounds| {
        ["hours", "matches"].iter().all(|name| {
            bounds
                .get(*name)
                .is_some_and(|v| v.is_object() && nullable(v.get("min")) && nullable(v.get("max")))
        })
    });
    let buckets = value
        .get("buckets")
        .and_then(Value::as_array)
        .is_some_and(|buckets| {
            buckets.iter().all(|b| {
                b.is_object()
                    && b.get("min").is_some_and(finite)
                    && nullable(b.get("max"))
                    && count(b.get("sampleN"))
                    && metrics(b.get("metrics"))
            })
        });
    let coverage = value.get("coverage").is_some_and(|coverage| {
        METRICS.iter().all(|m| {
            coverage
                .get(*m)
                .and_then(Value::as_f64)
                .is_some_and(|n| n.is_finite() && (0.0..=1.0).contains(&n))
        })
    });
    // Older durable/publication payloads omit population and averageMatches.
    // Consumers deliberately show unknown metadata; never turn it into zero.
    let population = value
        .get("population")
        .filter(|v| !v.is_null())
        .is_none_or(|v| {
            count(v.get("scannedAccounts"))
                && v.get("playedAccounts")
                    .is_some_and(|played| MODES.iter().all(|m| count(played.get(*m))))
        });
    let average_matches = value
        .get("averageMatches")
        .filter(|v| !v.is_null())
        .is_none_or(|v| summary(Some(v)));
    matches
        && count(value.get("sampleN"))
        && count(value.get("total"))
        && metrics(value.get("metrics"))
        && bounds
        && buckets
        && coverage
        && population
        && average_matches
}

#[derive(Default)]
struct Limiter {
    entries: HashMap<String, VecDeque<i64>>,
}
impl Limiter {
    fn allow(&mut self, ip: &str, now: i64) -> bool {
        if !self.entries.contains_key(ip) && self.entries.len() >= 5000 {
            self.entries.retain(|_, times| {
                times
                    .back()
                    .is_some_and(|t| now.saturating_sub(*t) < 60_000)
            });
            if self.entries.len() >= 5000 {
                return false;
            }
        }
        let times = self.entries.entry(ip.into()).or_default();
        while times
            .front()
            .is_some_and(|t| now.saturating_sub(*t) >= 60_000)
        {
            times.pop_front();
        }
        if times.len() >= 300 {
            return false;
        }
        times.push_back(now);
        true
    }
}
#[derive(Clone)]
pub struct ArenaService {
    cache: Cache,
    storage: Storage,
    publication_enabled: bool,
    trusted_header: String,
    limiter: Arc<Mutex<Limiter>>,
}
pub struct ArenaResponse {
    pub status: StatusCode,
    pub body: Value,
    pub headers: HeaderMap,
    pub source: Option<&'static str>,
    pub cache: Option<&'static str>,
    pub averages_ms: Option<u64>,
    pub outcome: &'static str,
}
impl ArenaResponse {
    fn error(
        status: u16,
        message: &str,
        retry: bool,
        source: Option<&'static str>,
        outcome: &'static str,
    ) -> Self {
        let mut headers = HeaderMap::new();
        if retry {
            headers.insert("retry-after", HeaderValue::from_static("5"));
        }
        Self {
            status: StatusCode::from_u16(status).unwrap(),
            body: json!({"error":message}),
            headers,
            source,
            cache: None,
            averages_ms: None,
            outcome,
        }
    }
}
impl IntoResponse for ArenaResponse {
    fn into_response(self) -> Response {
        let mut response = (self.status, axum::Json(self.body)).into_response();
        response
            .headers_mut()
            .insert("content-type", HeaderValue::from_static("application/json"));
        response.headers_mut().extend(self.headers);
        response
    }
}
impl ArenaService {
    pub fn new(cache: Cache, storage: Storage) -> Self {
        let enabled = std::env::var("AVERAGE_PUBLICATIONS_ENABLED").ok();
        let publication_enabled = enabled.as_deref() != Some("false")
            && std::env::var("SQLITE_PATH").is_ok_and(|v| !v.is_empty())
            && (enabled.as_deref() == Some("true")
                || std::env::var("NODE_ENV").as_deref() == Ok("production"));
        let header = std::env::var("TRUSTED_IP_HEADER")
            .ok()
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| "x-real-ip".into());
        Self {
            cache,
            storage,
            publication_enabled,
            trusted_header: config::trim(&header).to_lowercase(),
            limiter: Arc::new(Mutex::new(Limiter::default())),
        }
    }
    pub fn allow(&self, headers: &HeaderMap, now: i64) -> bool {
        let ip = headers
            .get(&self.trusted_header)
            .and_then(|v| v.to_str().ok())
            .map(config::trim)
            .filter(|v| !v.is_empty() && v.len() <= 128)
            .unwrap_or("unknown");
        self.limiter.lock().unwrap().allow(ip, now)
    }
    pub async fn load(&self, query: &ArenaQuery, now: i64) -> ArenaResponse {
        if query.standard() && (self.publication_enabled || query.publication_only) {
            let publication = if self.publication_enabled {
                self.storage
                    .publication(format!("standard:{}:{}", query.mode, query.statistic), now)
                    .await
            } else {
                None
            };
            let Some(publication) =
                publication.filter(|p| valid_result(&p.payload, &query.input()))
            else {
                return ArenaResponse::error(
                    503,
                    if query.publication_only {
                        "Arena average publication unavailable"
                    } else {
                        "Arena averages are warming"
                    },
                    true,
                    Some("publication"),
                    "unavailable",
                );
            };
            let body = wrapped(publication.payload);
            let mut headers = HeaderMap::new();
            headers.insert(
                "cache-control",
                HeaderValue::from_static(
                    "public, max-age=60, s-maxage=300, stale-while-revalidate=600",
                ),
            );
            headers.insert("x-average-cache", HeaderValue::from_static("publication"));
            headers.insert("x-average-source", HeaderValue::from_static("publication"));
            for (name, value) in [
                ("x-average-generation", number_key(publication.generation)),
                (
                    "x-average-generated-at",
                    number_key(publication.generated_at),
                ),
                (
                    "x-average-stale",
                    if publication.stale { "1" } else { "0" }.into(),
                ),
            ] {
                headers.insert(name, HeaderValue::from_str(&value).unwrap());
            }
            return ArenaResponse {
                status: StatusCode::OK,
                body,
                headers,
                source: Some("publication"),
                cache: Some("hit"),
                averages_ms: None,
                outcome: "success",
            };
        }
        if query.publication_only {
            return ArenaResponse::error(
                503,
                "Arena average publication unavailable",
                true,
                Some("publication"),
                "unavailable",
            );
        }
        let version = self.storage.arena_version().await;
        let started = Instant::now();
        let job = json!({"kind":"arena_population","args":[query.input()]});
        let loaded = self
            .cache
            .load(query.cache_key(version), query.fallback_key(), job, now)
            .await;
        let elapsed = started.elapsed().as_millis() as u64;
        let mut response = match loaded {
            Ok(loaded) if loaded.value.is_null() => ArenaResponse::error(
                503,
                "Arena averages are unavailable",
                false,
                None,
                "unavailable",
            ),
            Ok(loaded) => {
                let mut headers = HeaderMap::new();
                headers.insert("cache-control", HeaderValue::from_static("no-store"));
                headers.insert(
                    "x-statistics-stale",
                    HeaderValue::from_static(if loaded.stale { "1" } else { "0" }),
                );
                headers.insert(
                    "x-statistics-generated-at",
                    HeaderValue::from_str(&number_key(loaded.generated_at)).unwrap(),
                );
                headers.insert("x-average-cache", HeaderValue::from_static("next-data"));
                headers.insert("x-average-source", HeaderValue::from_static("dynamic"));
                if loaded.stale {
                    headers.insert("retry-after", HeaderValue::from_static("5"));
                }
                ArenaResponse {
                    status: StatusCode::OK,
                    body: wrapped(loaded.value),
                    headers,
                    source: Some("dynamic"),
                    cache: Some(loaded.cache),
                    averages_ms: Some(elapsed),
                    outcome: "success",
                }
            }
            Err(error) if error.reason == "response_timeout" => ArenaResponse::error(
                503,
                "Arena averages are warming",
                true,
                Some("dynamic"),
                "unavailable",
            ),
            Err(error) => {
                eprintln!("Arena average stats failed: {}", error.message);
                ArenaResponse::error(
                    500,
                    "Failed to compute Arena averages",
                    false,
                    None,
                    "error",
                )
            }
        };
        response.averages_ms = Some(elapsed);
        if response.source == Some("dynamic") && response.outcome == "unavailable" {
            response.cache = Some("miss");
        }
        response
    }
    fn record(&self, response: &ArenaResponse, headers: &HeaderMap, elapsed: u64) {
        let stage = match response.outcome {
            "success" => None,
            "invalid" => Some("request"),
            "rate_limited" => Some("rate_limit"),
            "unavailable" => Some("dependency"),
            _ => Some("application"),
        };
        let mut event = json!({"event":"request_timing_v1","entry":"api","at":crate::now_ms(),"pid":std::process::id(),"operation":"average","outcome":response.outcome,"status":response.status.as_u16(),"total_ms":elapsed});
        if response.outcome != "rate_limited" {
            event["mode"] = json!("arena");
        }
        if elapsed >= 1000 {
            event["slow"] = json!(true);
        }
        for (name, value) in [
            ("source", response.source),
            ("cache", response.cache),
            (
                "storage",
                (response.outcome == "success").then_some("sqlite"),
            ),
            ("failure_stage", stage),
        ] {
            if let Some(value) = value {
                event[name] = json!(value);
            }
        }
        if let Some(value) = response.averages_ms {
            event["averages_ms"] = json!(value);
        }
        if stage.is_some() {
            event["error_code"] = json!(format!(
                "average_{}_{}",
                response.outcome,
                response.status.as_u16()
            ));
        }
        let host = headers
            .get("x-forwarded-host")
            .or_else(|| headers.get("host"))
            .and_then(|v| v.to_str().ok())
            .and_then(normalized_host);
        if let Some(host) = host {
            event["host"] = json!(host);
        }
        if elapsed >= 1000 || sampled() {
            crate::log_json(&event);
        }
        self.storage.event(event);
    }
}
fn normalized_host(raw: &str) -> Option<String> {
    let raw = config::trim(raw.split(',').next()?).to_lowercase();
    let host = raw
        .rsplit_once(':')
        .filter(|(_, port)| !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()))
        .map_or(raw.as_str(), |(host, _)| host);
    let host = host.strip_prefix("www.").unwrap_or(host);
    ["tarkovstats.ru", "tarkovstats.online"]
        .contains(&host)
        .then(|| host.into())
}
fn sampled() -> bool {
    let fallback = if std::env::var("NODE_ENV").as_deref() == Ok("production") {
        0.05
    } else {
        0.0
    };
    let rate = std::env::var("OBSERVABILITY_SAMPLE_RATE")
        .ok()
        .filter(|v| !config::trim(v).is_empty())
        .and_then(|v| number(&v))
        .map_or(fallback, |n| n.clamp(0.0, 1.0));
    if rate <= 0.0 {
        return false;
    }
    if rate >= 1.0 {
        return true;
    }
    // Sampling is operational, never security-sensitive. Mix a monotonic sequence
    // with the clock without adding a random dependency to the HTTP runtime.
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let mut n = NEXT
        .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        .wrapping_add(crate::now_ms() as u64);
    n = (n ^ (n >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
    n = (n ^ (n >> 27)).wrapping_mul(0x94d049bb133111eb);
    ((n ^ (n >> 31)) as f64 / u64::MAX as f64) < rate
}
fn normalize_zero(value: &mut Value) {
    match value {
        Value::Number(n) if n.as_f64() == Some(0.0) => *value = json!(0),
        Value::Array(values) => values.iter_mut().for_each(normalize_zero),
        Value::Object(values) => values.values_mut().for_each(normalize_zero),
        _ => {}
    }
}

fn wrapped(mut value: Value) -> Value {
    normalize_zero(&mut value);
    let mut result = json!({"mode":"arena","schemaVersion":PARSER_VERSION});
    if let Some(values) = value.as_object() {
        for (key, value) in values {
            result[key] = value.clone();
        }
    }
    result
}
pub async fn get(
    State(service): State<ArenaService>,
    RawQuery(raw): RawQuery,
    headers: HeaderMap,
) -> Response {
    let started = Instant::now();
    let now = crate::now_ms();
    let response = if !service.allow(&headers, now) {
        let mut response =
            ArenaResponse::error(429, "Rate limit exceeded", false, None, "rate_limited");
        response
            .headers
            .insert("cache-control", HeaderValue::from_static("no-store"));
        response
    } else {
        match ArenaQuery::parse(raw.as_deref().unwrap_or("")) {
            Ok(query) => service.load(&query, now).await,
            Err(message) => ArenaResponse::error(400, message, false, None, "invalid"),
        }
    };
    service.record(&response, &headers, started.elapsed().as_millis() as u64);
    response.into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn query_uses_first_duplicate_and_js_numeric_bounds() {
        let q=ArenaQuery::parse("mode=arena&arenaMode=teamFight&arenaMode=lastHero&minHours=0x10&maxHours=1.6e1&minMatches=%20&maxMatches=-0").unwrap();
        assert_eq!(q.mode, "teamFight");
        assert_eq!(
            normalized_host("WWW.Tarkovstats.ru:3000, ignored"),
            Some("tarkovstats.ru".into())
        );
        assert_eq!(normalized_host("tarkovstats.ru:bad"), None);
        assert_eq!(wrapped(json!({"zero":-0.0}))["zero"].to_string(), "0");
        assert_eq!(q.ranges, [Some(16.0), Some(16.0), Some(0.0), Some(-0.0)]);
        assert!(q.cache_key(0).contains("16,16,0,0,0]"));
        for extra in [
            "period=90d",
            "min=",
            "max=1",
            "statistic=",
            "minHours=NaN",
            "minHours=-1",
            "minMatches=4&maxMatches=3",
        ] {
            assert!(ArenaQuery::parse(&format!("mode=arena&arenaMode=teamFight&{extra}")).is_err());
        }
    }
    #[test]
    fn cache_keys_match_ecmascript_decimal_boundaries() {
        for (value, expected) in [
            (-0.0, "0"),
            (10.0, "10"),
            (1e-6, "0.000001"),
            (1e-7, "1e-7"),
            (1e20, "100000000000000000000"),
            (1e21, "1e+21"),
            (1.5, "1.5"),
        ] {
            assert_eq!(number_key(value), expected);
        }
        let q = ArenaQuery::parse("mode=arena&arenaMode=teamFight").unwrap();
        assert_eq!(
            q.cache_key(12),
            r#"["arena","teamFight","trimmed_mean","matches","players",null,null,null,null,12]"#
        );
        assert_eq!(
            q.fallback_key(),
            r#"[5,"[\"arena\",\"teamFight\",\"trimmed_mean\",\"matches\",\"players\",null,null,null,null,0]"]"#
        );
    }
    #[test]
    fn sliding_limit_does_not_extend_rejections_or_trust_fallbacks() {
        let mut limiter = Limiter::default();
        for _ in 0..300 {
            assert!(limiter.allow("unknown", 1));
        }
        assert!(!limiter.allow("unknown", 60000));
        assert!(limiter.allow("unknown", 60001));
        for i in 0..4999 {
            assert!(limiter.allow(&i.to_string(), 60001));
        }
        assert!(!limiter.allow("new", 60001));
        assert!(limiter.allow("new", 120001));
    }
    #[test]
    fn protocol_refuses_wrong_filters_and_primitive_answers() {
        let query = ArenaQuery::parse("mode=arena&arenaMode=teamFight").unwrap();
        let mut good = json!({"filterIdentity":query.input(),"sampleN":0,"total":0,"metrics":{},"coverage":{},"bounds":{"hours":{"min":null,"max":null},"matches":{"min":null,"max":null}},"buckets":[],"averageMatches":{"value":null,"count":0}});
        for metric in METRICS {
            good["metrics"][metric] = json!({"value":null,"count":0});
            good["coverage"][metric] = json!(0);
        }
        assert!(valid_result(&good, &query.input()));
        good.as_object_mut().unwrap().remove("averageMatches");
        assert!(valid_result(&good, &query.input()));
        good["averageMatches"] = Value::Null;
        assert!(valid_result(&good, &query.input()));
        for bucket in [
            Value::Null,
            json!({"min":0,"max":10,"sampleN":1,"metrics":{}}),
        ] {
            good["buckets"] = json!([bucket]);
            assert!(!valid_result(&good, &query.input()));
        }
        good["buckets"] = json!([]);
        good["bounds"]["hours"] = json!({"min":-10,"max":0});
        assert!(valid_result(&good, &query.input()));
        good["population"] = json!({"scannedAccounts":"1","playedAccounts":{}});
        assert!(!valid_result(&good, &query.input()));
        good.as_object_mut().unwrap().remove("population");
        good["filterIdentity"]["minMatches"] = json!(10);
        assert!(!valid_result(&good, &query.input()));
        good["filterIdentity"] = query.input();
        good["metrics"]["kd_ratio"]["value"] = json!("0.5");
        assert!(!valid_result(&good, &query.input()));
        assert!(!valid_result(&json!(7), &query.input()));
        assert!(!valid_result(
            &json!({"filterIdentity":{"mode":"lastHero"}}),
            &query.input()
        ));
        assert_eq!(crate::compute::Kind::ArenaPopulation.ttl_ms(), 900000.0);
        assert_eq!(crate::compute::Kind::Seasonal.ttl_ms(), 300000.0);
    }
}
