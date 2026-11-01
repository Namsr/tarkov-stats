use crate::state::{FIELDS, Params, number};
use serde_json::Value;

pub fn matches(url: &str, body: &Value) -> bool {
    if let Some(valid) = crate::persistent::data::matches(url, body) {
        return valid;
    }
    if body["mode"] != "arena"
        || body["schemaVersion"] != 5
        || !body["metrics"].is_object()
        || !body["buckets"].is_array()
    {
        return false;
    }
    let params = Params::parse(url.split_once('?').map_or("", |(_, query)| query));
    let id = &body["filterIdentity"];
    for (field, key, default) in [
        ("mode", "arenaMode", ""),
        ("statistic", "statistic", "trimmed_mean"),
        ("dimension", "dimension", "matches"),
        ("metric", "metric", "players"),
    ] {
        if id[field].as_str() != Some(params.get(key).unwrap_or(default)) {
            return false;
        }
    }
    FIELDS.iter().all(|key| {
        if id.get(*key).is_none() {
            return false;
        }
        let expected = params.get(key).and_then(number);
        if let Some(value) = expected {
            id[*key].as_f64() == Some(value)
        } else {
            id[*key].is_null()
        }
    })
}

#[cfg(feature = "hydrate")]
pub use browser::*;
#[cfg(feature = "hydrate")]
mod browser {
    use super::*;
    use crate::{
        data::ArenaInitial,
        state::{ArenaState, MODES},
    };
    use js_sys::{Array, Reflect};
    use leptos::prelude::*;
    use std::{
        cell::{Cell, RefCell},
        collections::{HashMap, VecDeque},
        rc::{Rc, Weak},
    };
    use wasm_bindgen::{JsCast, JsValue, closure::Closure};
    use wasm_bindgen_futures::{JsFuture, spawn_local};
    use web_sys::{AbortController, RequestCache, RequestInit, Response};

