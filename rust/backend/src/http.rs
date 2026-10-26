use crate::{
    cache::{Cache, Loaded},
    config::{self, Config},
    storage::Storage,
};
use axum::{
    Json,
    extract::{RawQuery, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode, Uri},
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use std::{sync::Arc, time::Instant};

#[derive(Clone)]
pub struct App {
    pub config: Config,
    pub cache: Cache,
    pub storage: Storage,
}
struct Timing {
    started: Instant,
    aid: Option<i64>,
    cycle: Option<String>,
    request_id: Option<String>,
}
#[derive(Default)]
struct Report {
    status: u16,
    outcome: &'static str,
    source: Option<&'static str>,
    cache: Option<&'static str>,
    storage: Option<&'static str>,
    cohort_ms: Option<u64>,
    phases: Option<(u64, u64)>,
}
fn uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
}
impl Timing {
    fn finish(
        &self,
        app: &App,
        report: Report,
        body: Value,
        no_store: bool,
        cache: Option<&Loaded>,
    ) -> Response {
        let stage = if report.outcome == "success" {
            None
        } else if matches!(report.outcome, "invalid" | "not_found") {
            Some("request")
        } else if report.storage == Some("unavailable") {
            Some("storage")
        } else if report.outcome == "unavailable" {
            Some("dependency")
        } else {
            Some("application")
        };
        let mut event = json!({"event":"request_timing_v1","entry":"api","at":crate::now_ms(),"pid":std::process::id(),"operation":"average_cohort","mode":"seasonal","aid":self.aid,"aid_state":if self.aid.is_some(){"valid"}else{"missing"},"outcome":report.outcome,"status":report.status,"total_ms":self.started.elapsed().as_millis()as u64});
        if self.started.elapsed().as_millis() >= 1000 {
            event["slow"] = json!(true)
        }
        for (key, value) in [
            ("cycle", self.cycle.as_deref()),
            ("request_id", self.request_id.as_deref()),
            ("source", report.source),
            ("cache", report.cache),
            ("storage", report.storage),
            ("failure_stage", stage),
        ] {
            if let Some(value) = value {
                event[key] = json!(value)
            }
        }
        if stage.is_some() {
            event["error_code"] = json!(format!(
                "average_cohort_{}_{}",
                report.outcome, report.status
            ));
        }
        if let Some(cohort) = report.cohort_ms {
            event["cohort_ms"] = json!(cohort)
        }
        if let Some((queue, worker)) = report.phases {
            event["queue_ms"] = json!(queue);
            event["worker_ms"] = json!(worker);
        }
        crate::log_json(&event);
        app.storage.event(event);
        let mut response = (
            StatusCode::from_u16(report.status).expect("known status"),
            Json(body),
        )
            .into_response();
        if no_store {
            response
                .headers_mut()
                .insert("cache-control", HeaderValue::from_static("no-store"));
        }
        if let Some(cache) = cache {
            response.headers_mut().insert(
                "x-statistics-stale",
                HeaderValue::from_static(if cache.stale { "1" } else { "0" }),
            );
            response.headers_mut().insert(
                "x-statistics-generated-at",
                HeaderValue::from_str(&cache.generated_at.to_string()).expect("finite generation"),
            );
            if cache.stale {
                response
                    .headers_mut()
                    .insert("retry-after", HeaderValue::from_static("5"));
            }
        }
        response
    }
}

