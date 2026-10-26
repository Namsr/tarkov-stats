use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use serde_json::Value;
use std::{env, sync::mpsc, thread};
use tokio::sync::oneshot;

const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS statistics_response_cache(cache_key TEXT PRIMARY KEY,payload_json TEXT NOT NULL,generated_at INTEGER NOT NULL,payload_bytes INTEGER NOT NULL)";
enum Command {
    Read(String, oneshot::Sender<Option<Value>>),
    Write(String, Value, i64, oneshot::Sender<()>),
    Event(Value),
}
#[derive(Clone)]
pub struct Storage {
    sender: mpsc::SyncSender<Command>,
}
struct State {
    cache_path: String,
    analytics_path: String,
    enabled: bool,
    reader: Option<Connection>,
    writer: Option<Connection>,
    analytics: Option<Connection>,
}
impl State {
    fn from_env() -> Self {
        Self {
            cache_path: env::var("AVERAGE_PUBLICATION_SQLITE_PATH")
                .ok()
                .filter(|path| !path.is_empty())
                .unwrap_or_else(|| "/data/average-publications.db".into()),
            analytics_path: env::var("ADMIN_ANALYTICS_SQLITE_PATH")
                .ok()
                .filter(|path| !path.is_empty())
                .unwrap_or_else(|| "/data/admin-analytics.db".into()),
            enabled: env::var("SQLITE_PATH").is_ok_and(|p| !p.is_empty())
                && (env::var("NODE_ENV").as_deref() == Ok("production")
                    || env::var("AVERAGE_PUBLICATIONS_ENABLED").as_deref() == Ok("true")),
            reader: None,
            writer: None,
            analytics: None,
        }
    }
    fn cache(&mut self, write: bool) -> rusqlite::Result<&mut Connection> {
        let slot = if write {
            &mut self.writer
        } else {
            &mut self.reader
        };
        if slot.is_none() {
            let flags = if write {
                OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE
            } else {
                OpenFlags::SQLITE_OPEN_READ_ONLY
            };
            let db = Connection::open_with_flags(
                &self.cache_path,
                flags | OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )?;
            db.busy_timeout(std::time::Duration::from_millis(100))?;
            if write {
                db.execute_batch(&format!("PRAGMA journal_mode=WAL;{SCHEMA}"))?;
            }
            *slot = Some(db);
        }
        Ok(slot.as_mut().unwrap())
    }
    fn read(&mut self, key: &str) -> Option<Value> {
        if !self.enabled {
            return None;
        }
        let db = self.cache(false).ok()?;
        let value:Option<String>=db.prepare_cached("SELECT payload_json FROM statistics_response_cache WHERE cache_key=? AND payload_bytes<=1048576 AND length(CAST(payload_json AS BLOB))<=1048576").ok()?.query_row([key],|row|row.get(0)).optional().ok()?;
        value.and_then(|value| serde_json::from_str(&value).ok())
    }
    fn write(&mut self, key: &str, value: &Value, generated_at: i64) -> rusqlite::Result<()> {
        if !self.enabled {
            return Ok(());
        }
        let text = serde_json::to_string(value).expect("JSON value serialization");
        if text.len() > 1024 * 1024 {
            return Ok(());
        }
        let db = self.cache(true)?;
        db.prepare_cached("INSERT INTO statistics_response_cache(cache_key,payload_json,generated_at,payload_bytes)VALUES(?,?,?,?)ON CONFLICT(cache_key)DO UPDATE SET payload_json=excluded.payload_json,generated_at=excluded.generated_at,payload_bytes=excluded.payload_bytes WHERE excluded.generated_at>=statistics_response_cache.generated_at")?.execute(params![key,text,generated_at,text.len() as i64])?;
        db.execute("DELETE FROM statistics_response_cache WHERE cache_key IN(SELECT cache_key FROM(SELECT cache_key,ROW_NUMBER()OVER(ORDER BY generated_at DESC,cache_key)AS position,SUM(payload_bytes)OVER(ORDER BY generated_at DESC,cache_key)AS bytes FROM statistics_response_cache)WHERE position>4096 OR bytes>67108864)",[])?;
        Ok(())
    }
    fn event(&mut self, event: &Value) -> rusqlite::Result<()> {
        if self.analytics.is_none() {
            let db = Connection::open_with_flags(
                &self.analytics_path,
                OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )?;
            db.busy_timeout(std::time::Duration::from_millis(100))?;
            self.analytics = Some(db);
        }
        let db = self.analytics.as_mut().unwrap();
        let text = |key: &str| event.get(key).and_then(Value::as_str);
        let number = |key: &str| event.get(key).and_then(Value::as_i64);
        db.prepare_cached("INSERT INTO request_events(occurred_at,host,operation,aid,mode,cycle_id,outcome,status,source,cache,storage,failure_stage,error_code,latency_ms,cohort_ms,queue_ms,worker_ms,request_id)VALUES(?,NULL,'average_cohort',?,'seasonal',?,?,?,?,?,?,?,?,?,?,?,?,?)")?.execute(params![number("at"),number("aid"),text("cycle"),text("outcome"),number("status"),text("source"),text("cache"),text("storage"),text("failure_stage"),text("error_code"),number("total_ms"),number("cohort_ms"),number("queue_ms"),number("worker_ms"),text("request_id")])?;
        Ok(())
    }
}
impl Storage {
    pub fn start() -> Self {
        let (sender, receiver) = mpsc::sync_channel(128);
        thread::Builder::new()
            .name("rust-api-storage".into())
            .spawn(move || {
                let mut state = State::from_env();
                let mut retry_analytics = std::time::Instant::now();
                while let Ok(command) = receiver.recv() {
                    match command {
                        Command::Read(key, reply) => {
                            let _ = reply.send(state.read(&key));
                        }
                        Command::Write(key, value, at, reply) => {
                            if state.write(&key, &value, at).is_err() {
                                eprintln!("Rust statistics cache write unavailable");
                            }
                            let _ = reply.send(());
                        }
                        Command::Event(event) => {
                            if std::time::Instant::now() >= retry_analytics
                                && state.event(&event).is_err()
                            {
                                eprintln!("Rust analytics write unavailable");
                                retry_analytics =
                                    std::time::Instant::now() + std::time::Duration::from_secs(5);
                            }
                        }
                    }
                }
            })
            .expect("storage thread must start");
        Self { sender }
    }
    pub async fn read(&self, key: String) -> Option<Value> {
        let (reply, answer) = oneshot::channel();
        self.sender.try_send(Command::Read(key, reply)).ok()?;
        answer.await.ok().flatten()
    }
    pub async fn write(&self, key: String, value: Value, at: i64) {
        let (reply, answer) = oneshot::channel();
        if self
            .sender
            .try_send(Command::Write(key, value, at, reply))
            .is_ok()
        {
            let _ = answer.await;
        }
    }
    pub fn event(&self, event: Value) {
        if self.sender.try_send(Command::Event(event)).is_err() {
            eprintln!("Rust analytics queue full");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn state() -> State {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let path = env::temp_dir().join(format!(
            "rust-api-cache-{}-{}-{}.db",
            std::process::id(),
            crate::now_ms(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        State {
            cache_path: path.to_string_lossy().into(),
            analytics_path: String::new(),
            enabled: true,
            reader: None,
            writer: None,
            analytics: None,
        }
    }
    #[test]
    fn durable_cache_never_replaces_a_newer_generation() {
        let mut state = state();
        assert!(state.read("one").is_none());
        state
            .write("one", &serde_json::json!({"saved":2}), 200)
            .unwrap();
        state
            .write("one", &serde_json::json!({"saved":1}), 100)
            .unwrap();
        assert_eq!(state.read("one"), Some(serde_json::json!({"saved":2})));
        let path = state.cache_path.clone();
        drop(state);
        let _ = std::fs::remove_file(path);
    }
    #[test]
    fn oversized_payload_does_not_create_a_cache_database() {
        let mut state = state();
        state
            .write("large", &Value::String("x".repeat(1024 * 1024)), 1)
            .unwrap();
        assert!(!std::path::Path::new(&state.cache_path).exists());
    }
    #[test]
    fn analytics_insert_keeps_request_identity_and_phase_columns() {
        let mut state = state();
        state.analytics_path = state.cache_path.clone();
        let db = Connection::open(&state.analytics_path).unwrap();
        db.execute_batch("CREATE TABLE request_events(occurred_at INTEGER NOT NULL,host TEXT,operation TEXT,aid INTEGER,mode TEXT,cycle_id TEXT,outcome TEXT,status INTEGER,source TEXT,cache TEXT,storage TEXT,failure_stage TEXT,error_code TEXT,latency_ms INTEGER,cohort_ms INTEGER,queue_ms INTEGER,worker_ms INTEGER,request_id TEXT)").unwrap();
        state.event(&serde_json::json!({"at":100,"aid":12,"cycle":"s1","outcome":"success","status":200,"source":"stored","cache":"miss","storage":"sqlite","total_ms":30,"cohort_ms":25,"queue_ms":5,"worker_ms":20})).unwrap();
        let row = db
            .query_row(
                "SELECT operation,aid,mode,cycle_id,queue_ms,worker_ms FROM request_events",
                [],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, i64>(4)?,
                        row.get::<_, i64>(5)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(
            row,
            (
                "average_cohort".into(),
                12,
                "seasonal".into(),
                "s1".into(),
                5,
                20
            )
        );
        let path = state.analytics_path.clone();
        drop(state);
        drop(db);
        let _ = std::fs::remove_file(path);
    }
}
