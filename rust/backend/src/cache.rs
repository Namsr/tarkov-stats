use crate::{
    compute::{Computed, Failure, Worker},
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
const TTL_MS: f64 = 300000.0;
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
        let identity = format!("statistics-v1:{fallback}");
        let (entry, created) = self.entry(&identity);
        if created {
            // The restoration itself must survive one HTTP consumer disconnecting.
            let target = entry.clone();
            let storage = self.storage.clone();
            let identity = identity.clone();
            let cache = self.clone();
            let expected_input = args
                .get("args")
                .and_then(|args| args.get(0))
                .cloned()
                .unwrap_or(Value::Null);
            tokio::spawn(async move {
                if let Some(value) = storage.read(identity).await
                    && let Ok(saved) = serde_json::from_value::<Saved>(value)
                    && !saved.value.is_null()
                    && saved.generated_at.is_finite()
                    && saved.expires_at.is_finite()
                    && crate::compute::valid_lookup(&saved.value, &expected_input)
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
                let result = cache.worker.compute(args).await;
                match &result {
                    Ok(result) => {
                        let accepted = result.value.get("available").and_then(Value::as_bool)
                            == Some(true)
                            && result
                                .value
                                .get("result")
                                .is_some_and(|value| !value.is_null());
                        if accepted {
                            let generated_at = now + started.elapsed().as_millis() as f64;
                            let saved = Saved {
                                key: job_key,
                                value: result.value.clone(),
                                generated_at,
                                expires_at: generated_at + TTL_MS,
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
}
