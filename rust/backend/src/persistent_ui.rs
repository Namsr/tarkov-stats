use crate::{
    arena::ArenaService,
    config::Config,
    persistent::{AverageQuery, PersistentResponse, PersistentService},
    progression::ProgressionService,
    ui,
};
use axum::{
    body::Body,
    extract::{Path, State},
    http::{HeaderMap, HeaderValue, Method, Request, StatusCode, Uri},
    response::{IntoResponse, Response},
};
use std::{env, path::PathBuf, time::Instant};
use tarkov_ui::persistent::{
    data::{InitialReply, PersistentInitial, bundled_level_bands},
    state::PersistentState,
};

#[derive(Clone)]
pub struct PersistentUi {
    assets: ui::Ui,
    service: PersistentService,
    progression: ProgressionService,
    seasonal_cycle: Option<String>,
}
impl PersistentUi {
    pub fn start(
        service: PersistentService,
        progression: ProgressionService,
        arena: ArenaService,
        config: &Config,
    ) -> Result<Self, String> {
        if env::var("NODE_ENV").as_deref() == Ok("development")
            && env::var("LOCAL_FAKE_AVERAGE").as_deref() == Ok("1")
        {
            return Err(
                "Native persistent UI requires real fixture data; disable LOCAL_FAKE_AVERAGE"
                    .into(),
            );
        }
        let root = env::var("RUST_PERSISTENT_UI_ASSETS")
            .unwrap_or_else(|_| "public/_rust/persistent".into());
        let assets = ui::Ui::start_at(arena, config, PathBuf::from(root))?;
        Ok(Self {
            assets,
            service,
            progression,
            seasonal_cycle: config.available_cycle.clone(),
        })
    }
    async fn page(&self, mode: &str, request: Request<Body>) -> Response {
        let started = Instant::now();
        let lang = ui::language(request.headers());
        let now = crate::now_ms();
        if !self.service.allow(request.headers(), now) {
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
        let state = match PersistentState::read(mode, request.uri().query().unwrap_or("")) {
            Ok(state) => state,
            Err(_) => return StatusCode::NOT_FOUND.into_response(),
        };
        let requests = state.requests();
        let selected = async {
            if state.invalid {
                return InitialReply {
                    status: 400,
                    ..InitialReply::default()
                };
            }
            average(&self.service, &requests[0], now).await
        };
        let context = average(&self.service, &requests[1], now);
        let progression = self.progression.load(mode, "persistent", now);
        let (selected, context, progression) = tokio::join!(selected, context, progression);
        let progression = progression.map_or_else(
            || InitialReply {
                status: 503,
                ..InitialReply::default()
            },
            |value| InitialReply {
                body: Some(value.value),
                generated_at: value.generated_at,
                publication_stale: value.stale,
                ..InitialReply::default()
            },
        );
        let initial = PersistentInitial {
            state,
            selected,
            context,
            progression,
            // Metadata network refresh must never delay useful main HTML.
            // Metrics keep the legacy successful-progression mount gate.
            metrics: InitialReply::default(),
            achievements: InitialReply::default(),
            level_bands: bundled_level_bands(),
            seasonal_cycle: self.seasonal_cycle.clone(),
        };
        let package = self.assets.package("_rust/persistent");
        let handler = leptos_axum::render_app_to_stream_with_context(
            || {},
            move || tarkov_ui::app::persistent_document(initial.clone(), lang, package.clone()),
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
                "population_data;dur={:.3}",
                started.elapsed().as_secs_f64() * 1000.0
            ))
            .unwrap(),
        );
        response
    }
}
async fn average(service: &PersistentService, url: &str, now: i64) -> InitialReply {
    let query = url.split_once('?').map_or("", |(_, query)| query);
    let Ok(query) = AverageQuery::parse(query) else {
        return InitialReply {
            status: 400,
            ..InitialReply::default()
        };
    };
    let PersistentResponse {
        status,
        body,
        headers,
        ..
    } = service.load_average(&query, now).await;
    InitialReply {
        body: status.is_success().then_some(body),
        status: status.as_u16(),
        stale: headers.get("x-statistics-stale").is_some_and(|v| v == "1"),
        publication_stale: headers.get("x-average-stale").is_some_and(|v| v == "1"),
        retry_after: ui::retry(&headers),
        generated_at: ui::generated(&headers),
    }
}
pub async fn pve(State(ui): State<PersistentUi>, request: Request<Body>) -> Response {
    ui.page("pve", request).await
}
pub async fn regular(State(ui): State<PersistentUi>, request: Request<Body>) -> Response {
    ui.page("regular", request).await
}
pub async fn asset(
    State(ui): State<PersistentUi>,
    path: Path<(String, String)>,
    headers: HeaderMap,
) -> Response {
    ui::asset(State(ui.assets), path, headers).await
}
pub async fn alias(method: Method, uri: Uri) -> Response {
    let Some(mode) = uri
        .path()
        .strip_prefix("/average/")
        .filter(|mode| ["pve", "regular"].contains(mode))
    else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let query = uri
        .query()
        .map_or(String::new(), |query| format!("?{query}"));
    crate::http::redirect(method, format!("/population/{mode}{query}"))
}
