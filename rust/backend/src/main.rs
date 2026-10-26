pub mod achievements;
pub mod arena;
mod cache;
mod compute;
mod config;
mod http;
mod persistent;
mod persistent_ui;
mod progression;
pub mod reference;
mod seasonal_population;
mod showcase;
mod storage;
mod ui;

use axum::{
    Json, Router,
    routing::{any, get},
};
use serde_json::json;
use std::{
    env,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

pub fn log_json(value: &serde_json::Value) {
    use std::io::Write;
    let _ = writeln!(std::io::stdout().lock(), "{value}");
}
#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() {
    if let Err(error) = serve().await {
        eprintln!("Rust API failed: {error}");
        std::process::exit(1)
    }
}
async fn serve() -> Result<(), Box<dyn std::error::Error>> {
    let ui_enabled = ui_selector("ARENA_UI_UPSTREAM")?;
    let pve_enabled = ui_selector("PVE_UI_UPSTREAM")?;
    let regular_enabled = ui_selector("REGULAR_UI_UPSTREAM")?;
    let seasonal_enabled = ui_selector("SEASONAL_POPULATION_UI_UPSTREAM")?;
    let worker = compute::Worker::start().map_err(std::io::Error::other)?;
    let storage = storage::Storage::start();
    let config = config::Config::from_env();
    let showcase = showcase::Showcase::start(config.clone());
    let progression = progression::ProgressionService::new(storage.clone(), config.clone());
    let cache = cache::Cache::new(storage.clone(), worker.clone());
    let reference = reference::Reference::new(storage.clone()).map_err(std::io::Error::other)?;
    let achievements =
        achievements::AchievementsService::new(cache.clone(), storage.clone(), reference);
    let arena = arena::ArenaService::new(cache.clone(), storage.clone());
    let persistent =
        persistent::PersistentService::new(cache.clone(), storage.clone(), arena.clone());
    let arena_ui = if ui_enabled {
        Some(ui::Ui::start(arena.clone(), &config).map_err(std::io::Error::other)?)
    } else {
        None
    };
    let persistent_ui = if pve_enabled || regular_enabled || seasonal_enabled {
        Some(
            persistent_ui::PersistentUi::start(
                persistent.clone(),
                progression.clone(),
                arena.clone(),
                &config,
            )
            .map_err(std::io::Error::other)?,
        )
    } else {
        None
    };
    let state = Arc::new(http::App {
        config,
        cache,
        storage,
    });
    let app = Router::new()
        .route(
            "/api/seasonal/cohort",
            get(http::cohort)
                .options(http::options)
                .fallback(http::method_not_allowed),
        )
        .route("/api/seasonal/cohort/", any(http::trailing))
        .route(
            "/healthz",
            get(|| async { Json(json!({"status":"ok","service":"rust-api"})) }),
        )
        .with_state(state)
        .merge(
            Router::new()
                .route(
                    "/api/seasonal/average",
                    get(seasonal_population::get)
                        .options(http::options)
                        .fallback(http::method_not_allowed),
                )
                .route("/api/seasonal/average/", any(http::trailing))
                .route(
                    "/api/average",
                    get(persistent::average_get)
                        .options(http::options)
                        .fallback(http::method_not_allowed),
                )
                .route("/api/average/", any(http::trailing))
                .route(
                    "/api/average/metrics",
                    get(persistent::metrics_get)
                        .options(http::options)
                        .fallback(http::method_not_allowed),
                )
                .route("/api/average/metrics/", any(http::trailing))
                .with_state(persistent),
        )
        .merge(
            Router::new()
                .route(
                    "/api/home/showcase",
                    get(showcase::get)
                        .options(http::options)
                        .fallback(http::method_not_allowed),
                )
                .route("/api/home/showcase/", any(http::trailing))
                .with_state(showcase),
        )
        .merge(
            Router::new()
                .route(
                    "/api/progression/average",
                    get(progression::get)
                        .options(http::options)
                        .fallback(http::method_not_allowed),
                )
                .route("/api/progression/average/", any(http::trailing))
                .with_state(progression),
        );
    let app = app.merge(
        Router::new()
            .route(
                "/api/average/achievements",
                get(achievements::get)
                    .options(http::options)
                    .fallback(http::method_not_allowed),
            )
            .route("/api/average/achievements/", any(http::trailing))
            .with_state(achievements),
    );
    let app = if let Some(state) = arena_ui {
        app.merge(
            Router::new()
                .route(
                    "/population/arena",
                    get(ui::page)
                        .options(http::options)
                        .fallback(http::method_not_allowed),
                )
                .route("/population/arena/", any(http::trailing))
                .route("/average/arena", any(ui::alias))
                .route("/average/arena/", any(http::trailing))
                .route(
                    "/_rust/arena/{version}/{name}",
                    get(ui::asset)
                        .options(http::options)
                        .fallback(http::method_not_allowed),
                )
                .with_state(state),
        )
    } else {
        app
    };
    let app = if let Some(ui) = persistent_ui {
        let routes = Router::new().route(
            "/_rust/persistent/{version}/{name}",
            get(persistent_ui::asset)
                .options(http::options)
                .fallback(http::method_not_allowed),
        );
        let routes = if pve_enabled {
            routes
                .route(
                    "/population/pve",
                    get(persistent_ui::pve)
                        .options(http::options)
                        .fallback(http::method_not_allowed),
                )
                .route("/population/pve/", any(http::trailing))
                .route("/average/pve", any(persistent_ui::alias))
                .route("/average/pve/", any(http::trailing))
        } else {
            routes
        };
        let routes = if regular_enabled {
            routes
                .route(
                    "/population/regular",
                    get(persistent_ui::regular)
                        .options(http::options)
                        .fallback(http::method_not_allowed),
                )
                .route("/population/regular/", any(http::trailing))
                .route("/average/regular", any(persistent_ui::alias))
                .route("/average/regular/", any(http::trailing))
        } else {
            routes
        };
        let routes = if seasonal_enabled {
            routes
                .route(
                    "/population/pvp-season",
                    get(persistent_ui::seasonal)
                        .options(http::options)
                        .fallback(http::method_not_allowed),
                )
                .route("/population/pvp-season/", any(http::trailing))
                .route("/average/pvp-season", any(persistent_ui::alias))
                .route("/average/pvp-season/", any(http::trailing))
        } else {
            routes
        };
        app.merge(routes.with_state(ui))
    } else {
        app
    };
    let app = http::secure(app);
    let bind = env::var("RUST_API_BIND").unwrap_or_else(|_| "127.0.0.1:3001".into());
    let listener = tokio::net::TcpListener::bind(bind).await?;
    log_json(&json!({"event":"rust_api_ready","address":listener.local_addr()?.to_string()}));
    let signal_worker = worker.clone();
    axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            shutdown_signal().await;
            signal_worker.shutdown();
        })
        .await?;
    worker.stop().await;
    Ok(())
}
fn ui_selector(name: &str) -> Result<bool, Box<dyn std::error::Error>> {
    match env::var(name).as_deref() {
        Err(_) | Ok("") | Ok("web:3000") => Ok(false),
        Ok("web:3001") => Ok(true),
        _ => Err(format!("{name} must be web:3000 or web:3001").into()),
    }
}
async fn shutdown_signal() {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .expect("SIGTERM handler");
        tokio::select! {_=tokio::signal::ctrl_c()=>{},_=terminate.recv()=>{}}
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}