pub async fn cohort(
    State(app): State<Arc<App>>,
    RawQuery(raw): RawQuery,
    headers: HeaderMap,
) -> Response {
    let mut timing = Timing {
        started: Instant::now(),
        aid: None,
        cycle: None,
        request_id: headers
            .get("x-request-id")
            .and_then(|v| v.to_str().ok())
            .filter(|v| uuid(v))
            .map(str::to_string),
    };
    let params = config::query(raw.as_deref().unwrap_or(""));
    let get = |key: &str| params.get(key).map(String::as_str);
    let aid = config::player_id(get("aid").unwrap_or(""));
    let cycle = get("cycle")
        .and_then(config::cycle)
        .filter(|cycle| cycle != "persistent");
    timing.aid = aid;
    timing.cycle = cycle.clone();
    let identity = json!({"aid":aid.unwrap_or(0),"mode":"seasonal","cycleId":cycle.as_deref().or_else(||get("cycle")).unwrap_or("")});
    if get("mode").is_some_and(|mode| mode != "seasonal") || aid.is_none() || cycle.is_none() {
        return timing.finish(
            &app,
            Report {
                status: 400,
                outcome: "invalid",
                ..Report::default()
            },
            json!({"identity":identity,"error":"aid and cycle are required"}),
            false,
            None,
        );
    }
    let aid = aid.unwrap();
    let cycle = cycle.unwrap();
    let statistic = get("statistic").unwrap_or("trimmed_mean");
    let period = get("period").unwrap_or("all");
    let dimension = get("dimension").unwrap_or("hours");
    if !["trimmed_mean", "median"].contains(&statistic)
        || !["all", "90d"].contains(&period)
        || !["hours", "pmc_raids"].contains(&dimension)
    {
        return timing.finish(
            &app,
            Report {
                status: 400,
                outcome: "invalid",
                ..Report::default()
            },
            json!({"identity":identity,"error":"Invalid comparison parameters"}),
            false,
            None,
        );
    }
    let now = crate::now_ms();
    if !app.config.ready(&cycle, now) {
        return timing.finish(&app,Report{status:404,outcome:"unavailable",..Report::default()},json!({"identity":identity,"code":"cycle_unavailable","error":"Seasonal cycle is unavailable"}),true,None);
    }
    let revision = get("revision")
        .filter(|revision| {
            !revision.is_empty()
                && revision.len() <= 64
                && revision
                    .bytes()
                    .all(|ch| ch.is_ascii_alphanumeric() || ch == b'-')
        })
        .unwrap_or("");
    let bucket = if period == "90d" { now / 300000 } else { 0 };
    let key = format!("{cycle}:{aid}:{dimension}:{statistic}:{period}:{bucket}:{revision}");
    let fallback = format!("seasonal-cohort:{cycle}:{aid}:{dimension}:{statistic}:{period}:0:");
    let mut input = json!({"aid":aid,"cycleId":cycle,"dimension":dimension,"statistic":statistic,"period":period});
    if !revision.is_empty() {
        input["revision"] = json!(revision)
    }
    let args = json!({"kind":"seasonal","args":[input,now]});
    let started = Instant::now();
    match app.cache.load(key, fallback, args, now).await {
        Ok(loaded) => {
            let report = Report {
                source: Some("stored"),
                cache: Some(loaded.cache),
                storage: Some("sqlite"),
                cohort_ms: Some(started.elapsed().as_millis() as u64),
                phases: loaded.phases,
                ..Report::default()
            };
            if loaded.value.get("available").and_then(Value::as_bool) != Some(true) {
                return timing.finish(&app,Report{status:503,outcome:"error",storage:Some("unavailable"),..report},json!({"identity":identity,"code":"comparison_unavailable","error":"Comparison storage is unavailable"}),true,None);
            }
            let result = loaded.value.get("result").cloned().unwrap_or(Value::Null);
            if result.is_null() {
                return timing.finish(&app,Report{status:404,outcome:"not_found",..report},json!({"identity":identity,"code":"profile_unavailable","error":"Seasonal profile is not available for comparison"}),true,None);
            }
            let mut result = result;
            result["percentiles"] = Value::Null;
            result["statistic"] = json!(statistic);
            result["period"] = json!(period);
            timing.finish(
                &app,
                Report {
                    status: 200,
                    outcome: "success",
                    ..report
                },
                result,
                true,
                Some(&loaded),
            )
        }
        Err(error) => {
            eprintln!(
                "Seasonal comparison cohort failed ({}): {}",
                error.reason, error.message
            );
            timing.finish(&app,Report{status:503,outcome:"error",..Report::default()},json!({"identity":identity,"code":"comparison_unavailable","error":"Failed to compute comparison cohort"}),true,None)
        }
    }
}

