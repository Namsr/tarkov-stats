mod cache;
mod compute;
mod config;
mod http;
mod storage;

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
    let worker = compute::Worker::start().map_err(std::io::Error::other)?;
    let storage = storage::Storage::start();
    let state = Arc::new(http::App {
        config: config::Config::from_env(),
        cache: cache::Cache::new(storage.clone(), worker.clone()),
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
        .with_state(state);
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
