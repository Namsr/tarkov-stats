use crate::{config, storage::Storage};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use tokio::sync::{Mutex, watch};

pub const FILE_LIMIT: usize = 2 * 1024 * 1024;
const TASK_LIMIT: usize = 16 * 1024 * 1024;
const TRANSLATION_LIMIT: usize = 4 * 1024 * 1024;
const TTL: f64 = 21_600_000.0;
#[derive(Clone, Copy, Debug)]
pub enum Mode {
    Regular,
    Seasonal,
}
impl Mode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Regular => "regular",
            Self::Seasonal => "seasonal",
        }
    }
    fn index(self) -> usize {
        match self {
            Self::Regular => 0,
            Self::Seasonal => 1,
        }
    }
    fn path(self) -> &'static str {
        match self {
            Self::Regular => "regular",
            Self::Seasonal => "pvp-season",
        }
    }
}
#[derive(Clone)]
struct Saved {
    entries: Value,
    at: f64,
}
#[derive(Default)]
struct Entry {
    loaded: bool,
    saved: Option<Saved>,
    pending: Option<watch::Receiver<Option<Value>>>,
}
#[cfg(test)]
type Loader = Arc<
    dyn Fn(Mode) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Value, ()>> + Send>>
        + Send
        + Sync,
>;
#[derive(Clone)]
pub struct Reference {
    client: reqwest::Client,
    storage: Storage,
    entries: Arc<[Mutex<Entry>; 2]>,
    #[cfg(test)]
    loader: Option<Loader>,
    #[cfg(test)]
    skip_files: bool,
}
fn percentage(value: Option<&Value>) -> Option<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|number| number.is_finite() && (0.0..=100.0).contains(number))
}
pub fn image(value: Option<&Value>) -> Value {
    let Some(raw) = value
        .and_then(Value::as_str)
        .filter(|value| !config::trim(value).is_empty())
    else {
        return Value::Null;
    };
    let Ok(url) = url::Url::parse(config::trim(raw)) else {
        return Value::Null;
    };
    if url.scheme() != "https" || url.host_str() != Some("assets.tarkov.dev") {
        return Value::Null;
    }
    json!(url.as_str())
}
fn rarity(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .filter(|value| ["common", "rare", "legendary", "seasonal"].contains(value))
}
fn text(value: Option<&Value>) -> Value {
    value
        .and_then(Value::as_str)
        .map_or(Value::Null, |value| json!(value))
}
fn translations(payload: &Value) -> Option<&serde_json::Map<String, Value>> {
    let values = payload.get("data")?.as_object()?;
    if !values.values().all(Value::is_string)
        || !values
            .values()
            .any(|value| !config::trim(value.as_str().unwrap()).is_empty())
    {
        return None;
    }
    Some(values)
}
pub fn parse(tasks: &Value, english: &Value, russian: &Value) -> Option<Value> {
    let rows = tasks
        .get("data")?
        .get("achievements")?
        .as_object()
        .filter(|values| !values.is_empty())?;
    let english = translations(english)?;
    let russian = translations(russian)?;
    let mut result = Vec::with_capacity(rows.len());
    let mut bytes = 2usize;
    for (id, row) in rows {
        if row.get("id").and_then(Value::as_str) != Some(id) {
            return None;
        }
        let translated = |values: &serde_json::Map<String, Value>, field: &str| {
            values
                .get(row.get(field).and_then(Value::as_str).unwrap_or(""))
                .and_then(Value::as_str)
                .map(config::trim)
                .filter(|value| !value.is_empty())
                .map(String::from)
        };
        let name = translated(english, "name")
            .or_else(|| {
                row.get("normalizedName")
                    .and_then(Value::as_str)
                    .map(config::trim)
                    .filter(|value| !value.is_empty())
                    .map(String::from)
            })
            .unwrap_or_else(|| id.clone());
        let value = json!({"id":id,"name":name,"nameEn":name,"nameRu":translated(russian,"name"),"descriptionEn":translated(english,"description"),"descriptionRu":translated(russian,"description"),"imageUrl":image(row.get("imageLink")),"side":row.get("side").and_then(Value::as_str).unwrap_or(""),"rarity":rarity(row.get("normalizedRarity"))?,"playersCompletedPercent":percentage(row.get("playersCompletedPercent"))?,"adjustedPlayersCompletedPercent":percentage(row.get("adjustedPlayersCompletedPercent"))?});
        let pair = json!([id, value]);
        bytes = bytes.saturating_add(serde_json::to_vec(&pair).ok()?.len() + 1);
        if bytes > FILE_LIMIT {
            return None;
        }
        result.push(pair);
    }
    Some(Value::Array(result))
}
fn persisted_entry(row: &Value) -> Option<Value> {
    let value = row.as_object()?;
    let id = value.get("id")?.as_str()?;
    let name = value.get("name")?.as_str()?;
    let name_en = value.get("nameEn")?.as_str()?;
    let name_ru = value.get("nameRu")?;
    if !name_ru.is_null() && !name_ru.is_string() {
        return None;
    }
    Some(
        json!({"id":id,"name":name,"nameEn":name_en,"nameRu":name_ru,"descriptionEn":text(value.get("descriptionEn")),"descriptionRu":text(value.get("descriptionRu")),"imageUrl":image(value.get("imageUrl")),"side":value.get("side")?.as_str()?,"rarity":rarity(value.get("rarity"))?,"playersCompletedPercent":percentage(value.get("playersCompletedPercent"))?,"adjustedPlayersCompletedPercent":percentage(value.get("adjustedPlayersCompletedPercent"))?}),
    )
}
pub fn parse_persisted(root: &Value, mode: Mode) -> Option<(Value, f64)> {
    let version = root.get("version")?.as_f64()?;
    let at = root
        .get("savedAt")?
        .as_f64()
        .filter(|value| value.is_finite())?;
    if ![1.0, 2.0].contains(&version) || root.get("mode")?.as_str()? != mode.as_str() {
        return None;
    }
    let values = root
        .get("entries")?
        .as_array()
        .filter(|values| !values.is_empty())?;
    let mut legacy = version == 1.0;
    let mut result: Vec<Value> = Vec::with_capacity(values.len());
    let mut bytes = 2usize;
    for raw in values {
        legacy |= ["descriptionEn", "descriptionRu", "imageUrl"]
            .iter()
            .any(|field| raw.get(*field).is_none());
        let value = persisted_entry(raw)?;
        let id = value.get("id")?.as_str()?;
        if let Some(existing) = result
            .iter_mut()
            .find(|pair| pair.get(0).and_then(Value::as_str) == Some(id))
        {
            *existing = json!([id, value]);
        } else {
            let pair = json!([id, value]);
            bytes = bytes.saturating_add(serde_json::to_vec(&pair).ok()?.len() + 1);
            if bytes > FILE_LIMIT {
                return None;
            }
            result.push(pair);
        }
    }
    if serde_json::to_vec(&result).ok()?.len() > FILE_LIMIT {
        return None;
    }
    Some((Value::Array(result), if legacy { 0.0 } else { at }))
}
fn valid_entry(value: &Value) -> bool {
    persisted_entry(value).is_some()
        && ["descriptionEn", "descriptionRu", "imageUrl"]
            .iter()
            .all(|field| {
                value
                    .get(*field)
                    .is_none_or(|value| value.is_null() || value.is_string())
            })
        && image(value.get("imageUrl")) == value.get("imageUrl").cloned().unwrap_or(Value::Null)
}
pub fn valid_metadata(value: &Value, job: &Value) -> bool {
    job.get("kind").and_then(Value::as_str) == Some("achievement_metadata")
        && matches!(
            job.get("mode").and_then(Value::as_str),
            Some("regular" | "seasonal")
        )
        && value.as_array().is_some_and(|values| {
            values.iter().all(|pair| {
                pair.as_array().is_some_and(|pair| {
                    pair.len() == 2
                        && pair[0].is_string()
                        && pair[1].get("id") == Some(&pair[0])
                        && valid_entry(&pair[1])
                })
            })
        })
}
impl Reference {
    pub fn new(storage: Storage) -> Result<Self, String> {
        // Install the one selected provider once. OS roots/hostname checks remain enabled.
        static PROVIDER: std::sync::OnceLock<()> = std::sync::OnceLock::new();
        PROVIDER.get_or_init(|| {
            if rustls::crypto::CryptoProvider::get_default().is_none() {
                let _ = rustls::crypto::ring::default_provider().install_default();
            }
        });
        let client = reqwest::Client::builder()
            .https_only(true)
            .user_agent("tarkovstats.ru")
            .timeout(Duration::from_secs(8))
            .redirect(reqwest::redirect::Policy::limited(20))
            .build()
            .map_err(|error| error.to_string())?;
        Ok(Self {
            client,
            storage,
            entries: Arc::new([Mutex::new(Entry::default()), Mutex::new(Entry::default())]),
            #[cfg(test)]
            loader: None,
            #[cfg(test)]
            skip_files: false,
        })
    }
    async fn fetch_json(&self, url: String, limit: usize) -> Result<Value, ()> {
        let mut response = self
            .client
            .get(url)
            .header(reqwest::header::ACCEPT, "application/json")
            .send()
            .await
            .map_err(|_| ())?;
        if !response.status().is_success()
            || response
                .content_length()
                .is_some_and(|length| length > limit as u64)
        {
            return Err(());
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| ())? {
            if bytes.len().saturating_add(chunk.len()) > limit {
                return Err(());
            }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes).map_err(|_| ())
    }
    async fn fetch(&self, mode: Mode) -> Result<Value, ()> {
        #[cfg(test)]
        if let Some(loader) = &self.loader {
            return loader(mode).await;
        }
        let root = format!("https://json.tarkov.dev/{}/", mode.path());
        let (tasks, english, russian) = tokio::join!(
            self.fetch_json(format!("{root}tasks"), TASK_LIMIT),
            self.fetch_json(format!("{root}tasks_en"), TRANSLATION_LIMIT),
            self.fetch_json(format!("{root}tasks_ru"), TRANSLATION_LIMIT)
        );
        parse(&tasks?, &english?, &russian?).ok_or(())
    }
    pub async fn get(&self, mode: Mode) -> Value {
        let mut state = self.entries[mode.index()].lock().await;
        if !state.loaded {
            #[cfg(test)]
            let read_files = !self.skip_files;
            #[cfg(not(test))]
            let read_files = true;
            if read_files
                && let Some(value) = self.storage.read_reference(mode).await
                && let Some((entries, at)) = parse_persisted(&value, mode)
            {
                state.saved = Some(Saved { entries, at });
            }
            state.loaded = true;
        }
        if let Some(saved) = &state.saved
            && crate::now_ms() as f64 - saved.at < TTL
        {
            return saved.entries.clone();
        }
        let fallback = state.saved.clone();
        let mut pending = if let Some(pending) = &state.pending {
            pending.clone()
        } else {
            let (sender, receiver) = watch::channel(None);
            state.pending = Some(receiver.clone());
            let reference = self.clone();
            tokio::spawn(async move {
                let result = reference.fetch(mode).await.ok().filter(|value| {
                    value.as_array().is_some_and(|values| !values.is_empty())
                        && serde_json::to_vec(value).is_ok_and(|bytes| bytes.len() <= FILE_LIMIT)
                });
                let value = if let Some(entries) = result {
                    let at = crate::now_ms();
                    reference.entries[mode.index()].lock().await.saved = Some(Saved {
                        entries: entries.clone(),
                        at: at as f64,
                    });
                    #[cfg(test)]
                    let write_files = !reference.skip_files;
                    #[cfg(not(test))]
                    let write_files = true;
                    if write_files {
                        reference.storage.write_reference(mode,json!({"version":2,"mode":mode.as_str(),"savedAt":at,"entries":entries.as_array().unwrap().iter().map(|pair|pair[1].clone()).collect::<Vec<_>>()})).await;
                    }
                    entries
                } else {
                    eprintln!(
                        "Tarkov achievement reference unavailable: {}",
                        mode.as_str()
                    );
                    reference.entries[mode.index()]
                        .lock()
                        .await
                        .saved
                        .as_ref()
                        .map_or_else(|| json!([]), |saved| saved.entries.clone())
                };
                reference.entries[mode.index()].lock().await.pending = None;
                sender.send_replace(Some(value));
            });
            receiver
        };
        if let Some(saved) = fallback {
            return saved.entries;
        }
        drop(state);
        loop {
            if let Some(value) = pending.borrow_and_update().clone() {
                return value;
            }
            if pending.changed().await.is_err() {
                return json!([]);
            }
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn payloads() -> (Value, Value, Value) {
        (
            json!({"data":{"achievements":{"id":{"id":"id","name":"title","description":"desc","normalizedName":" fallback ","normalizedRarity":"rare","side":"pmc","imageLink":"https://ASSETS.TARKOV.DEV/image.png","playersCompletedPercent":0,"adjustedPlayersCompletedPercent":100}}}}),
            json!({"data":{"title":" English ","desc":" Description "}}),
            json!({"data":{"title":" Русское ","desc":" Описание "}}),
        )
    }
    #[test]
    fn parser_preserves_translations_percentages_and_official_image_host() {
        let (t, e, r) = payloads();
        let value = parse(&t, &e, &r).unwrap();
        assert_eq!(value[0][1]["name"], "English");
        assert_eq!(value[0][1]["nameRu"], "Русское");
        assert_eq!(value[0][1]["descriptionRu"], "Описание");
        assert_eq!(value[0][1]["playersCompletedPercent"], 0.0);
        assert_eq!(
            value[0][1]["imageUrl"],
            "https://assets.tarkov.dev/image.png"
        );
        assert!(image(Some(&json!("http://assets.tarkov.dev/x"))).is_null());
        assert!(image(Some(&json!("https://example.com/x"))).is_null());
    }
    #[test]
    fn parser_rejects_partial_or_invalid_reference_instead_of_caching_empty_success() {
        let (mut t, e, r) = payloads();
        assert!(parse(&t, &json!({"data":{}}), &r).is_none());
        t["data"]["achievements"]["id"]["playersCompletedPercent"] = json!(101);
        assert!(parse(&t, &e, &r).is_none());
        t["data"]["achievements"]["id"]["playersCompletedPercent"] = json!("1");
        assert!(parse(&t, &e, &r).is_none());
    }
    #[test]
    fn old_persisted_versions_refresh_but_keep_valid_fallback() {
        let (t, e, r) = payloads();
        let entries = parse(&t, &e, &r).unwrap();
        let mut root =
            json!({"version":2,"mode":"regular","savedAt":100,"entries":[entries[0][1]]});
        assert_eq!(parse_persisted(&root, Mode::Regular).unwrap().1, 100.0);
        root["version"] = json!(1);
        assert_eq!(parse_persisted(&root, Mode::Regular).unwrap().1, 0.0);
        root["version"] = json!(2);
        root["entries"][0]
            .as_object_mut()
            .unwrap()
            .remove("imageUrl");
        assert_eq!(parse_persisted(&root, Mode::Regular).unwrap().1, 0.0);
        assert!(parse_persisted(&root, Mode::Seasonal).is_none());
    }
    #[tokio::test]
    async fn stale_reference_returns_fallback_before_failed_refresh_and_keeps_original_age() {
        let (t, e, r) = payloads();
        let entries = parse(&t, &e, &r).unwrap();
        let mut reference = Reference::new(Storage::start()).unwrap();
        reference.skip_files = true;
        {
            let mut state = reference.entries[0].lock().await;
            state.loaded = true;
            state.saved = Some(Saved {
                entries: entries.clone(),
                at: 0.0,
            });
        }
        let release = Arc::new(tokio::sync::Notify::new());
        let gate = release.clone();
        reference.loader = Some(Arc::new(move |_| {
            let gate = gate.clone();
            Box::pin(async move {
                gate.notified().await;
                Err(())
            })
        }));
        assert_eq!(reference.get(Mode::Regular).await, entries);
        let mut pending = reference.entries[0].lock().await.pending.clone().unwrap();
        release.notify_one();
        pending.changed().await.unwrap();
        assert_eq!(pending.borrow().as_ref().unwrap(), &entries);
        let state = reference.entries[0].lock().await;
        assert_eq!(state.saved.as_ref().unwrap().at, 0.0);
        assert!(state.pending.is_none());
    }
    #[tokio::test]
    async fn cold_reference_singleflight_and_failure_retry_are_bounded_to_mode() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let calls = Arc::new(AtomicUsize::new(0));
        let counter = calls.clone();
        let (t, e, r) = payloads();
        let entries = parse(&t, &e, &r).unwrap();
        let mut reference = Reference::new(Storage::start()).unwrap();
        reference.skip_files = true;
        reference.loader = Some(Arc::new(move |_| {
            let counter = counter.clone();
            let entries = entries.clone();
            Box::pin(async move {
                let call = counter.fetch_add(1, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(5)).await;
                if call == 0 { Err(()) } else { Ok(entries) }
            })
        }));
        let (a, b) = tokio::join!(reference.get(Mode::Regular), reference.get(Mode::Regular));
        assert_eq!(a, json!([]));
        assert_eq!(a, b);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(
            !reference
                .get(Mode::Regular)
                .await
                .as_array()
                .unwrap()
                .is_empty()
        );
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert!(
            !reference
                .get(Mode::Regular)
                .await
                .as_array()
                .unwrap()
                .is_empty()
        );
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }
}