pub async fn options() -> Response {
    let mut response = StatusCode::NO_CONTENT.into_response();
    response
        .headers_mut()
        .insert("allow", HeaderValue::from_static("GET, HEAD, OPTIONS"));
    response
}
pub async fn method_not_allowed() -> StatusCode {
    StatusCode::METHOD_NOT_ALLOWED
}
pub async fn trailing(method: Method, uri: Uri) -> Response {
    let location = format!(
        "/api/seasonal/cohort{}",
        uri.query()
            .map_or(String::new(), |query| format!("?{query}"))
    );
    let body = if method == Method::HEAD {
        axum::body::Body::empty()
    } else {
        axum::body::Body::from(location.clone())
    };
    let mut response = Response::new(body);
    *response.status_mut() = StatusCode::PERMANENT_REDIRECT;
    if let (Ok(header), Ok(refresh)) = (
        HeaderValue::from_str(&location),
        HeaderValue::from_str(&format!("0;url={location}")),
    ) {
        response.headers_mut().insert("location", header);
        response.headers_mut().insert("refresh", refresh);
    }
    response
}
// Router::layer wraps individual method handlers. Axum appends its generated
// Allow header after those handlers return, so security must wrap the completed
// router to preserve Next's empty 405 without removing the explicit OPTIONS Allow.
pub fn secure(routes: axum::Router) -> axum::Router {
    axum::Router::new()
        .fallback_service(routes)
        .layer(axum::middleware::from_fn(security))
}
pub async fn security(request: axum::extract::Request, next: axum::middleware::Next) -> Response {
    let early_redirect = request.uri().path() == "/api/seasonal/cohort/";
    let mut response = next.run(request).await;
    // Next normalizes this path before application/global Next headers run.
    // The public proxy still applies its existing HSTS policy.
    if early_redirect && response.status() == StatusCode::PERMANENT_REDIRECT {
        return response;
    }
    let dev = std::env::var("NODE_ENV").as_deref() == Ok("development");
    let csp = format!(
        "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://static.cloudflareinsights.com{}; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data: https://lh3.googleusercontent.com https://assets.tarkov.dev https://imagemagic.tarkov.dev https://cdn.discordapp.com https://media.discordapp.net; font-src 'self'; connect-src 'self' https://cloudflareinsights.com{}; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests",
        if dev { " 'unsafe-eval'" } else { "" },
        if dev { " ws:" } else { "" }
    );
    for (key, value) in [
        ("content-security-policy", csp.as_str()),
        ("x-frame-options", "DENY"),
        ("x-content-type-options", "nosniff"),
        ("referrer-policy", "strict-origin-when-cross-origin"),
        (
            "permissions-policy",
            "camera=(), microphone=(), geolocation=(), interest-cohort=()",
        ),
        ("x-dns-prefetch-control", "on"),
    ] {
        response.headers_mut().insert(
            axum::http::header::HeaderName::from_static(key),
            HeaderValue::from_str(value).expect("static security header"),
        );
    }
    if !dev {
        response.headers_mut().insert(
            "strict-transport-security",
            HeaderValue::from_static("max-age=31536000; includeSubDomains"),
        );
    }
    if response.status() == StatusCode::METHOD_NOT_ALLOWED {
        response.headers_mut().remove("allow");
    }
    response
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn request_ids_accept_only_bounded_uuid_shape() {
        assert!(uuid("12345678-1234-5678-9abc-123456789abc"));
        assert!(!uuid("secret arbitrary query"));
    }
    #[tokio::test]
    async fn outer_security_keeps_options_allow_but_strips_generated_method_allow() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let routes = axum::Router::new().route(
            "/boundary",
            axum::routing::get(|| async { StatusCode::OK })
                .options(options)
                .fallback(method_not_allowed),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (stop, done) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            axum::serve(listener, secure(routes))
                .with_graceful_shutdown(async {
                    let _ = done.await;
                })
                .await
                .unwrap();
        });
        for (method, status, allow) in [
            ("POST", 405, None),
            ("OPTIONS", 204, Some("get, head, options")),
            ("GET", 200, None),
        ] {
            let mut stream = tokio::net::TcpStream::connect(address).await.unwrap();
            stream.write_all(format!("{method} /boundary HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Length: 0\r\n\r\n").as_bytes()).await.unwrap();
            let mut wire = String::new();
            tokio::time::timeout(
                std::time::Duration::from_secs(2),
                stream.read_to_string(&mut wire),
            )
            .await
            .unwrap()
            .unwrap();
            let headers = wire.split("\r\n\r\n").next().unwrap().to_ascii_lowercase();
            assert!(headers.starts_with(&format!("http/1.1 {status}")), "{wire}");
            let actual_allow = headers
                .lines()
                .find_map(|line| line.strip_prefix("allow: "));
            assert_eq!(actual_allow, allow);
            assert!(headers.contains("x-content-type-options: nosniff"));
        }
        let _ = stop.send(());
        server.await.unwrap();
    }
    #[tokio::test]
    async fn trailing_redirect_matches_next_before_method_dispatch_and_security() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let routes =
            axum::Router::new().route("/api/seasonal/cohort/", axum::routing::any(trailing));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (stop, done) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            axum::serve(listener, secure(routes))
                .with_graceful_shutdown(async {
                    let _ = done.await;
                })
                .await
                .unwrap();
        });
        let query = "aid=1&cycle=native-s1&label=a%2Bb&label=c+d";
        let location = format!("/api/seasonal/cohort?{query}");
        for method in ["GET", "HEAD", "POST"] {
            let mut stream = tokio::net::TcpStream::connect(address).await.unwrap();
            stream.write_all(format!("{method} /api/seasonal/cohort/?{query} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Length: 0\r\n\r\n").as_bytes()).await.unwrap();
            let mut wire = String::new();
            tokio::time::timeout(
                std::time::Duration::from_secs(2),
                stream.read_to_string(&mut wire),
            )
            .await
            .unwrap()
            .unwrap();
            let (headers, body) = wire.split_once("\r\n\r\n").unwrap();
            assert!(headers.starts_with("HTTP/1.1 308"));
            let header = |name: &str| {
                headers
                    .lines()
                    .filter_map(|line| line.split_once(':'))
                    .find_map(|(key, value)| key.eq_ignore_ascii_case(name).then(|| value.trim()))
            };
            assert_eq!(header("location"), Some(location.as_str()));
            assert_eq!(
                header("refresh"),
                Some(format!("0;url={location}").as_str())
            );
            for name in [
                "content-type",
                "content-security-policy",
                "x-frame-options",
                "x-content-type-options",
                "referrer-policy",
                "permissions-policy",
                "x-dns-prefetch-control",
                "strict-transport-security",
            ] {
                assert_eq!(header(name), None, "unexpected {name} on early redirect");
            }
            assert_eq!(body, if method == "HEAD" { "" } else { &location });
        }
        let _ = stop.send(());
        server.await.unwrap();
    }
}
