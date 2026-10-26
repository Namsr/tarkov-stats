use crate::{
    arena::{ArenaQuery, ArenaService},
    config::Config,
};
use axum::{
    body::{Body, Bytes},
    extract::{Path, State},
    http::{HeaderMap, HeaderValue, Method, Request, StatusCode, Uri},
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::io::Read;
use std::{collections::HashMap, path::PathBuf, sync::Arc, time::Instant};
use tarkov_ui::{
    data::{ArenaInitial, InitialMeta},
    i18n::Lang,
    state::ArenaState,
};

#[derive(Deserialize)]
struct Manifest {
    version: u8,
    hash: String,
    files: HashMap<String, FileInfo>,
}
#[derive(Deserialize)]
struct FileInfo {
    bytes: usize,
    sha256: String,
}
#[derive(Clone)]
struct Asset {
    body: Bytes,
    kind: &'static str,
    etag: HeaderValue,
}
#[derive(Clone)]
pub struct Ui {
    service: ArenaService,
    hash: String,
    assets: HashMap<String, Asset>,
    cycle: Option<String>,
}
fn hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|v| v.is_ascii_digit() || (b'a'..=b'f').contains(&v))
}
impl Ui {
    pub fn start(service: ArenaService, config: &Config) -> Result<Self, String> {
        let root = PathBuf::from(
            std::env::var("RUST_UI_ASSETS").unwrap_or_else(|_| "public/_rust/arena".into()),
        );
        let manifest_file = std::fs::File::open(root.join("manifest.json"))
            .map_err(|e| format!("Rust UI asset manifest unavailable: {e}"))?;
        let mut encoded = Vec::new();
        manifest_file
            .take(65537)
            .read_to_end(&mut encoded)
            .map_err(|e| e.to_string())?;
        if encoded.len() > 65536 {
            return Err("Rust UI manifest exceeds64KiB".into());
        }
        let manifest: Manifest = serde_json::from_slice(&encoded).map_err(|e| e.to_string())?;
        if manifest.version != 1 || !hash(&manifest.hash) || manifest.files.len() != 3 {
            return Err("Invalid Rust UI manifest".into());
        }
        let mut assets = HashMap::new();
        let mut total = 0;
        let mut package = Sha256::new();
        for (name, kind) in [
            ("tarkov_ui.js", "text/javascript; charset=utf-8"),
            ("tarkov_ui_bg.wasm", "application/wasm"),
            ("tarkov_ui.css", "text/css; charset=utf-8"),
        ] {
            let info = manifest.files.get(name).ok_or("Missing Rust UI asset")?;
            if info.bytes == 0 || info.bytes > 8 * 1024 * 1024 || !hash(&info.sha256) {
                return Err("Invalid Rust UI asset metadata".into());
            }
            let file = std::fs::File::open(root.join(&manifest.hash).join(name))
                .map_err(|e| e.to_string())?;
            if file.metadata().map_err(|e| e.to_string())?.len() != info.bytes as u64 {
                return Err("Rust UI asset length mismatch".into());
            }
            let mut body = Vec::with_capacity(info.bytes);
            file.take(info.bytes as u64 + 1)
                .read_to_end(&mut body)
                .map_err(|e| e.to_string())?;
            total += body.len();
            if format!("{:x}", Sha256::digest(&body)) != info.sha256 {
                return Err("Rust UI asset checksum mismatch".into());
            }
            package.update(name.as_bytes());
            package.update([0]);
            package.update(body.len().to_string().as_bytes());
            package.update([0]);
            package.update(&body);
            if body.len() != info.bytes || total > 16 * 1024 * 1024 {
                return Err("Rust UI asset size mismatch".into());
            }
            let etag = HeaderValue::from_str(&format!("\"{}\"", info.sha256))
                .map_err(|e| e.to_string())?;
            assets.insert(
                name.into(),
                Asset {
                    body: Bytes::from_owner(Arc::<[u8]>::from(body)),
                    kind,
                    etag,
                },
            );
        }
        if format!("{:x}", package.finalize()) != manifest.hash {
            return Err("Rust UI package checksum mismatch".into());
        }
        // Custom Axum routes skip LeptosRoutes' executor setup. Streaming SSR
        // spawns scoped tasks, so install its Tokio adapter before readiness.
        let _ = any_spawner::Executor::init_tokio();
        Ok(Self {
            service,
            hash: manifest.hash,
            assets,
            cycle: config.available_cycle.clone(),
        })
    }
}
pub fn language(headers: &HeaderMap) -> Lang {
    let mut cookie = None;
    if let Some(value) = headers.get("cookie").and_then(|v| v.to_str().ok()) {
        for item in value.split(';') {
            if let Some((key, value)) = item.trim().split_once('=')
                && key == "lang"
            {
                let mut rest = value;
                let mut valid = true;
                while let Some(index) = rest.find('%') {
                    let tail = &rest[index + 1..];
                    if tail.len() < 2 || !tail.as_bytes()[..2].iter().all(u8::is_ascii_hexdigit) {
                        valid = false;
                        break;
                    }
                    rest = &tail[2..];
                }
                if valid
                    && let Ok(decoded) = percent_encoding::percent_decode_str(value).decode_utf8()
                {
                    cookie = Some(decoded.into_owned());
                }
            }
        }
    }
    match cookie.as_deref() {
        Some("ru") => return Lang::Ru,
        Some("en") => return Lang::En,
        _ => {}
    }
    let accept = headers
        .get("accept-language")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    let ru = accept.starts_with("ru")
        || accept.as_bytes().windows(3).enumerate().any(|(i, bytes)| {
            matches!(bytes[0], b' ' | b',')
                && bytes[1..] == *b"ru"
                && accept
                    .as_bytes()
                    .get(i + 3)
                    .is_none_or(|v| !v.is_ascii_alphanumeric() && *v != b'_')
        });
    if ru { Lang::Ru } else { Lang::En }
}
pub async fn page(State(ui): State<Ui>, request: Request<Body>) -> Response {
    let started = Instant::now();
    let lang = language(request.headers());
    if !ui.service.allow(request.headers(), crate::now_ms()) {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            [("cache-control", "no-store")],
            lang.t("common.notAvailable"),
        )
            .into_response();
    }
    if request.method() == Method::HEAD {
        return (
            [
                ("content-type", "text/html; charset=utf-8"),
                ("cache-control", "no-store"),
                ("vary", "Cookie, Accept-Language"),
            ],
            Body::empty(),
        )
            .into_response();
    }
    let state = ArenaState::read(request.uri().query().unwrap_or(""));
    let selected = ArenaQuery::parse(state.selected_request().split_once('?').unwrap().1);
    let context = ArenaQuery::parse(state.context_request().split_once('?').unwrap().1);
    let mut initial = ArenaInitial::new(state.clone(), None, None, None);
    initial.seasonal_cycle = ui.cycle.clone();
    if let Ok(context_query) = context {
        if let Ok(query) = selected
            && !state.filters[state.selected].invalid()
        {
            let (selected, context) = tokio::join!(
                ui.service.load(&query, crate::now_ms()),
                ui.service.load(&context_query, crate::now_ms())
            );
            initial.meta = InitialMeta {
                selected_status: selected.status.as_u16(),
                context_status: context.status.as_u16(),
                selected_stale: selected
                    .headers
                    .get("x-statistics-stale")
                    .is_some_and(|v| v == "1"),
                context_stale: context
                    .headers
                    .get("x-statistics-stale")
                    .is_some_and(|v| v == "1"),
                selected_retry_after: retry(&selected.headers),
                context_retry_after: retry(&context.headers),
                selected_generated_at: generated(&selected.headers),
                context_generated_at: generated(&context.headers),
            };
            if selected.status.is_success() {
                initial.selected = Some(selected.body);
            }
            if context.status.is_success() {
                initial.context = Some(context.body);
            }
        } else {
            let context = ui.service.load(&context_query, crate::now_ms()).await;
            initial.meta.selected_status = 400;
            initial.meta.context_status = context.status.as_u16();
            initial.meta.context_stale = context
                .headers
                .get("x-statistics-stale")
                .is_some_and(|v| v == "1");
            initial.meta.context_retry_after = retry(&context.headers);
            initial.meta.context_generated_at = generated(&context.headers);
            if context.status.is_success() {
                initial.context = Some(context.body);
            }
        }
    }
    initial.overview = initial.context.clone();
    let package = format!("_rust/arena/{}", ui.hash);
    let handler = leptos_axum::render_app_to_stream_with_context(
        || {},
        move || tarkov_ui::app::document(initial.clone(), lang, package.clone()),
    );
    let mut response = handler(request).await;
    response
        .headers_mut()
        .insert("cache-control", HeaderValue::from_static("no-store"));
    response
        .headers_mut()
        .insert("vary", HeaderValue::from_static("Cookie, Accept-Language"));
    response.headers_mut().insert(
        "server-timing",
        HeaderValue::from_str(&format!(
            "arena_data;dur={:.3}",
            started.elapsed().as_secs_f64() * 1000.0
        ))
        .unwrap(),
    );
    response
}
fn generated(headers: &HeaderMap) -> f64 {
    headers
        .get("x-statistics-generated-at")
        .or_else(|| headers.get("x-average-generated-at"))
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<f64>().ok())
        .filter(|v| v.is_finite() && *v >= 0.0)
        .unwrap_or(0.0)
}
fn retry(headers: &HeaderMap) -> u64 {
    headers
        .get("retry-after")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok())
        .unwrap_or(5)
        .clamp(1, 15)
}
pub async fn asset(
    State(ui): State<Ui>,
    Path((version, name)): Path<(String, String)>,
    headers: HeaderMap,
) -> Response {
    let Some(asset) = ui.assets.get(&name).filter(|_| version == ui.hash) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let fresh = headers.get("if-none-match") == Some(&asset.etag);
    let mut response = if fresh {
        StatusCode::NOT_MODIFIED.into_response()
    } else {
        asset.body.clone().into_response()
    };
    response
        .headers_mut()
        .insert("content-type", HeaderValue::from_static(asset.kind));
    response.headers_mut().insert(
        "cache-control",
        HeaderValue::from_static("public, max-age=31536000, immutable"),
    );
    response.headers_mut().insert("etag", asset.etag.clone());
    response
}
pub async fn alias(method: Method, uri: Uri) -> Response {
    let location = format!(
        "/population/arena{}",
        uri.query().map(|q| format!("?{q}")).unwrap_or_default()
    );
    let body = if method == Method::HEAD {
        Body::empty()
    } else {
        Body::from(location.clone())
    };
    let mut response = Response::new(body);
    *response.status_mut() = StatusCode::PERMANENT_REDIRECT;
    if let Ok(value) = HeaderValue::from_str(&location) {
        response.headers_mut().insert("location", value);
    }
    response
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn language_matches_existing_cookie_and_accept_precedence() {
        let mut h = HeaderMap::new();
        h.insert("accept-language", HeaderValue::from_static("en-US,ru;q=0"));
        assert_eq!(language(&h), Lang::Ru);
        h.insert("cookie", HeaderValue::from_static("lang=en"));
        assert_eq!(language(&h), Lang::En);
        h.insert("cookie", HeaderValue::from_static("lang=bad; lang=%72u"));
        assert_eq!(language(&h), Lang::Ru);
        h.insert("cookie", HeaderValue::from_static("lang=en;lang=%invalid"));
        assert_eq!(language(&h), Lang::En);
        h.insert("cookie", HeaderValue::from_static("lang=en;lang=%FF"));
        assert_eq!(language(&h), Lang::En);
        h.insert("cookie", HeaderValue::from_static("lang=en;lang=bad"));
        assert_eq!(language(&h), Lang::Ru);
    }
}
