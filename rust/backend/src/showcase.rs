use crate::config::Config;
use axum::{
    Json,
    extract::State as HttpState,
    response::{IntoResponse, Response},
};
use rusqlite::{Connection, OptionalExtension, types::ValueRef};
use serde_json::{Value, json};
use std::{
    env,
    path::Path,
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};
use tokio::sync::oneshot;

// Separate from cohort cache/analytics: at most 32 waiting reads plus one active
// SQLite operation, all on one blocking thread rather than the Tokio runtime.
const MAX_PENDING: usize = 32;
const RETRY_DELAY: Duration = Duration::from_secs(5);
const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS home_showcase_groups (
 id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
 is_active INTEGER NOT NULL DEFAULT 0, mode TEXT NOT NULL DEFAULT 'regular',
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS home_showcase_items (
 group_id INTEGER NOT NULL REFERENCES home_showcase_groups(id) ON DELETE CASCADE,
 aid INTEGER NOT NULL, sort INTEGER NOT NULL DEFAULT 0,
 enabled INTEGER NOT NULL DEFAULT 1, nickname TEXT, added_at INTEGER NOT NULL,
 PRIMARY KEY (group_id, aid)
);
CREATE INDEX IF NOT EXISTS idx_home_showcase_items_group ON home_showcase_items(group_id, sort, aid);
";

fn initialize(db: &Connection) -> rusqlite::Result<()> {
    db.execute_batch(SCHEMA)?;
    db.execute_batch("PRAGMA foreign_keys=ON")?;
    let columns = db
        .prepare("PRAGMA table_info(home_showcase_groups)")?
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if !columns.iter().any(|name| name == "mode") {
        db.execute_batch(
            "ALTER TABLE home_showcase_groups ADD COLUMN mode TEXT NOT NULL DEFAULT 'regular'",
        )?;
    }
    Ok(())
}
fn empty() -> Value {
    json!({"groupId":null,"groupName":null,"mode":"regular","aids":[],"items":[],"updatedAt":null})
}
fn number(value: f64) -> Value {
    if value.is_finite()
        && value.fract() == 0.0
        && value >= i64::MIN as f64
        && value < i64::MAX as f64
    {
        json!(value as i64)
    } else {
        serde_json::Number::from_f64(value).map_or(Value::Null, Value::Number)
    }
}
// The TS store uses Number()/String(), not row validation. Preserve its public
// JSON behavior for legacy numeric text, NULL and node:sqlite Uint8Array blobs.
fn numeric(value: ValueRef<'_>) -> f64 {
    match value {
        ValueRef::Null => 0.0,
        ValueRef::Integer(value) => value as f64,
        ValueRef::Real(value) => value,
        ValueRef::Blob(bytes) => match bytes {
            [] => 0.0,
            [byte] => f64::from(*byte),
            _ => f64::NAN,
        },
        ValueRef::Text(bytes) => {
            let text = String::from_utf8_lossy(bytes);
            let text = crate::config::trim(&text);
            if text.is_empty() {
                return 0.0;
            }
            let radix = if text.starts_with("0x") || text.starts_with("0X") {
                Some(16)
            } else if text.starts_with("0b") || text.starts_with("0B") {
                Some(2)
            } else if text.starts_with("0o") || text.starts_with("0O") {
                Some(8)
            } else {
                None
            };
            if let Some(radix) = radix {
                if text.len() == 2 {
                    return f64::NAN;
                }
                text[2..]
                    .chars()
                    .try_fold(0.0, |value, ch| {
                        ch.to_digit(radix)
                            .map(|digit| value * f64::from(radix) + f64::from(digit))
                    })
                    .unwrap_or(f64::NAN)
            } else {
                text.parse().unwrap_or(f64::NAN)
            }
        }
    }
}
fn string(value: ValueRef<'_>) -> String {
    match value {
        ValueRef::Null => "null".into(),
        ValueRef::Text(bytes) => String::from_utf8_lossy(bytes).into_owned(),
        ValueRef::Blob(bytes) => bytes
            .iter()
            .map(u8::to_string)
            .collect::<Vec<_>>()
            .join(","),
        ValueRef::Integer(value) => number(value as f64).to_string(),
        ValueRef::Real(value) => number(value).to_string(),
    }
}
fn safe_integer_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<()> {
    // node:sqlite's default decoder rejects unsafe INTEGER values before the TS
    // store can coerce fields. TEXT values still use Number() conversion below.
    const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
    for column in 0..row.as_ref().column_count() {
        if let ValueRef::Integer(value) = row.get_ref(column)?
            && !(-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(&value)
        {
            return Err(rusqlite::Error::IntegralValueOutOfRange(column, value));
        }
    }
    Ok(())
}
fn active(db: &mut Connection) -> rusqlite::Result<Value> {
    // A read transaction provides one snapshot for group selection and items;
    // rusqlite rolls it back automatically on every early error.
    let tx = db.transaction()?;
    let group = tx
        .query_row(
            "SELECT * FROM home_showcase_groups WHERE is_active=1 ORDER BY id ASC LIMIT 1",
            [],
            |row| {
                safe_integer_row(row)?;
                let mode = match row.get_ref("mode")? {
                    ValueRef::Text(b"pve") => "pve",
                    ValueRef::Text(b"arena") => "arena",
                    ValueRef::Text(b"seasonal") => "seasonal",
                    _ => "regular",
                };
                Ok((
                    numeric(row.get_ref("id")?),
                    string(row.get_ref("name")?),
                    mode,
                    number(numeric(row.get_ref("updated_at")?)),
                ))
            },
        )
        .optional()?;
    let result = if let Some((id, name, mode, updated)) = group {
        let items = {
            let mut query = tx.prepare("SELECT aid,nickname,enabled,sort FROM home_showcase_items WHERE group_id=? AND enabled=1 ORDER BY sort ASC,aid ASC")?;
            query.query_map([id], |row| {
                safe_integer_row(row)?;
                Ok(json!({"aid":number(numeric(row.get_ref(0)?)),
                "nickname":if matches!(row.get_ref(1)?, ValueRef::Null) {Value::Null} else {json!(string(row.get_ref(1)?))},
                "enabled":numeric(row.get_ref(2)?)==1.0,"sort":number(numeric(row.get_ref(3)?))})) })?
                .collect::<rusqlite::Result<Vec<_>>>()?
        };
        let aids: Vec<_> = items.iter().map(|item| item["aid"].clone()).collect();
        json!({"groupId":number(id),"groupName":name,"mode":mode,"aids":aids,"items":items,"updatedAt":updated})
    } else {
        empty()
    };
    tx.commit()?;
    Ok(result)
}
struct Store {
    path: String,
    db: Option<Connection>,
    retry_after: Instant,
}
impl Store {
    fn new(path: String) -> Self {
        Self {
            path,
            db: None,
            retry_after: Instant::now(),
        }
    }
    fn open(&self) -> Result<Connection, String> {
        if let Some(parent) = Path::new(&self.path)
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
        {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let db = Connection::open(&self.path).map_err(|error| error.to_string())?;
        db.busy_timeout(Duration::from_millis(100))
            .map_err(|error| error.to_string())?;
        initialize(&db).map_err(|error| error.to_string())?;
        Ok(db)
    }
    fn read(&mut self, now: Instant) -> Option<Value> {
        if self.db.is_none() {
            if now < self.retry_after {
                return None;
            }
            match self.open() {
                Ok(db) => self.db = Some(db),
                Err(error) => {
                    eprintln!("Home showcase unavailable: {error}");
                    self.retry_after = now + RETRY_DELAY;
                    return None;
                }
            }
        }
        match active(self.db.as_mut().expect("initialized showcase store")) {
            Ok(config) => Some(config),
            Err(error) => {
                eprintln!("Home showcase read failed: {error}");
                self.db = None;
                // Reopen next time, permitting immediate recovery from a short
                // read lock. A failed reopen/schema init then applies backoff.
                self.retry_after = now;
                None
            }
        }
    }
}
#[derive(Clone)]
pub struct Showcase {
    sender: mpsc::SyncSender<oneshot::Sender<Option<Value>>>,
    config: Config,
}
impl Showcase {
    pub fn start(config: Config) -> Self {
        let path = env::var("ADMIN_ANALYTICS_SQLITE_PATH")
            .ok()
            .filter(|path| !path.is_empty())
            .unwrap_or_else(|| "/data/admin-analytics.db".into());
        Self::with_path(path, config)
    }
    fn with_path(path: String, config: Config) -> Self {
        let (sender, receiver) = mpsc::sync_channel::<oneshot::Sender<Option<Value>>>(MAX_PENDING);
        thread::Builder::new()
            .name("rust-home-showcase".into())
            .spawn(move || {
                let mut store = Store::new(path);
                while let Ok(reply) = receiver.recv() {
                    if !reply.is_closed() {
                        let _ = reply.send(store.read(Instant::now()));
                    }
                }
            })
            .expect("showcase storage thread must start");
        Self { sender, config }
    }
    async fn read(&self) -> Option<Value> {
        let (reply, answer) = oneshot::channel();
        self.sender.try_send(reply).ok()?;
        answer.await.ok().flatten()
    }
}
pub async fn get(HttpState(showcase): HttpState<Showcase>) -> Response {
    let stored = showcase.read().await;
    let cycle = stored
        .as_ref()
        .and(showcase.config.cycle.as_deref())
        .filter(|cycle| showcase.config.ready(cycle, crate::now_ms()));
    let mut body = stored.unwrap_or_else(empty);
    body["seasonalCycleId"] = json!(cycle);
    (
        [("cache-control", "public, max-age=30, s-maxage=60")],
        Json(body),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn db() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        initialize(&db).unwrap();
        db
    }
    fn group(db: &Connection, id: i64, active: i64, mode: &str) {
        db.execute("INSERT INTO home_showcase_groups(id,name,is_active,mode,created_at,updated_at)VALUES(?, 'Synthetic group',?,?,100,200)", rusqlite::params![id,active,mode]).unwrap();
    }
    struct Temp(std::path::PathBuf);
    impl Temp {
        fn new() -> Self {
            static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let path = env::temp_dir().join(format!(
                "rust-home-showcase-{}-{}-{}",
                std::process::id(),
                crate::now_ms(),
                NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            ));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            assert_eq!(self.0.parent(), Some(env::temp_dir().as_path()));
            assert!(
                self.0
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("rust-home-showcase-")
            );
            std::fs::remove_dir_all(&self.0).unwrap();
        }
    }
    #[test]
    fn legacy_mode_migration_preserves_rows_and_is_idempotent() {
        let mut db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE home_showcase_groups(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,is_active INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);INSERT INTO home_showcase_groups VALUES(1,'Legacy',1,10,20)").unwrap();
        initialize(&db).unwrap();
        initialize(&db).unwrap();
        let config = active(&mut db).unwrap();
        assert_eq!(config["groupName"], "Legacy");
        assert_eq!(config["mode"], "regular");
        assert_eq!(
            db.query_row("PRAGMA foreign_keys", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            db.query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name='idx_home_showcase_items_group'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
    }
    #[test]
    fn empty_and_inactive_groups_return_the_same_empty_contract() {
        let mut db = db();
        assert_eq!(active(&mut db).unwrap(), empty());
        group(&db, 1, 0, "arena");
        assert_eq!(active(&mut db).unwrap(), empty());
        assert!(db.is_autocommit());
    }
    #[test]
    fn active_group_uses_lowest_id_enabled_items_and_sort_aid_order() {
        let mut db = db();
        group(&db, 7, 1, "pve");
        group(&db, 2, 1, "arena");
        group(&db, 1, 0, "regular");
        group(&db, 0, 2, "seasonal");
        db.execute_batch("INSERT INTO home_showcase_items VALUES(2,9,3,1,'Zulu',1),(2,4,3,1,NULL,1),(2,6,-1,1,'First',1),(2,1,-2,0,'Disabled',1),(2,11,-3,2,'Not enabled one',1),(7,20,0,1,'Other',1)").unwrap();
        assert_eq!(
            active(&mut db).unwrap(),
            json!({"groupId":2,"groupName":"Synthetic group","mode":"arena","aids":[6,4,9],"items":[{"aid":6,"nickname":"First","enabled":true,"sort":-1},{"aid":4,"nickname":null,"enabled":true,"sort":3},{"aid":9,"nickname":"Zulu","enabled":true,"sort":3}],"updatedAt":200})
        );
    }
    #[test]
    fn all_modes_and_unknown_legacy_mode_keep_public_fallback() {
        let mut db = db();
        group(&db, 1, 1, "regular");
        for mode in [
            "regular", "pve", "arena", "seasonal", "unknown", "ARENA", "",
        ] {
            db.execute("UPDATE home_showcase_groups SET mode=?", [mode])
                .unwrap();
            assert_eq!(
                active(&mut db).unwrap()["mode"],
                if ["regular", "pve", "arena", "seasonal"].contains(&mode) {
                    mode
                } else {
                    "regular"
                }
            );
        }
    }
    #[test]
    fn failed_open_is_backed_off_then_recovers_and_creates_missing_parent() {
        let root = Temp::new();
        let blocked = root.0.join("nested");
        std::fs::write(&blocked, b"not a directory").unwrap();
        let path = blocked.join("analytics.db");
        let mut store = Store::new(path.to_string_lossy().into());
        let now = Instant::now();
        assert!(store.read(now).is_none());
        std::fs::remove_file(&blocked).unwrap();
        assert!(store.read(now + Duration::from_millis(4999)).is_none());
        assert!(!path.exists());
        assert_eq!(store.read(now + RETRY_DELAY), Some(empty()));
        assert!(path.exists());
        drop(store);
    }
    #[test]
    fn failed_schema_initialization_is_backed_off_then_repaired() {
        let root = Temp::new();
        let path = root.0.join("analytics.db");
        let db = Connection::open(&path).unwrap();
        db.execute_batch("CREATE TABLE home_showcase_items(group_id INTEGER,aid INTEGER); CREATE TABLE unrelated(value TEXT); INSERT INTO unrelated VALUES('preserved')").unwrap();
        let mut store = Store::new(path.to_string_lossy().into());
        let now = Instant::now();
        assert!(store.read(now).is_none());
        db.execute_batch("DROP TABLE home_showcase_items").unwrap();
        assert!(store.read(now + Duration::from_millis(4999)).is_none());
        assert_eq!(store.read(now + RETRY_DELAY), Some(empty()));
        assert_eq!(
            db.query_row("SELECT value FROM unrelated", [], |row| row
                .get::<_, String>(0))
                .unwrap(),
            "preserved"
        );
        drop(store);
        drop(db);
    }
    #[test]
    fn read_error_rolls_back_and_next_request_reopens_and_repairs_schema() {
        let root = Temp::new();
        let path = root.0.join("analytics.db");
        let mut store = Store::new(path.to_string_lossy().into());
        assert!(store.read(Instant::now()).is_some());
        let db = store.db.as_mut().unwrap();
        group(db, 1, 1, "pve");
        db.execute_batch("DROP TABLE home_showcase_items").unwrap();
        assert!(active(db).is_err());
        assert!(db.is_autocommit());
        assert!(store.read(Instant::now()).is_none());
        assert!(store.db.is_none());
        assert_eq!(store.read(Instant::now()).unwrap()["mode"], "pve");
        drop(store);
    }
    #[test]
    fn read_lock_is_bounded_and_recovers_after_release() {
        let root = Temp::new();
        let path = root.0.join("analytics.db");
        let mut store = Store::new(path.to_string_lossy().into());
        assert!(store.read(Instant::now()).is_some());
        let locker = Connection::open(&path).unwrap();
        locker.execute_batch("BEGIN EXCLUSIVE").unwrap();
        let started = Instant::now();
        assert!(store.read(started).is_none());
        assert!(started.elapsed() < Duration::from_secs(2));
        locker.execute_batch("ROLLBACK").unwrap();
        assert!(store.read(Instant::now()).is_some());
        drop(locker);
        drop(store);
    }
    fn ready_config() -> Config {
        Config::from_map(
            &[
                ("SEASONAL_ENABLED", "true"),
                ("SEASONAL_CYCLE_ID", "s1"),
                ("SEASONAL_STARTS_AT", "2020-01-01"),
                ("SEASONAL_UPSTREAM_CONTRACT", "direct_profile"),
                (
                    "SEASONAL_PROFILE_URL_TEMPLATE",
                    "https://players.tarkov.dev/pvp-season/{aid}.json",
                ),
            ]
            .into_iter()
            .map(|(key, value)| (key.into(), value.into()))
            .collect(),
        )
    }
    #[tokio::test]
    async fn queue_overflow_uses_public_fallback_without_seasonal_cycle() {
        let (sender, _receiver) = mpsc::sync_channel(MAX_PENDING);
        for _ in 0..MAX_PENDING {
            let (reply, _answer) = oneshot::channel();
            sender.try_send(reply).unwrap();
        }
        let response = get(HttpState(Showcase {
            sender,
            config: ready_config(),
        }))
        .await;
        assert_eq!(response.status(), 200);
        assert_eq!(
            response.headers()["cache-control"],
            "public, max-age=30, s-maxage=60"
        );
        let body: Value = serde_json::from_slice(
            &axum::body::to_bytes(response.into_body(), 65536)
                .await
                .unwrap(),
        )
        .unwrap();
        let mut expected = empty();
        expected["seasonalCycleId"] = Value::Null;
        assert_eq!(body, expected);
    }
    #[tokio::test]
    async fn empty_initialized_store_includes_ready_seasonal_cycle() {
        let showcase = Showcase::with_path(":memory:".into(), ready_config());
        let response = get(HttpState(showcase)).await;
        let body: Value = serde_json::from_slice(
            &axum::body::to_bytes(response.into_body(), 65536)
                .await
                .unwrap(),
        )
        .unwrap();
        let mut expected = empty();
        expected["seasonalCycleId"] = json!("s1");
        assert_eq!(body, expected);
    }
    #[test]
    fn unsafe_integer_item_aid_and_unused_group_columns_fail_closed() {
        let mut db = db();
        group(&db, 1, 1, "regular");
        for unsafe_integer in [9_007_199_254_740_992_i64, -9_007_199_254_740_992_i64] {
            db.execute(
                "INSERT INTO home_showcase_items(group_id,aid,added_at)VALUES(1,?,1)",
                [unsafe_integer],
            )
            .unwrap();
            assert!(active(&mut db).is_err());
            assert!(db.is_autocommit());
            db.execute("DELETE FROM home_showcase_items", []).unwrap();
            db.execute(
                "UPDATE home_showcase_groups SET created_at=?",
                [unsafe_integer],
            )
            .unwrap();
            assert!(
                active(&mut db).is_err(),
                "SELECT * must decode unused created_at too"
            );
            assert!(db.is_autocommit());
            db.execute("UPDATE home_showcase_groups SET created_at=100", [])
                .unwrap();
        }
        assert_eq!(active(&mut db).unwrap()["groupId"], json!(1));
    }
    #[test]
    fn numeric_text_outside_safe_integer_range_still_uses_number_conversion() {
        let mut db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE home_showcase_groups(id INTEGER PRIMARY KEY,name TEXT,is_active INTEGER,mode TEXT,created_at TEXT,updated_at TEXT); INSERT INTO home_showcase_groups VALUES(1,'Legacy',1,'regular','9007199254740992','9007199254740992')").unwrap();
        initialize(&db).unwrap();
        assert_eq!(
            active(&mut db).unwrap()["updatedAt"],
            json!(9_007_199_254_740_992_i64)
        );
    }
    #[test]
    fn legacy_numeric_and_nickname_conversion_preserves_node_sqlite_json() {
        assert_eq!(number(numeric(ValueRef::Text(b"0x10"))), json!(16));
        assert_eq!(number(numeric(ValueRef::Text(b"bad"))), Value::Null);
        assert_eq!(number(numeric(ValueRef::Blob(b"1"))), json!(49));
        assert_eq!(number(numeric(ValueRef::Blob(b"12"))), Value::Null);
        assert_eq!(string(ValueRef::Blob(b"hi")), "104,105");
    }
}
