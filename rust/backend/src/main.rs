pub mod arena;
mod cache;
mod compute;
mod config;
mod http;
mod persistent;
mod progression;
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
    let ui_enabled = match env::var("ARENA_UI_UPSTREAM").as_deref() {
        Err(_) | Ok("") | Ok("web:3000") => false,
        Ok("web:3001") => true,
        _ => return Err("ARENA_UI_UPSTREAM must be web:3000 or web:3001".into()),
    };
    let worker = compute::Worker::start().map_err(std::io::Error::other)?;
    let storage = storage::Storage::start();
    let config = config::Config::from_env();
    let showcase = showcase::Showcase::start(config.clone());
    let progression = progression::ProgressionService::new(storage.clone(), config.clone());
    let cache = cache::Cache::new(storage.clone(), worker.clone());
    let arena = arena::ArenaService::new(cache.clone(), storage.clone());
    let persistent =
        persistent::PersistentService::new(cache.clone(), storage.clone(), arena.clone());
    let arena_ui = if ui_enabled {
        Some(ui::Ui::start(arena.clone(), &config).map_err(std::io::Error::other)?)
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
