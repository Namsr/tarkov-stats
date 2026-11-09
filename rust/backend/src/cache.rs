use crate::{
    compute::{Computed, Failure, Kind, Worker},
    storage::Storage,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{HashMap, VecDeque},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::sync::watch;

const MAX_KEYS: usize = 2048;
const MAX_BYTES: usize = 32 * 1024 * 1024;
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Saved {
    key: String,
    value: Value,
    generated_at: f64,
    expires_at: f64,
}
struct Pending {
    key: String,
    id: u64,
    reply: watch::Receiver<Option<Result<Computed, Failure>>>,
}
struct EntryState {
    saved: Option<Saved>,
    pending: Option<Pending>,
    retry_at: f64,
    bytes: usize,
}
struct Entry {
    state: Mutex<EntryState>,
    restored: watch::Sender<bool>,
}
struct Entries {
    values: HashMap<String, Arc<Entry>>,
    order: VecDeque<String>,
}
#[derive(Clone)]
pub struct Cache {
    entries: Arc<Mutex<Entries>>,
    ids: Arc<AtomicU64>,
    storage: Storage,
    worker: Worker,
    timeout: Duration,
}
pub struct Loaded {
    pub value: Value,
    pub cache: &'static str,
    pub stale: bool,
    pub generated_at: f64,
    pub phases: Option<(u64, u64)>,
}

impl Cache {
    pub fn new(storage: Storage, worker: Worker) -> Self {
        let timeout = std::env::var("DYNAMIC_COMPUTE_TIMEOUT_MS")
            .ok()
            .and_then(|v| v.parse::<f64>().ok())
            .filter(|v| v.is_finite() && *v > 0.0 && *v <= u64::MAX as f64)
            .map_or(25000, |v| v.floor() as u64);
        Self {
            entries: Arc::new(Mutex::new(Entries {
                values: HashMap::new(),
                order: VecDeque::new(),
            })),
            ids: Arc::new(AtomicU64::new(0)),
            storage,
            worker,
            timeout: Duration::from_millis(timeout),
        }
    }
    fn entry(&self, identity: &str) -> (Arc<Entry>, bool) {
        let mut entries = self.entries.lock().unwrap();
        if let Some(entry) = entries.values.get(identity).cloned() {
            entries.order.retain(|key| key != identity);
            entries.order.push_back(identity.into());
            return (entry, false);
        }
        while entries.values.len() >= MAX_KEYS {
            if let Some(old) = entries.order.pop_front() {
                entries.values.remove(&old);
            }
        }
        let (restored, _) = watch::channel(false);
        let entry = Arc::new(Entry {
            state: Mutex::new(EntryState {
                saved: None,
                pending: None,
                retry_at: 0.0,
                bytes: 0,
            }),
            restored,
        });
        entries.values.insert(identity.into(), entry.clone());
        entries.order.push_back(identity.into());
        (entry, true)
    }
    fn bound(&self) {
        let mut entries = self.entries.lock().unwrap();
        let mut bytes: usize = entries
            .values
            .values()
            .map(|entry| entry.state.lock().unwrap().bytes)
            .sum();
        while bytes > MAX_BYTES || entries.values.len() > MAX_KEYS {
            let Some(old) = entries.order.pop_front() else {
                break;
            };
            if let Some(entry) = entries.values.remove(&old) {
                bytes = bytes.saturating_sub(entry.state.lock().unwrap().bytes);
            }
        }
    }
    fn publish(&self, identity: &str, entry: &Arc<Entry>, id: u64, saved: &Saved) -> bool {
        let entries = self.entries.lock().unwrap();
        if !entries
            .values
            .get(identity)
            .is_some_and(|current| Arc::ptr_eq(current, entry))
        {
            return false;
        }
        let mut state = entry.state.lock().unwrap();
        if !state
            .pending
            .as_ref()
            .is_some_and(|pending| pending.id == id)
        {
            return false;
        }
        state.bytes = serde_json::to_vec(saved).map_or(0, |v| v.len());
        state.saved = Some(saved.clone());
        state.retry_at = 0.0;
        true
    }
    pub async fn load(
        &self,
        key: String,
        fallback: String,
        args: Value,
        now: i64,
    ) -> Result<Loaded, Failure> {
        let worker = self.worker.clone();
        let input = args.clone();
        self.load_factory(
            key,
            fallback,
            args,
            now,
            async move { worker.compute(input).await },
            false,
        )
        .await
    }
    /// Share the same cache and durable protocol for bounded asynchronous data
    /// loaders which must not occupy the CPU computation child's FIFO.
    pub async fn load_with<F>(
        &self,
        key: String,
        fallback: String,
        args: Value,
        now: i64,
        factory: F,
    ) -> Result<Loaded, Failure>
    where
        F: std::future::Future<Output = Result<Computed, Failure>> + Send + 'static,
    {
        self.load_factory(key, fallback, args, now, factory, true)
            .await
    }
    async fn load_factory<F>(
        &self,
        key: String,
        fallback: String,
        args: Value,
        now: i64,
        factory: F,
        validate: bool,
    ) -> Result<Loaded, Failure>
    where
        F: std::future::Future<Output = Result<Computed, Failure>> + Send + 'static,
    {
        let kind = Kind::from_job(&args).ok_or_else(|| Failure {
            reason: "protocol",
            message: "Unsupported cache job".into(),
        })?;
        let identity = format!("statistics-v1:{fallback}");
        let (entry, created) = self.entry(&identity);
        if created {
            // The restoration itself must survive one HTTP consumer disconnecting.
            let target = entry.clone();
            let storage = self.storage.clone();
            let identity = identity.clone();
            let cache = self.clone();
            let expected_job = args.clone();
            tokio::spawn(async move {
                if let Some(value) = storage.read(identity).await
                    && let Ok(saved) = serde_json::from_value::<Saved>(value)
                    && !saved.value.is_null()
                    && saved.generated_at.is_finite()
                    && saved.expires_at.is_finite()
                    && kind.valid(&saved.value, &expected_job)
                    && kind.accepted(&saved.value)
                {
                    let mut state = target.state.lock().unwrap();
                    state.bytes = serde_json::to_vec(&saved).map_or(0, |v| v.len());
                    state.saved = Some(saved);
                }
                cache.bound();
                target.restored.send_replace(true);
            });
        }
        let mut restored = entry.restored.subscribe();
        while !*restored.borrow_and_update() {
            if restored.changed().await.is_err() {
                break;
            }
        }
        let now = now as f64;
        let (saved, shared, mut answer, launch) = {
            let mut state = entry.state.lock().unwrap();
            if let Some(saved) = state
                .saved
                .as_ref()
                .filter(|saved| saved.key == key && saved.expires_at > now)
            {
                return Ok(Loaded {
                    value: saved.value.clone(),
                    cache: "hit",
                    stale: false,
                    generated_at: saved.generated_at,
                    phases: None,
                });
            }
            let shared = state
                .pending
                .as_ref()
                .is_some_and(|pending| pending.key == key);
            let mut launch = None;
            if !shared && (state.saved.is_none() || state.retry_at <= now) {
                let id = self.ids.fetch_add(1, Ordering::Relaxed) + 1;
                let (sender, receiver) = watch::channel(None);
                state.pending = Some(Pending {
                    key: key.clone(),
                    id,
                    reply: receiver,
                });
                launch = Some((id, sender));
            }
            (
                state.saved.clone(),
                shared,
                state.pending.as_ref().map(|pending| pending.reply.clone()),
                launch,
            )
        };
        if let Some((id, sender)) = launch {
            let cache = self.clone();
            let target = entry.clone();
            let started = Instant::now();
            let job_key = key.clone();
            tokio::spawn(async move {
                let result = factory.await.and_then(|computed| {
                    if !validate || kind.valid(&computed.value, &args) {
                        Ok(computed)
                    } else {
                        Err(Failure {
                            reason: "protocol",
                            message: "Invalid asynchronous cache result".into(),
                        })
                    }
                });
                match &result {
                    Ok(result) => {
                        let accepted = kind.accepted(&result.value);
                        if accepted {
                            let generated_at = now + started.elapsed().as_millis() as f64;
                            let saved = Saved {
                                key: job_key,
                                value: result.value.clone(),
                                generated_at,
                                expires_at: generated_at + kind.ttl_ms(),
                            };
                            if cache.publish(&identity, &target, id, &saved) {
                                cache.bound();
                                cache
                                    .storage
                                    .write(
                                        identity,
                                        serde_json::to_value(&saved).expect("Saved JSON"),
                                        now as i64,
                                    )
                                    .await;
                            }
                        } else {
                            let mut state = target.state.lock().unwrap();
                            if state
                                .pending
                                .as_ref()
                                .is_some_and(|pending| pending.id == id)
                            {
                                state.retry_at = now + 5000.0;
                            }
                        }
                    }
                    Err(_) => {
                        let mut state = target.state.lock().unwrap();
                        if state
                            .pending
                            .as_ref()
                            .is_some_and(|pending| pending.id == id)
                        {
                            state.retry_at = now + started.elapsed().as_millis() as f64 + 5000.0;
                        }
                    }
                }
                {
                    let mut state = target.state.lock().unwrap();
                    if state
                        .pending
                        .as_ref()
                        .is_some_and(|pending| pending.id == id)
                    {
                        state.pending = None;
                    }
                }
                sender.send_replace(Some(result));
            });
        }
        if let Some(saved) = saved {
            return Ok(Loaded {
                value: saved.value,
                cache: "hit",
                stale: true,
                generated_at: saved.generated_at,
                phases: None,
            });
        }
        let Some(ref mut receiver) = answer else {
            return Err(Failure {
                reason: "unavailable",
                message: "Cohort cache unavailable".into(),
            });
        };
        let wait = async {
            loop {
                if let Some(result) = receiver.borrow_and_update().clone() {
                    return result;
                }
                if receiver.changed().await.is_err() {
                    return Err(Failure {
                        reason: "worker_exit",
                        message: "Cohort result unavailable".into(),
                    });
                }
            }
        };
        let computed = tokio::time::timeout(self.timeout, wait).await;
        match computed {
            Ok(Ok(result)) => {
                let generated_at = entry
                    .state
                    .lock()
                    .unwrap()
                    .saved
                    .as_ref()
                    .map_or(now, |saved| saved.generated_at);
                Ok(Loaded {
                    value: result.value,
                    cache: if shared { "hit" } else { "miss" },
                    stale: false,
                    generated_at,
                    phases: Some((result.queue_ms, result.worker_ms)),
                })
            }
            other => {
                if let Some(saved) = entry.state.lock().unwrap().saved.clone() {
                    return Ok(Loaded {
                        value: saved.value,
                        cache: "hit",
                        stale: saved.key != key,
                        generated_at: saved.generated_at,
                        phases: None,
                    });
                }
                match other {
                    Ok(Err(error)) => Err(error),
                    Err(_) => Err(Failure {
                        reason: "response_timeout",
                        message: "Dynamic average compute timed out".into(),
                    }),
                    _ => unreachable!(),
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn lru_touch_keeps_a_hot_identity_and_evicts_the_oldest() {
        let worker = Worker::start().unwrap();
        let cache = Cache::new(Storage::start(), worker.clone());
        let (hot, _) = cache.entry("hot");
        for index in 0..MAX_KEYS - 1 {
            cache.entry(&format!("key-{index}"));
        }
        let (touched, _) = cache.entry("hot");
        assert!(Arc::ptr_eq(&hot, &touched));
        cache.entry("new");
        {
            let entries = cache.entries.lock().unwrap();
            assert_eq!(entries.values.len(), MAX_KEYS);
            assert!(entries.values.contains_key("hot"));
            assert!(!entries.values.contains_key("key-0"));
        }
        worker.stop().await;
    }
    #[tokio::test]
    async fn an_old_revision_cannot_publish_over_a_new_pending_generation() {
        let worker = Worker::start().unwrap();
        let cache = Cache::new(Storage::start(), worker.clone());
        let (entry, _) = cache.entry("same-player");
        let (_, receiver) = watch::channel(None);
        entry.state.lock().unwrap().pending = Some(Pending {
            key: "new-revision".into(),
            id: 2,
            reply: receiver,
        });
        let saved = Saved {
            key: "old-revision".into(),
            value: serde_json::json!({"old":true}),
            generated_at: 100.0,
            expires_at: 200.0,
        };
        assert!(!cache.publish("same-player", &entry, 1, &saved));
        assert!(entry.state.lock().unwrap().saved.is_none());
        assert!(cache.publish(
            "same-player",
            &entry,
            2,
            &Saved {
                key: "new-revision".into(),
                ..saved
            }
        ));
        worker.stop().await;
    }
    #[tokio::test]
    async fn async_factory_shares_pending_and_fresh_data_without_computation_child() {
        let worker = Worker::start().unwrap();
        let cache = Cache::new(Storage::start(), worker.clone());
        let calls = Arc::new(std::sync::atomic::AtomicU64::new(0));
        let job = serde_json::json!({"kind":"achievement_baseline","mode":"pve","args":["pve"]});
        let factory = || {
            let calls = calls.clone();
            async move {
                calls.fetch_add(1, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(5)).await;
                Ok(Computed {
                    value: serde_json::json!({"total":0,"rows":[],"ts":1000,"storage":"sqlite"}),
                    queue_ms: 0,
                    worker_ms: 0,
                })
            }
        };
        let key = "achievement-baseline:pve".to_string();
        let (one, two) = tokio::join!(
            cache.load_with(key.clone(), key.clone(), job.clone(), 1000, factory()),
            cache.load_with(key.clone(), key.clone(), job.clone(), 1000, factory())
        );
        assert_eq!(one.unwrap().value, two.unwrap().value);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            cache
                .load_with(key.clone(), key, job, 1001, factory())
                .await
                .unwrap()
                .cache,
            "hit"
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        worker.stop().await;
    }
}