    #[derive(Clone)]
    pub(crate) struct Reply {
        pub body: Value,
        pub status: u16,
        pub retry: u64,
        pub stale: bool,
        pub generated: f64,
        // Arena has no scheduled publication age; Persistent consumes this independently of retry staleness.
        #[cfg_attr(not(feature = "hydrate-persistent"), allow(dead_code))]
        pub publication_stale: bool,
    }
    type Answer = Result<Reply, String>;
    type Listener = Box<dyn Fn(Answer)>;
    struct Flight {
        token: u64,
        controller: AbortController,
        listeners: HashMap<u64, Listener>,
        prefetch: bool,
    }
    #[derive(Default)]
    struct Client {
        cache: VecDeque<(String, Reply)>,
        flights: HashMap<String, Flight>,
        next: u64,
        queued: VecDeque<String>,
        prefetching: usize,
        idle: Option<Timer>,
    }
    thread_local! { static CLIENT: RefCell<Client> = RefCell::new(Client::default()); }
    pub(crate) struct Timer {
        handle: i32,
        idle: bool,
        _callback: Closure<dyn FnMut()>,
    }
    impl Timer {
        pub(crate) fn new(ms: u64, work: impl FnMut() + 'static) -> Option<Self> {
            let callback = Closure::wrap(Box::new(work) as Box<dyn FnMut()>);
            let handle = web_sys::window()?
                .set_timeout_with_callback_and_timeout_and_arguments_0(
                    callback.as_ref().unchecked_ref(),
                    ms.min(i32::MAX as u64) as i32,
                )
                .ok()?;
            Some(Self {
                handle,
                idle: false,
                _callback: callback,
            })
        }
    }
    impl Timer {
        fn idle(work: impl FnMut() + 'static) -> Option<Self> {
            let callback = Closure::wrap(Box::new(work) as Box<dyn FnMut()>);
            let window = web_sys::window()?;
            let (handle, idle) =
                match window.request_idle_callback(callback.as_ref().unchecked_ref()) {
                    Ok(handle) => (handle as i32, true),
                    Err(_) => (
                        window
                            .set_timeout_with_callback_and_timeout_and_arguments_0(
                                callback.as_ref().unchecked_ref(),
                                250,
                            )
                            .ok()?,
                        false,
                    ),
                };
            Some(Self {
                handle,
                idle,
                _callback: callback,
            })
        }
    }
    impl Drop for Timer {
        fn drop(&mut self) {
            if let Some(window) = web_sys::window() {
                if self.idle {
                    window.cancel_idle_callback(self.handle as u32);
                } else {
                    window.clear_timeout_with_handle(self.handle);
                }
            }
        }
    }
    pub(crate) fn remember(url: &str, reply: Reply) -> Reply {
        CLIENT.with(|client| {
            let mut client = client.borrow_mut();
            if let Some(index) = client.cache.iter().position(|(key, _)| key == url) {
                let (_, previous) = client.cache.remove(index).expect("known cached URL");
                if previous.generated > reply.generated {
                    client.cache.push_back((url.into(), previous.clone()));
                    return previous;
                }
            }
            client.cache.push_back((url.into(), reply.clone()));
            while client.cache.len() > 64 {
                client.cache.pop_front();
            }
            reply
        })
    }
    async fn fetch(url: &str, controller: &AbortController, refresh: bool) -> Answer {
        let options = RequestInit::new();
        options.set_signal(Some(&controller.signal()));
        options.set_cache(if refresh {
            RequestCache::NoStore
        } else {
            RequestCache::Default
        });
        let response = JsFuture::from(
            web_sys::window()
                .ok_or("window unavailable")?
                .fetch_with_str_and_init(url, &options),
        )
        .await
        .map_err(|_| "request failed")?
        .dyn_into::<Response>()
        .map_err(|_| "invalid response")?;
        let status = response.status();
        let headers = response.headers();
        let text = JsFuture::from(response.text().map_err(|_| "invalid response body")?)
            .await
            .map_err(|_| "invalid response body")?
            .as_string()
            .ok_or("invalid response body")?;
        if controller.signal().aborted() {
            return Err("aborted".into());
        }
        let body = serde_json::from_str(&text).map_err(|_| "invalid response JSON")?;
        let raw = headers
            .get("retry-after")
            .ok()
            .flatten()
            .and_then(|v| v.parse::<f64>().ok())
            .filter(|v| v.is_finite() && *v != 0.0)
            .unwrap_or(5.0);
        let generated = headers
            .get("x-statistics-generated-at")
            .ok()
            .flatten()
            .or_else(|| headers.get("x-average-generated-at").ok().flatten())
            .and_then(|v| v.parse::<f64>().ok())
            .filter(|v| v.is_finite() && *v >= 0.0)
            .unwrap_or(0.0);
        Ok(Reply {
            body,
            status,
            retry: raw.clamp(1.0, 15.0).ceil() as u64,
            stale: headers.get("x-statistics-stale").ok().flatten().as_deref() == Some("1"),
            generated,
            publication_stale: headers.get("x-average-stale").ok().flatten().as_deref()
                == Some("1"),
        })
    }
    fn launch(url: String, prefetch: bool, refresh: bool) {
        let Ok(controller) = AbortController::new() else {
            return;
        };
        let token = CLIENT.with(|client| {
            let mut client = client.borrow_mut();
            client.next += 1;
            let token = client.next;
            client.flights.insert(
                url.clone(),
                Flight {
                    token,
                    controller: controller.clone(),
                    listeners: HashMap::new(),
                    prefetch,
                },
            );
            if prefetch {
                client.prefetching += 1;
            }
            token
        });
        spawn_local(async move {
            let incoming = fetch(&url, &controller, refresh).await;
            let flight = CLIENT.with(|client| {
                let mut client = client.borrow_mut();
                if client
                    .flights
                    .get(&url)
                    .is_none_or(|flight| flight.token != token)
                {
                    return None;
                }
                let flight = client.flights.remove(&url)?;
                if flight.prefetch {
                    client.prefetching = client.prefetching.saturating_sub(1);
                }
                Some(flight)
            });
            if let Some(flight) = flight
                && !controller.signal().aborted()
            {
                let result = incoming.map(|reply| {
                    if (200..300).contains(&reply.status) && matches(&url, &reply.body) {
                        remember(&url, reply)
                    } else {
                        reply
                    }
                });
                for listener in flight.listeners.into_values() {
                    listener(result.clone());
                }
            }
            drain();
        });
    }
    struct Subscription {
        url: String,
        id: u64,
    }
    impl Drop for Subscription {
        fn drop(&mut self) {
            let abort = CLIENT.with(|client| {
                let mut client = client.borrow_mut();
                if let Some(flight) = client.flights.get_mut(&self.url) {
                    flight.listeners.remove(&self.id);
                    if flight.listeners.is_empty() && !flight.prefetch {
                        return client.flights.remove(&self.url).map(|f| f.controller);
                    }
                }
                None
            });
            if let Some(controller) = abort {
                controller.abort();
            }
        }
    }
    fn request(url: &str, refresh: bool, listener: Listener) -> Subscription {
        let id = CLIENT.with(|client| {
            let mut client = client.borrow_mut();
            client.next += 1;
            client.next
        });
        if !refresh
            && let Some(reply) = CLIENT.with(|client| {
                client
                    .borrow()
                    .cache
                    .iter()
                    .find(|(key, _)| key == url)
                    .map(|(_, value)| value.clone())
            })
        {
            listener(Ok(reply));
            return Subscription {
                url: url.into(),
                id,
            };
        }
        if !CLIENT.with(|client| client.borrow().flights.contains_key(url)) {
            launch(url.into(), false, refresh);
        }
        CLIENT.with(|client| {
            let mut client = client.borrow_mut();
            if let Some(flight) = client.flights.get_mut(url) {
                if flight.prefetch {
                    flight.prefetch = false;
                    client.prefetching = client.prefetching.saturating_sub(1);
                }
                if let Some(flight) = client.flights.get_mut(url) {
                    flight.listeners.insert(id, listener);
                }
            }
        });
        Subscription {
            url: url.into(),
            id,
        }
    }
    struct WatchInner {
        url: String,
        sink: Rc<dyn Fn(Result<Reply, String>)>,
        good: Cell<bool>,
        closed: Cell<bool>,
        timer: RefCell<Option<Timer>>,
        pending: RefCell<Option<Subscription>>,
    }
    pub(crate) struct Watch(Rc<WatchInner>);
    impl WatchInner {
        fn schedule(this: &Rc<Self>, ms: u64) {
            let weak = Rc::downgrade(this);
            this.timer.replace(Timer::new(ms, move || {
                let Some(this) = weak.upgrade() else {
                    return;
                };
                this.timer.borrow_mut().take();
                if web_sys::window()
                    .and_then(|w| w.document())
                    .is_some_and(|d| d.visibility_state() == web_sys::VisibilityState::Hidden)
                {
                    Self::schedule(&this, ms);
                } else {
                    Self::load(&this, true);
                }
            }));
        }
        fn accept(this: &Rc<Self>, answer: Answer) {
            if this.closed.get() {
                return;
            }
            this.pending.borrow_mut().take();
            match answer {
                Ok(reply)
                    if (200..300).contains(&reply.status) && matches(&this.url, &reply.body) =>
                {
                    this.good.set(true);
                    (this.sink)(Ok(reply.clone()));
                    Self::schedule(
                        this,
                        if reply.stale {
                            reply.retry * 1000
                        } else {
                            60000
                        },
                    );
                }
                Ok(reply) if reply.status == 503 => Self::schedule(this, reply.retry * 1000),
                _ if this.good.get() => Self::schedule(this, 5000),
                _ => (this.sink)(Err("request failed".into())),
            }
        }
        fn load(this: &Rc<Self>, refresh: bool) {
            if this.closed.get() {
                return;
            }
            let weak: Weak<Self> = Rc::downgrade(this);
            let pending = request(
                &this.url,
                refresh,
                Box::new(move |answer| {
                    if let Some(this) = weak.upgrade() {
                        Self::accept(&this, answer);
                    }
                }),
            );
            this.pending.replace(Some(pending));
        }
    }
    impl Watch {
        pub(crate) fn new(
            url: String,
            initial: Option<Reply>,
            sink: impl Fn(Result<Value, String>) + 'static,
        ) -> Self {
            Self::with_reply(url, initial, move |answer| {
                sink(answer.map(|reply| reply.body))
            })
        }
        pub(crate) fn with_reply(
            url: String,
            initial: Option<Reply>,
            sink: impl Fn(Result<Reply, String>) + 'static,
        ) -> Self {
            let inner = Rc::new(WatchInner {
                url,
                sink: Rc::new(sink),
                good: Cell::new(false),
                closed: Cell::new(false),
                timer: RefCell::new(None),
                pending: RefCell::new(None),
            });
            if let Some(reply) = initial {
                WatchInner::accept(&inner, Ok(reply));
            } else {
                WatchInner::load(&inner, false);
            }
            Self(inner)
        }
    }
    impl Drop for Watch {
        fn drop(&mut self) {
            self.0.closed.set(true);
            self.0.timer.borrow_mut().take();
            self.0.pending.borrow_mut().take();
        }
    }
    fn permitted() -> bool {
        let Some(window) = web_sys::window() else {
            return false;
        };
        if window
            .document()
            .is_some_and(|d| d.visibility_state() == web_sys::VisibilityState::Hidden)
        {
            return false;
        }
        let connection = Reflect::get(
            window.navigator().as_ref(),
            &JsValue::from_str("connection"),
        )
        .unwrap_or(JsValue::UNDEFINED);
        if Reflect::get(&connection, &JsValue::from_str("saveData"))
            .ok()
            .and_then(|v| v.as_bool())
            == Some(true)
        {
            return false;
        }
        !matches!(
            Reflect::get(&connection, &JsValue::from_str("effectiveType"))
                .ok()
                .and_then(|v| v.as_string())
                .as_deref(),
            Some("slow-2g" | "2g")
        )
    }
    fn drain() {
        loop {
            let url = CLIENT.with(|client| {
                let mut client = client.borrow_mut();
                if client.prefetching >= 2 {
                    return None;
                }
                while let Some(url) = client.queued.pop_front() {
                    if !client.flights.contains_key(&url)
                        && !client.cache.iter().any(|(key, _)| key == &url)
                    {
                        return Some(url);
                    }
                }
                None
            });
            if let Some(url) = url {
                if permitted() {
                    launch(url, true, false);
                }
            } else {
                break;
            }
        }
    }
    pub(crate) fn cancel_prefetch() {
        let aborted = CLIENT.with(|client| {
            let mut client = client.borrow_mut();
            client.queued.clear();
            client.idle.take();
            let keys: Vec<_> = client
                .flights
                .iter()
                .filter(|(_, flight)| flight.prefetch)
                .map(|(key, _)| key.clone())
                .collect();
            let aborted: Vec<_> = keys
                .into_iter()
                .filter_map(|key| client.flights.remove(&key).map(|flight| flight.controller))
                .collect();
            client.prefetching = 0;
            aborted
        });
        for controller in aborted {
            controller.abort();
        }
    }
    pub(crate) fn prefetch(urls: Vec<String>) {
        if !permitted() {
            return;
        }
        CLIENT.with(|client| {
            let mut client = client.borrow_mut();
            for url in urls {
                if client.queued.len() < 10
                    && !client.queued.contains(&url)
                    && !client.flights.contains_key(&url)
                    && !client.cache.iter().any(|(key, _)| key == &url)
                {
                    client.queued.push_back(url);
                }
            }
            if client.idle.is_none() {
                client.idle = Timer::idle(|| {
                    CLIENT.with(|client| {
                        client.borrow_mut().idle.take();
                    });
                    drain();
                });
            }
        });
    }
    #[derive(Clone, Copy)]
    pub struct Signals {
        pub state: RwSignal<ArenaState>,
        pub selected: RwSignal<Option<Value>>,
        pub context: RwSignal<Option<Value>>,
        pub overview: RwSignal<Option<Value>>,
        pub selected_loading: RwSignal<bool>,
        pub selected_error: RwSignal<bool>,
        pub context_loading: RwSignal<bool>,
        pub context_error: RwSignal<bool>,
    }
    pub struct Runtime {
        _watches: Rc<RefCell<(Option<Watch>, Option<Watch>)>>,
        _pop: Closure<dyn FnMut()>,
        _window: web_sys::Window,
    }
    impl Drop for Runtime {
        fn drop(&mut self) {
            let _ = self._window.remove_event_listener_with_callback(
                "popstate",
                self._pop.as_ref().unchecked_ref(),
            );
            self._watches.borrow_mut().0.take();
            self._watches.borrow_mut().1.take();
            cancel_prefetch();
        }
    }
    pub fn mount(signals: Signals, initial: ArenaInitial) -> Runtime {
        let watches = Rc::new(RefCell::new((None::<Watch>, None::<Watch>)));
        let keys = Rc::new(RefCell::new((String::new(), String::new())));
        let first = Rc::new(Cell::new(true));
        let for_effect = watches.clone();
        Effect::new(move |_| {
            let state = signals.state.get();
            let selected_url = state.selected_request();
            let context_url = state.context_request();
            let first_run = first.replace(false);
            if keys.borrow().1 != context_url {
                for_effect.borrow_mut().1.take();
                signals.context_error.set(false);
                signals.context_loading.set(true);
                let seeded = if first_run {
                    Some(Reply {
                        body: initial.context.clone().unwrap_or(Value::Null),
                        status: initial.meta.context_status,
                        stale: initial.meta.context_stale,
                        retry: initial.meta.context_retry_after.clamp(1, 15),
                        generated: initial.meta.context_generated_at,
                        publication_stale: false,
                    })
                } else {
                    None
                };
                if let Some(reply) = &seeded
                    && reply.status == 200
                    && matches(&context_url, &reply.body)
                {
                    remember(&context_url, reply.clone());
                }
                for_effect.borrow_mut().1 = Some(Watch::new(
                    context_url.clone(),
                    seeded,
                    move |answer| match answer {
                        Ok(value) => {
                            signals.overview.set(Some(value.clone()));
                            signals.context.set(Some(value));
                            signals.context_error.set(false);
                            signals.context_loading.set(false);
                        }
                        Err(_) => {
                            signals.context.set(None);
                            signals.context_error.set(true);
                            signals.context_loading.set(false);
                        }
                    },
                ));
                keys.borrow_mut().1 = context_url;
                cancel_prefetch();
            }
            if keys.borrow().0 != selected_url || state.filters[state.selected].invalid() {
                for_effect.borrow_mut().0.take();
                signals.selected_error.set(false);
                if state.filters[state.selected].invalid() {
                    signals.selected.set(None);
                    signals.selected_loading.set(false);
                    keys.borrow_mut().0.clear();
                } else {
                    signals.selected_loading.set(true);
                    let seeded = if first_run {
                        Some(Reply {
                            body: initial.selected.clone().unwrap_or(Value::Null),
                            status: initial.meta.selected_status,
                            stale: initial.meta.selected_stale,
                            retry: initial.meta.selected_retry_after.clamp(1, 15),
                            generated: initial.meta.selected_generated_at,
                            publication_stale: false,
                        })
                    } else {
                        None
                    };
                    if let Some(reply) = &seeded
                        && reply.status == 200
                        && matches(&selected_url, &reply.body)
                    {
                        remember(&selected_url, reply.clone());
                    }
                    for_effect.borrow_mut().0 = Some(Watch::new(
                        selected_url.clone(),
                        seeded,
                        move |answer| match answer {
                            Ok(value) => {
                                signals.selected.set(Some(value));
                                signals.selected_error.set(false);
                                signals.selected_loading.set(false);
                            }
                            Err(_) => {
                                signals.selected.set(None);
                                signals.selected_error.set(true);
                                signals.selected_loading.set(false);
                            }
                        },
                    ));
                    keys.borrow_mut().0 = selected_url;
                }
            }
            prefetch(
                MODES
                    .iter()
                    .map(|mode| ArenaState::context(mode, &state.statistic, "matches"))
                    .filter(|url| url != &keys.borrow().0 && url != &keys.borrow().1)
                    .collect(),
            );
        });
        let window = web_sys::window().expect("hydration window");
        let pop = Closure::wrap(Box::new(move || {
            if let Some(window) = web_sys::window() {
                let search = window.location().search().unwrap_or_default();
                // Location.search includes one separator; ArenaState accepts raw query data.
                signals.state.set(ArenaState::read(
                    search.strip_prefix('?').unwrap_or(&search),
                ));
            }
        }) as Box<dyn FnMut()>);
        let _ = window.add_event_listener_with_callback("popstate", pop.as_ref().unchecked_ref());
        Runtime {
            _watches: watches,
            _pop: pop,
            _window: window,
        }
    }
    pub fn replace_history(state: &ArenaState) {
        if let Some(window) = web_sys::window() {
            let location = window.location();
            let query = state.params.query();
            let path = format!(
                "{}{}{}",
                location.pathname().unwrap_or_default(),
                if query.is_empty() {
                    String::new()
                } else {
                    format!("?{query}")
                },
                location.hash().unwrap_or_default()
            );
            if let Ok(history) = window.history() {
                let _ = history.replace_state_with_url(&JsValue::NULL, "", Some(&path));
            }
        }
    }
    pub struct Resize {
        observer: web_sys::ResizeObserver,
        _callback: Closure<dyn FnMut(Array)>,
    }
    impl Drop for Resize {
        fn drop(&mut self) {
            self.observer.disconnect();
        }
    }
    pub fn observe(element: &web_sys::Element, width: RwSignal<f64>) -> Option<Resize> {
        width.set(element.get_bounding_client_rect().width());
        let callback = Closure::wrap(Box::new(move |entries: Array| {
            if let Ok(entry) = entries.get(0).dyn_into::<web_sys::ResizeObserverEntry>() {
                width.set(entry.content_rect().width());
            }
        }) as Box<dyn FnMut(Array)>);
        let observer = web_sys::ResizeObserver::new(callback.as_ref().unchecked_ref()).ok()?;
        observer.observe(element);
        Some(Resize {
            observer,
            _callback: callback,
        })
    }
    pub fn capture(event: &web_sys::PointerEvent) {
        if let Some(target) = event
            .target()
            .and_then(|target| target.dyn_into::<web_sys::Element>().ok())
        {
            let _ = target.set_pointer_capture(event.pointer_id());
        }
    }
    pub fn release(event: &web_sys::PointerEvent) {
        if let Some(target) = event
            .target()
            .and_then(|target| target.dyn_into::<web_sys::Element>().ok())
            && target.has_pointer_capture(event.pointer_id())
        {
            let _ = target.release_pointer_capture(event.pointer_id());
        }
    }
}
