//! Shared public shell for the Arena document. DOM/CSS and API contracts mirror
//! the existing React components; browser work is compiled only for hydration.
use crate::i18n::Lang;
use leptos::prelude::*;

// Public project destinations mirror lib/support.ts until shared public
// metadata replaces the TypeScript constants for the remaining legacy pages.
const GITHUB: &str = "https://github.com/Namsr/tarkov-stats";
const DISCORD: &str = "https://discord.gg/aKqG9JgC2X";

#[derive(Clone, Debug)]
struct User {
    name: String,
    email: String,
    picture: String,
}

#[component]
pub fn SiteShell(lang: RwSignal<Lang>, children: Children) -> impl IntoView {
    let menu = RwSignal::new(false);
    let light = RwSignal::new(false);
    let user = RwSignal::new(None::<User>);
    let auth_loading = RwSignal::new(true);
    let logging_out = RwSignal::new(false);
    let unseen = RwSignal::new(false);
    let faq = RwSignal::new(0_u8); // closed / open / closing
    let question = RwSignal::new(None::<usize>);
    #[cfg(feature = "hydrate")]
    {
        let runtime = StoredValue::new_local(None::<browser::Runtime>);
        Effect::new(move |_| {
            runtime.set_value(Some(browser::Runtime::start(
                menu,
                light,
                user,
                auth_loading,
                unseen,
                faq,
            )))
        });
        Effect::new(move |_| {
            let open = faq.get() == 1;
            runtime.update_value(|runtime| {
                if let Some(runtime) = runtime {
                    runtime.set_modal(open);
                }
            });
        });
        on_cleanup(move || {
            runtime.update_value(|value| {
                value.take();
            })
        });
    }
    let nav=[("/leaderboard","nav.leaderboard",false),("/axis-league","axis.title",false),("/about","nav.about",false),("/support","nav.support",true),("/community","nav.community",false)].into_iter().map(move |(href,key,support)|view!{
        <a href=href class=if support {"tactical-nav-link tactical-nav-link--support"} else {"tactical-nav-link"} on:click=move |_|menu.set(false)>
            {move || lang.get().t(key)}
            {move || (support&&unseen.get()).then(||view!{<span class="tactical-nav-link__dot" role="img" aria-label=move ||lang.get().t("nav.supportUnread")></span>})}
        </a>
    }).collect_view();
    let languages=[Lang::En,Lang::Ru].into_iter().map(move |target|view!{
        <button type="button" on:click=move |_|{
            lang.set(target);
            #[cfg(feature="hydrate")] browser::language(target);
        } aria-pressed=move ||(lang.get()==target).to_string()
            class=move ||format!("h-11 min-w-11 px-2 font-semibold uppercase transition-colors {}",if lang.get()==target {"bg-[var(--accent)] text-[var(--background)]"} else {"text-[var(--muted)] hover:text-[var(--foreground)]"})>
            {target.as_str()}
        </button>
    }).collect_view();
    view! {
        <a class="skip-link" href="#main-content">{move ||lang.get().t("nav.skip")}</a>
        <header class="site-header"><div class="site-header__inner">
            <a href="/" class="site-mark" on:click=move |_|menu.set(false)><span>{"TARKOV"}</span><span>{"STATS"}</span></a>
            <button type="button" class="site-header__menu" aria-label=move ||lang.get().t(if menu.get(){"nav.closeMenu"}else{"nav.menu"}) aria-expanded=move ||menu.get().to_string() on:click=move |_|menu.update(|open|*open = !*open)><span aria-hidden="true">{move ||if menu.get(){"×"}else{"≡"}}</span></button>
            <div class=move ||format!("site-header__controls{}",if menu.get(){" is-open"}else{""})>
                <nav class="site-header__nav" aria-label=move ||lang.get().t("nav.primary")>
                    <a href="/compare" class="tactical-nav-link" on:click=move |_|menu.set(false)>{move ||lang.get().t("nav.compare")}</a>{nav}
                </nav>
                <div class="site-header__utilities">
                    <Auth lang user loading=auth_loading logging_out/>
                    <button id="rust-theme-toggle" type="button" class="theme-toggle" aria-label=move ||lang.get().t(if light.get(){"theme.toDark"}else{"theme.toLight"}) title=move ||lang.get().t(if light.get(){"theme.toDark"}else{"theme.toLight"}) on:click=move |_|{
                        light.update(|value|*value = !*value);
                        #[cfg(feature="hydrate")] browser::theme(light.get_untracked(),true);
                    }><svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        {move || if light.get(){view!{<path d="M20.8 13.1A9 9 0 0 1 10.9 3.2a9 9 0 1 0 9.9 9.9Z"/>}.into_any()}else{view!{<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>}.into_any()}}
                    </svg></button>
                    <div role="group" aria-label=move ||lang.get().t("nav.language") class="flex min-h-11 items-center overflow-hidden rounded-full border border-[var(--card-border)] text-xs">{languages}</div>
                </div>
            </div>
        </div></header>
        <div id="main-content" class="site-main" tabindex="-1">{children()}</div>
        <footer class="site-footer"><div class="site-footer__inner">
            <p>{"Tarkov Stats"}{" — "}{move ||lang.get().t("footer.independent")}{" "}<a href="/about">{"Namsr"}</a></p>
            <nav aria-label=move ||lang.get().t("footer.navigation")>
                <a href="/about">{move ||lang.get().t("nav.about")}</a><a href="/support">{move ||lang.get().t("nav.support")}</a><a href="/community">{move ||lang.get().t("nav.community")}</a>
                <a href=GITHUB target="_blank" rel="noopener noreferrer">{"GitHub"}</a><a href=DISCORD target="_blank" rel="noopener noreferrer">{"Discord"}</a>
            </nav>
        </div></footer>
        <Faq lang state=faq question/>
    }
}

#[component]
fn Auth(
    lang: RwSignal<Lang>,
    user: RwSignal<Option<User>>,
    loading: RwSignal<bool>,
    logging_out: RwSignal<bool>,
) -> impl IntoView {
    move || {
        if loading.get() {
            view!{<div class="h-11 w-24 skeleton rounded-full" aria-hidden="true"></div><span class="sr-only" role="status">{move ||lang.get().t("common.loading")}</span>}.into_any()
        } else if let Some(user) = user.get() {
            let initial = user
                .name
                .chars()
                .next()
                .or_else(|| user.email.chars().next())
                .unwrap_or('?')
                .to_uppercase()
                .to_string();
            let name = if user.name.is_empty() {
                user.email
            } else {
                user.name
            };
            view!{<div class="flex items-center gap-3">
            <a href="/profile" title=move ||lang.get().t("nav.profile") class="flex min-h-11 min-w-0 items-center gap-2 transition-opacity hover:opacity-80">
                {if user.picture.is_empty(){view!{<div class="h-8 w-8 rounded-full bg-[var(--accent)] text-[var(--background)] flex items-center justify-center text-sm font-bold">{initial}</div>}.into_any()}else{view!{<img src=user.picture alt="" width="28" height="28" class="rounded-full border border-[var(--card-border)]" referrerpolicy="no-referrer"/>}.into_any()}}
                <span class="text-sm hidden lg:inline max-w-32 truncate text-gray-300">{name}</span>
            </a>
            <button disabled=move ||logging_out.get() class="min-h-11 text-xs text-[var(--muted)] transition-colors hover:text-[var(--danger)] disabled:opacity-50" on:click=move |_|{
                logging_out.set(true);
                #[cfg(feature="hydrate")] browser::logout(logging_out);
            }>{move ||if logging_out.get(){"...".into()}else{lang.get().t("auth.logout")}}</button>
        </div>}.into_any()
        } else {
            view!{<a href="/api/auth/google" class="tactical-control gap-2"><GoogleIcon/>{move ||lang.get().t("auth.signIn")}</a>}.into_any()
        }
    }
}
#[component]
fn GoogleIcon() -> impl IntoView {
    view! {<svg width="14" height="14" viewBox="0 0 48 48" aria-hidden="true">
        <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3c-1.6 4.7-6.1 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.6 6.1 29.6 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.3-.4-3.5z"/>
        <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 18.9 12 24 12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.6 6.1 29.6 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/>
        <path fill="#4CAF50" d="M24 44c5.5 0 10.5-2.1 14.3-5.6l-6.6-5.6C29.6 34.6 26.9 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/>
        <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.6 5.6C41.4 36.4 44 30.7 44 24c0-1.3-.1-2.3-.4-3.5z"/>
    </svg>}
}
#[component]
fn Faq(
    lang: RwSignal<Lang>,
    state: RwSignal<u8>,
    question: RwSignal<Option<usize>>,
) -> impl IntoView {
    view! {<div id="rust-faq-root">
        {move || (state.get()!=0).then(move ||view!{
            <div class=move ||format!("faq-backdrop{}",if state.get()==2 {" is-closing"}else{""}) on:mousedown=move |_|close_faq(state) on:animationend=move |event|{
                if event.target()==event.current_target() && state.get_untracked()==2 {state.set(0);#[cfg(feature="hydrate")] browser::return_faq_focus();}
            }>
                <div id="rust-faq-dialog" role="dialog" aria-modal="true" aria-label=move ||lang.get().t("faq.title") tabindex="-1" class="faq-dialog" on:mousedown=move |event|event.stop_propagation()>
                    <div class="flex items-center justify-between px-5 py-4 border-b border-[var(--card-border)]"><h2 class="section-heading text-base text-[var(--accent)]">{move ||lang.get().t("faq.title")}</h2>
                        <button type="button" on:click=move |_|close_faq(state) aria-label=move ||lang.get().t("common.close") class="grid h-10 w-10 place-items-center rounded-full border border-[var(--card-border)] text-xl text-[var(--muted)] hover:border-[var(--accent)] hover:text-[var(--foreground)]"><span aria-hidden="true">"✕"</span></button>
                    </div>
                    <ul class="max-h-[70vh] overflow-y-auto py-1">{(0..9).map(move |index|view!{
                        <li class="border-b border-[var(--card-border)]/70 last:border-0">
                            <button type="button" on:click=move |_|question.update(|value|*value=if *value==Some(index){None}else{Some(index)}) aria-expanded=move ||(question.get()==Some(index)).to_string() aria-controls=format!("faq-answer-{index}") class="w-full flex items-start gap-3 text-left px-5 py-4 text-sm text-[var(--muted-strong)] hover:text-[var(--foreground)] transition-colors">
                                <span aria-hidden="true" class=move ||format!("text-[var(--accent)] mt-0.5 transition-transform {}",if question.get()==Some(index){"rotate-90"}else{""})>"▸"</span><span class="flex-1">{move ||lang.get().t(&format!("faq.q{}",index+1))}</span>
                            </button>
                            <div id=format!("faq-answer-{index}") aria-hidden=move ||(question.get()!=Some(index)).to_string() inert=move ||question.get()!=Some(index) class=move ||format!("faq-answer{}",if question.get()==Some(index){" is-open"}else{""})>
                                <div class="faq-answer__clip"><div class="faq-answer__content px-5 pb-4 pl-10 text-sm text-[var(--muted)] leading-relaxed">{faq_answer(index,lang,state)}</div></div>
                            </div>
                        </li>
                    }).collect_view()}</ul>
                </div>
            </div>
        })}
        <button id="rust-faq-trigger" type="button" on:click=move |_|state.update(|state|*state=if *state==0 {1}else{2}) aria-label=move ||lang.get().t("faq.ariaOpen") aria-expanded=move ||(state.get()==1).to_string() class="faq-trigger">{move ||lang.get().t("faq.title")}</button>
    </div>}
}
fn close_faq(state: RwSignal<u8>) {
    if state.get_untracked() == 1 {
        state.set(2);
    }
}
fn faq_answer(index: usize, lang: RwSignal<Lang>, state: RwSignal<u8>) -> AnyView {
    const LINK: &str = "text-[var(--accent)] hover:underline";
    match index {
        0=>view!{{move ||lang.get().t("faq.a1.before")}{" "}<a class=LINK href="https://tarkov.dev/players" target="_blank" rel="noopener noreferrer">"tarkov.dev/players"</a>{" "}{move ||lang.get().t("faq.a1.after")}}.into_any(),
        3=>view!{{move ||lang.get().t("faq.a4.before")}{" "}<a class=LINK href="https://tarkov.dev" target="_blank" rel="noopener noreferrer">"tarkov.dev"</a>{move ||lang.get().t("faq.a4.after")}}.into_any(),
        4|7|8=>{
            let (key,href,label)=match index {4=>("faq.a5.short","/about","nav.about"),7=>("faq.a8.short","/support","nav.support"),_=>("faq.a9.short","/community","nav.community")};
            view!{{move ||lang.get().t(key)}{" "}<a class=LINK href=href on:click=move |_|{#[cfg(feature="hydrate")] browser::mark_faq_navigation();close_faq(state);}>{move ||lang.get().t(label)}</a>{"."}}.into_any()
        }
        _=>view!{{move ||lang.get().t(&format!("faq.a{}",index+1))}}.into_any(),
    }
}

#[cfg(any(feature = "hydrate", test))]
fn browser_page(path: &str) -> Option<String> {
    let parts = path.split('/').collect::<Vec<_>>();
    if parts.first() != Some(&"") {
        return None;
    }
    if parts.get(1) == Some(&"player") {
        if parts.len() == 4
            && ["regular", "pve", "arena", "pvp-season"].contains(&parts[2])
            && !parts[3].is_empty()
        {
            return Some(format!("/player/{}/:account", parts[2]));
        }
        if parts.len() == 3 && !parts[2].is_empty() {
            return Some("/player/:account".into());
        }
    }
    if parts.len() == 3
        && ["population", "average"].contains(&parts[1])
        && ["regular", "pve", "arena", "pvp-season"].contains(&parts[2])
    {
        return Some(path.into());
    }
    ["/", "/population", "/average", "/leaderboard", "/compare"]
        .contains(&path)
        .then(|| path.into())
}
#[cfg(any(feature = "hydrate", test))]
fn endpoint(path: &str) -> Option<&'static str> {
    if path == "/api/player/risk" {
        return Some("risk");
    }
    if [
        "/api/average/cohort",
        "/api/average/cohort/batch",
        "/api/seasonal/cohort",
        "/api/seasonal/cohort/batch",
    ]
    .contains(&path)
    {
        return Some("cohort");
    }
    if ["/api/average", "/api/seasonal/average"].contains(&path) {
        return Some("average");
    }
    for (prefix, name) in [
        ("/api/baseline", "baseline"),
        ("/api/progression", "progression"),
        ("/api/seasonal/progression", "progression"),
        ("/api/leaderboard", "leaderboard"),
        ("/api/compare", "comparison"),
    ] {
        if path == prefix || path.starts_with(&format!("{prefix}/")) {
            return Some(name);
        }
    }
    if path == "/api/player/search" {
        return Some("search");
    }
    let tail = path
        .strip_prefix("/api/player/")
        .or_else(|| path.strip_prefix("/api/seasonal/player/"));
    tail.filter(|tail| !tail.is_empty() && !tail.contains('/'))
        .map(|_| "profile")
}

#[cfg(feature = "hydrate")]
mod browser {
    use super::*;
    use js_sys::{Array, Function, Reflect};
    use serde::Serialize;
    use serde_json::{Value, json};
    use std::{
        cell::{Cell, RefCell},
        collections::VecDeque,
        rc::Rc,
    };
    use wasm_bindgen::{JsCast, JsValue, closure::Closure};
    use wasm_bindgen_futures::{JsFuture, spawn_local};
    use web_sys::*;

    thread_local! {
        static NAV_PENDING:Cell<bool>=const {Cell::new(false)};
        static FAQ_NAVIGATING:Cell<bool>=const {Cell::new(false)};
    }
    fn window() -> Window {
        web_sys::window().expect("browser window")
    }
    fn document() -> Document {
        window().document().expect("browser document")
    }
    fn storage() -> Option<web_sys::Storage> {
        window().local_storage().ok().flatten()
    }
    fn focus(id: &str) {
        if let Some(element) = document()
            .get_element_by_id(id)
            .and_then(|v| v.dyn_into::<HtmlElement>().ok())
        {
            let _ = element.focus();
        }
    }
    pub fn language(lang: Lang) {
        if let Some(root) = document().document_element() {
            let _ = root.set_attribute("lang", lang.as_str());
        }
        if let Ok(doc) = document().dyn_into::<HtmlDocument>() {
            let _ = doc.set_cookie(&format!(
                "lang={}; path=/; max-age=31536000; SameSite=Lax",
                lang.as_str()
            ));
        }
        document().set_title(&lang.t("meta.title"));
        if let Ok(Some(meta)) = document().query_selector("meta[name=description]") {
            let _ = meta.set_attribute("content", &lang.t("meta.description"));
        }
    }
    pub fn theme(light: bool, save: bool) {
        let value = if light { "light" } else { "dark" };
        if let Some(root) = document().document_element() {
            let _ = root.set_attribute("data-theme", value);
        }
        if save && let Some(storage) = storage() {
            let _ = storage.set_item("tarkov-stats-theme", value);
        }
    }
    pub fn logout(logging_out: RwSignal<bool>) {
        spawn_local(async move {
            let options = RequestInit::new();
            options.set_method("POST");
            options.set_credentials(RequestCredentials::SameOrigin);
            let result = match Request::new_with_str_and_init("/api/auth/logout", &options) {
                Ok(request) => JsFuture::from(window().fetch_with_request(&request)).await,
                Err(e) => Err(e),
            };
            if result.is_ok() {
                let _ = window().location().reload();
            } else {
                let _ = logging_out.try_set(false);
            }
        });
    }
    pub fn mark_faq_navigation() {
        FAQ_NAVIGATING.with(|value| value.set(true));
    }
    pub fn return_faq_focus() {
        if !FAQ_NAVIGATING.with(Cell::get) {
            focus("rust-faq-trigger");
        }
    }

    struct Listener {
        target: EventTarget,
        name: &'static str,
        callback: Closure<dyn FnMut(Event)>,
    }
    impl Listener {
        fn new(
            target: EventTarget,
            name: &'static str,
            callback: impl FnMut(Event) + 'static,
        ) -> Self {
            let callback = Closure::<dyn FnMut(Event)>::new(callback);
            let _ =
                target.add_event_listener_with_callback(name, callback.as_ref().unchecked_ref());
            Self {
                target,
                name,
                callback,
            }
        }
    }
    impl Drop for Listener {
        fn drop(&mut self) {
            let _ = self.target.remove_event_listener_with_callback(
                self.name,
                self.callback.as_ref().unchecked_ref(),
            );
        }
    }
    type ObserverCallback = Closure<dyn FnMut(PerformanceObserverEntryList, PerformanceObserver)>;
    struct Observed {
        kind: &'static str,
        observer: PerformanceObserver,
        _callback: ObserverCallback,
    }
    pub struct Runtime {
        _listeners: Vec<Listener>,
        observers: Rc<RefCell<Vec<Observed>>>,
        timer: Option<i32>,
        _timer_callback: Closure<dyn FnMut()>,
        active: Rc<Cell<bool>>,
        request: Option<AbortController>,
        inert: Vec<(HtmlElement, bool)>,
    }
    impl Runtime {
        pub fn start(
            menu: RwSignal<bool>,
            light: RwSignal<bool>,
            user: RwSignal<Option<User>>,
            auth_loading: RwSignal<bool>,
            unseen: RwSignal<bool>,
            faq: RwSignal<u8>,
        ) -> Self {
            NAV_PENDING.with(|value| value.set(false));
            let active = Rc::new(Cell::new(true));
            let request = AbortController::new().ok();
            let saved_light = storage()
                .and_then(|s| s.get_item("tarkov-stats-theme").ok().flatten())
                .as_deref()
                == Some("light");
            light.set(saved_light);
            theme(saved_light, false);
            let signal = request.as_ref().map(AbortController::signal);
            let alive = active.clone();
            let auth_signal = signal.clone();
            spawn_local(async move {
                if let Ok((_, value)) =
                    fetch_json("/api/auth/me", auth_signal.as_ref(), false).await
                    && alive.get()
                {
                    let next = value.get("user").filter(|u| u.is_object()).map(|u| User {
                        name: u["name"].as_str().unwrap_or("").into(),
                        email: u["email"].as_str().unwrap_or("").into(),
                        picture: u["picture"].as_str().unwrap_or("").into(),
                    });
                    let _ = user.try_set(next);
                }
                if alive.get() {
                    let _ = auth_loading.try_set(false);
                }
            });
            let alive = active.clone();
            spawn_local(async move {
                if let Ok((true, value)) = fetch_json("/api/support", signal.as_ref(), true).await
                    && alive.get()
                {
                    let _ = unseen.try_set(support_unseen(&value));
                }
            });
            pageview();
            cloudflare_beacon();
            let mut listeners = Vec::new();
            listeners.push(Listener::new(document().into(), "keydown", move |event| {
                let Ok(event) = event.dyn_into::<KeyboardEvent>() else {
                    return;
                };
                if event.key() == "Escape" {
                    let _ = menu.try_set(false);
                    if faq.get_untracked() == 1 {
                        event.prevent_default();
                        let _ = faq.try_set(2);
                    }
                } else if event.key() == "Tab" && faq.get_untracked() == 1 {
                    trap_tab(&event);
                }
            }));
            listeners.push(Listener::new(document().into(), "click", navigation));
            listeners.push(Listener::new(window().into(), "pageshow", move |_| {
                NAV_PENDING.with(|v| v.set(false))
            }));
            let observers = Rc::new(RefCell::new(Vec::new()));
            let telemetry = Rc::new(RefCell::new(Telemetry::new()));
            let enabled =
                !dnt() && canonical_host(&window().location().hostname().unwrap_or_default());
            if enabled {
                if let Some(performance) = window().performance() {
                    telemetry
                        .borrow_mut()
                        .metric("client_ready", performance.now(), None);
                }
                for kind in ["paint", "largest-contentful-paint", "longtask", "resource"] {
                    if let Some(observer) = observe(kind, telemetry.clone()) {
                        observers.borrow_mut().push(observer);
                    }
                }
                let data = telemetry.clone();
                let obs = observers.clone();
                listeners.push(Listener::new(
                    document().into(),
                    "visibilitychange",
                    move |_| {
                        if document().visibility_state() == VisibilityState::Hidden {
                            flush(&data, &obs, true);
                        }
                    },
                ));
                let data = telemetry.clone();
                let obs = observers.clone();
                listeners.push(Listener::new(window().into(), "pagehide", move |_| {
                    flush(&data, &obs, true)
                }));
            }
            let timer_observers = observers.clone();
            let callback = Closure::<dyn FnMut()>::new(move || {
                if enabled {
                    flush(&telemetry, &timer_observers, false);
                }
            });
            let timer = if enabled {
                window()
                    .set_interval_with_callback_and_timeout_and_arguments_0(
                        callback.as_ref().unchecked_ref(),
                        15000,
                    )
                    .ok()
            } else {
                None
            };
            Self {
                _listeners: listeners,
                observers,
                timer,
                _timer_callback: callback,
                active,
                request,
                inert: Vec::new(),
            }
        }
        pub fn set_modal(&mut self, open: bool) {
            if !open {
                self.restore_inert();
                return;
            }
            if !self.inert.is_empty() {
                return;
            }
            FAQ_NAVIGATING.with(|value| value.set(false));
            let Some(mut branch) = document().get_element_by_id("rust-faq-root") else {
                return;
            };
            while let Some(parent) = branch.parent_element() {
                let siblings = parent.children();
                for index in 0..siblings.length() {
                    if let Some(element) = siblings.item(index)
                        && element != branch
                        && let Ok(html) = element.dyn_into::<HtmlElement>()
                    {
                        let old = html.inert();
                        html.set_inert(true);
                        self.inert.push((html, old));
                    }
                }
                if parent.tag_name() == "BODY" {
                    break;
                }
                branch = parent;
            }
            focus("rust-faq-dialog");
        }
        fn restore_inert(&mut self) {
            for (element, old) in self.inert.drain(..) {
                element.set_inert(old);
            }
        }
    }
    impl Drop for Runtime {
        fn drop(&mut self) {
            self.active.set(false);
            if let Some(request) = &self.request {
                request.abort();
            }
            if let Some(timer) = self.timer {
                window().clear_interval_with_handle(timer);
            }
            for item in self.observers.borrow_mut().drain(..) {
                item.observer.disconnect();
            }
            self.restore_inert();
        }
    }
    async fn fetch_json(
        url: &str,
        signal: Option<&AbortSignal>,
        no_store: bool,
    ) -> Result<(bool, Value), JsValue> {
        let options = RequestInit::new();
        options.set_credentials(RequestCredentials::SameOrigin);
        options.set_signal(signal);
        if no_store {
            options.set_cache(RequestCache::NoStore);
        }
        let request = Request::new_with_str_and_init(url, &options)?;
        let response = JsFuture::from(window().fetch_with_request(&request))
            .await?
            .dyn_into::<Response>()?;
        let ok = response.ok();
        let text = JsFuture::from(response.text()?)
            .await?
            .as_string()
            .ok_or_else(|| JsValue::from_str("Invalid response"))?;
        let value = serde_json::from_str(&text).map_err(|_| JsValue::from_str("Invalid JSON"))?;
        Ok((ok, value))
    }
    fn support_unseen(value: &Value) -> bool {
        const KEY: &str = "tarkov-stats-support-notifications-seen";
        let mut seen = storage()
            .and_then(|s| s.get_item(KEY).ok().flatten())
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .and_then(|v| v.as_array().cloned())
            .unwrap_or_default()
            .into_iter()
            .filter_map(|id| id.as_f64())
            .filter(|n| n.is_finite() && *n > 0.0 && *n <= 9007199254740991.0 && n.fract() == 0.0)
            .map(|n| n as u64)
            .collect::<Vec<_>>();
        let active = value["notifications"]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| match &item["id"] {
                        Value::Number(n) => n.as_f64(),
                        Value::String(s) => crate::state::number(s),
                        _ => None,
                    })
                    .filter(|n| {
                        n.is_finite() && *n > 0.0 && *n <= 9007199254740991.0 && n.fract() == 0.0
                    })
                    .map(|n| n as u64)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        if window().location().pathname().unwrap_or_default() == "/support" && !active.is_empty() {
            for id in active {
                if !seen.contains(&id) {
                    seen.push(id);
                }
            }
            let start = seen.len().saturating_sub(200);
            if let Some(storage) = storage() {
                let _ = storage.set_item(
                    KEY,
                    &serde_json::to_string(&seen[start..]).unwrap_or_default(),
                );
            }
            false
        } else {
            active.iter().any(|id| !seen.contains(id))
        }
    }
    fn trap_tab(event: &KeyboardEvent) {
        let Some(dialog) = document().get_element_by_id("rust-faq-dialog") else {
            return;
        };
        let Ok(nodes) =
            dialog.query_selector_all("a[href],button,input,select,textarea,[tabindex]")
        else {
            return;
        };
        let mut items = Vec::new();
        for index in 0..nodes.length() {
            if let Some(node) = nodes.item(index)
                && let Ok(element) = node.dyn_into::<HtmlElement>()
                && !element.has_attribute("disabled")
                && element.get_attribute("tabindex").as_deref() != Some("-1")
                && element.closest("[inert],[hidden]").ok().flatten().is_none()
            {
                items.push(element);
            }
        }
        let Some(first) = items.first() else {
            event.prevent_default();
            focus("rust-faq-dialog");
            return;
        };
        let last = items.last().unwrap();
        let active = document().active_element();
        let at_start = active.as_ref() == Some(first.as_ref())
            || active.as_ref() == Some(&dialog)
            || active.as_ref().is_none_or(|v| !dialog.contains(Some(v)));
        let at_end = active.as_ref() == Some(last.as_ref());
        if event.shift_key() && at_start {
            event.prevent_default();
            let _ = last.focus();
        } else if !event.shift_key()
            && (at_end
                || active.as_ref() == Some(&dialog)
                || active.as_ref().is_none_or(|v| !dialog.contains(Some(v))))
        {
            event.prevent_default();
            let _ = first.focus();
        }
    }
    fn navigation(event: Event) {
        let Ok(event) = event.dyn_into::<MouseEvent>() else {
            return;
        };
        if event.default_prevented()
            || event.button() != 0
            || event.meta_key()
            || event.ctrl_key()
            || event.alt_key()
            || event.shift_key()
        {
            return;
        }
        let link = event
            .target()
            .and_then(|target| target.dyn_into::<Element>().ok())
            .and_then(|element| element.closest("a[href]").ok().flatten())
            .and_then(|element| element.dyn_into::<HtmlAnchorElement>().ok());
        let Some(link) = link else { return };
        if link.has_attribute("download") || !["", "_self"].contains(&link.target().as_str()) {
            return;
        }
        let Ok(target) = url::Url::parse(&link.href()) else {
            return;
        };
        let location = window().location();
        let Ok(current) = location
            .href()
            .ok()
            .and_then(|v| url::Url::parse(&v).ok())
            .ok_or(())
        else {
            return;
        };
        if target.origin() != current.origin() {
            return;
        }
        let pending = NAV_PENDING.with(Cell::get);
        if link.get_attribute("aria-current").as_deref() == Some("page")
            && target.path() == current.path()
            && !pending
        {
            event.prevent_default();
            NAV_PENDING.with(|v| v.set(true));
            if let Ok(history) = window().history() {
                if history.length().unwrap_or(0) > 1 {
                    let _ = history.back();
                } else {
                    let _ = location.replace("/");
                }
            }
        } else if target.path() != current.path() || target.query() != current.query() {
            NAV_PENDING.with(|v| v.set(true));
        }
    }
    fn visitor_id() -> Option<String> {
        let storage = storage()?;
        if let Ok(Some(value)) = storage.get_item("ts_visitor_id")
            && (8..=64).contains(&value.len())
            && value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        {
            return Some(value);
        }
        let crypto = window().crypto().ok()?;
        let random_uuid = Reflect::get(crypto.as_ref(), &JsValue::from_str("randomUUID"))
            .ok()
            .and_then(|v| v.dyn_into::<Function>().ok())
            .and_then(|f| f.call0(crypto.as_ref()).ok())
            .and_then(|v| v.as_string());
        let value = random_uuid.or_else(|| {
            let mut bytes = [0; 16];
            crypto.get_random_values_with_u8_array(&mut bytes).ok()?;
            Some(bytes.iter().map(|b| format!("{b:02x}")).collect())
        })?;
        storage.set_item("ts_visitor_id", &value).ok()?;
        Some(value)
    }
    fn pageview() {
        let path = window().location().pathname().unwrap_or_default();
        if path.is_empty() || path == "/admin" || path.starts_with("/admin/") || dnt() {
            return;
        }
        let Some(visitor) = visitor_id() else { return };
        let referrer = url::Url::parse(&document().referrer())
            .ok()
            .filter(|url| {
                let host = url.host_str().map(|host| {
                    url.port()
                        .map_or_else(|| host.to_string(), |port| format!("{host}:{port}"))
                });
                host.as_deref() != window().location().host().ok().as_deref()
            })
            .and_then(|url| url.host_str().map(|s| s.to_lowercase()));
        send(
            "/api/pageview",
            &json!({"path":path,"visitor":visitor,"referrer":referrer}).to_string(),
        );
    }
    fn dnt() -> bool {
        Reflect::get(
            window().navigator().as_ref(),
            &JsValue::from_str("doNotTrack"),
        )
        .ok()
        .and_then(|v| v.as_string())
        .as_deref()
            == Some("1")
    }
    fn canonical_host(host: &str) -> bool {
        matches!(
            host,
            "tarkovstats.ru"
                | "www.tarkovstats.ru"
                | "tarkovstats.online"
                | "www.tarkovstats.online"
        )
    }
    fn cloudflare_beacon() {
        let host = window().location().hostname().unwrap_or_default();
        let token = match host.as_str() {
            "tarkovstats.ru" | "www.tarkovstats.ru" => "3b0a180bb0d94635af5a11156c923676",
            "tarkovstats.online" | "www.tarkovstats.online" => "f7051c60efbf4d67985f5ae11292f196",
            _ => return,
        };
        if document()
            .get_element_by_id("cloudflare-web-analytics")
            .is_some()
        {
            return;
        }
        let Ok(script) = document()
            .create_element("script")
            .and_then(|s| s.dyn_into::<HtmlScriptElement>().map_err(Into::into))
        else {
            return;
        };
        script.set_id("cloudflare-web-analytics");
        script.set_type("module");
        script.set_src("https://static.cloudflareinsights.com/beacon.min.js");
        let _ = script.set_attribute("data-cf-beacon", &json!({"token":token}).to_string());
        if let Some(body) = document().body() {
            let _ = body.append_child(&script);
        }
    }
    fn send(endpoint: &str, payload: &str) {
        let parts = Array::new();
        parts.push(&JsValue::from_str(payload));
        let options = BlobPropertyBag::new();
        options.set_type("application/json");
        if let Ok(blob) = Blob::new_with_str_sequence_and_options(parts.as_ref(), &options)
            && window()
                .navigator()
                .send_beacon_with_opt_blob(endpoint, Some(&blob))
                .unwrap_or(false)
        {
            return;
        }
        let options = RequestInit::new();
        options.set_method("POST");
        options.set_credentials(RequestCredentials::SameOrigin);
        options.set_body(&JsValue::from_str(payload));
        let _ = Reflect::set(
            options.as_ref(),
            &JsValue::from_str("keepalive"),
            &JsValue::TRUE,
        );
        if let Ok(request) = Request::new_with_str_and_init(endpoint, &options) {
            let _ = request.headers().set("Content-Type", "application/json");
            spawn_local(async move {
                let _ = JsFuture::from(window().fetch_with_request(&request)).await;
            });
        }
    }

    #[derive(Clone, Serialize)]
    struct Sample {
        metric: &'static str,
        value: f64,
        endpoint: Option<&'static str>,
    }
    struct Telemetry {
        initial: Option<String>,
        pending: Vec<(String, VecDeque<Sample>)>,
        queued: usize,
        captured: usize,
        lcp: Option<f64>,
        lcp_sent: bool,
        navigation_sent: bool,
        batches: usize,
        window_started: f64,
    }
    impl Telemetry {
        fn new() -> Self {
            Self {
                initial: browser_page(&window().location().pathname().unwrap_or_default()),
                pending: Vec::new(),
                queued: 0,
                captured: 0,
                lcp: None,
                lcp_sent: false,
                navigation_sent: false,
                batches: 0,
                window_started: window().performance().map_or(0.0, |p| p.now()),
            }
        }
        fn add(&mut self, sample: Sample, path: Option<String>) {
            let path =
                path.or_else(|| browser_page(&window().location().pathname().unwrap_or_default()));
            let essential = !sample.metric.starts_with("api_") && sample.metric != "long_task";
            if path.is_none()
                || self.queued >= if essential { 100 } else { 80 }
                || self.captured >= if essential { 400 } else { 380 }
                || !sample.value.is_finite()
                || !(0.0..=300000.0).contains(&sample.value)
            {
                return;
            }
            let path = path.unwrap();
            let index = self
                .pending
                .iter()
                .position(|(p, _)| p == &path)
                .unwrap_or_else(|| {
                    self.pending.push((path, VecDeque::new()));
                    self.pending.len() - 1
                });
            self.pending[index].1.push_back(sample);
            self.queued += 1;
            self.captured += 1;
        }
        fn metric(&mut self, name: &'static str, value: f64, path: Option<String>) {
            let path = path.or_else(|| self.initial.clone());
            self.add(
                Sample {
                    metric: name,
                    value,
                    endpoint: None,
                },
                path,
            );
        }
        fn navigation(&mut self) {
            if self.navigation_sent || self.initial.is_none() {
                return;
            }
            let Some(performance) = window().performance() else {
                return;
            };
            let Some(entry) = performance
                .get_entries_by_type("navigation")
                .get(0)
                .dyn_into::<PerformanceNavigationTiming>()
                .ok()
            else {
                return;
            };
            if entry.load_event_end() <= 0.0 {
                return;
            }
            self.navigation_sent = true;
            for (name, value) in [
                ("ttfb", entry.response_start() - entry.start_time()),
                (
                    "dns",
                    entry.domain_lookup_end() - entry.domain_lookup_start(),
                ),
                ("connect", entry.connect_end() - entry.connect_start()),
                ("download", entry.response_end() - entry.response_start()),
                (
                    "dom_interactive",
                    entry.dom_interactive() - entry.start_time(),
                ),
                ("load", entry.load_event_end() - entry.start_time()),
            ] {
                self.metric(name, value, None);
            }
            if entry.secure_connection_start() > 0.0 {
                self.metric(
                    "tls",
                    entry.connect_end() - entry.secure_connection_start(),
                    None,
                );
            }
        }
        fn flush(&mut self, final_flush: bool) {
            self.navigation();
            if final_flush
                && !self.lcp_sent
                && let Some(value) = self.lcp
            {
                self.metric("lcp", value, None);
                self.lcp_sent = true;
            }
            let now = window().performance().map_or(0.0, |p| p.now());
            if now - self.window_started >= 60000.0 {
                self.batches = 0;
                self.window_started = now;
            }
            for (path, samples) in &mut self.pending {
                while !samples.is_empty() && self.batches < 5 {
                    let batch = samples.drain(..samples.len().min(20)).collect::<Vec<_>>();
                    self.queued -= batch.len();
                    self.batches += 1;
                    send(
                        "/api/performance",
                        &json!({"path":path,"samples":batch}).to_string(),
                    );
                }
            }
            self.pending.retain(|(_, samples)| !samples.is_empty());
        }
    }
    fn observe(kind: &'static str, data: Rc<RefCell<Telemetry>>) -> Option<Observed> {
        let constructor =
            Reflect::get(window().as_ref(), &JsValue::from_str("PerformanceObserver")).ok()?;
        if constructor.is_undefined() {
            return None;
        }
        let supported = Reflect::get(&constructor, &JsValue::from_str("supportedEntryTypes"))
            .ok()?
            .dyn_into::<Array>()
            .ok()?;
        if !supported
            .iter()
            .any(|v| v.as_string().as_deref() == Some(kind))
        {
            return None;
        }
        let callback = Closure::<dyn FnMut(PerformanceObserverEntryList, PerformanceObserver)>::new(
            move |list: PerformanceObserverEntryList, _| {
                process_entries(kind, list.get_entries(), &data)
            },
        );
        let observer = PerformanceObserver::new(callback.as_ref().unchecked_ref()).ok()?;
        let options: PerformanceObserverInit = js_sys::Object::new().unchecked_into();
        options.set_buffered(true);
        let _ = Reflect::set(
            options.as_ref(),
            &JsValue::from_str("type"),
            &JsValue::from_str(kind),
        );
        // Typed observe() lacks a catch binding. call1 catches browsers which
        // expose the type but reject buffered/single-type observation.
        Reflect::get(observer.as_ref(), &JsValue::from_str("observe"))
            .ok()?
            .dyn_into::<Function>()
            .ok()?
            .call1(observer.as_ref(), options.as_ref())
            .ok()?;
        Some(Observed {
            kind,
            observer,
            _callback: callback,
        })
    }
    fn process_entries(kind: &str, entries: Array, data: &Rc<RefCell<Telemetry>>) {
        for value in entries.iter() {
            let Ok(entry) = value.clone().dyn_into::<PerformanceEntry>() else {
                continue;
            };
            match kind {
                "paint" => {
                    if entry.name() == "first-contentful-paint" {
                        data.borrow_mut().metric("fcp", entry.start_time(), None);
                    }
                }
                "largest-contentful-paint" => data.borrow_mut().lcp = Some(entry.start_time()),
                "longtask" => data.borrow_mut().metric(
                    "long_task",
                    entry.duration(),
                    browser_page(&window().location().pathname().unwrap_or_default()),
                ),
                "resource" => {
                    let Ok(resource) = value.dyn_into::<PerformanceResourceTiming>() else {
                        continue;
                    };
                    let Ok(url) = url::Url::parse(&entry.name()) else {
                        continue;
                    };
                    let Some(endpoint) = super::endpoint(url.path()) else {
                        continue;
                    };
                    if url.origin().ascii_serialization()
                        != window().location().origin().unwrap_or_default()
                        || resource.response_end() <= 0.0
                    {
                        continue;
                    }
                    let mut data = data.borrow_mut();
                    data.add(
                        Sample {
                            metric: "api_total",
                            value: entry.duration(),
                            endpoint: Some(endpoint),
                        },
                        None,
                    );
                    if resource.request_start() > 0.0 && resource.response_start() > 0.0 {
                        data.add(
                            Sample {
                                metric: "api_ttfb",
                                value: resource.response_start() - resource.request_start(),
                                endpoint: Some(endpoint),
                            },
                            None,
                        );
                    }
                    if resource.response_start() > 0.0 {
                        data.add(
                            Sample {
                                metric: "api_download",
                                value: resource.response_end() - resource.response_start(),
                                endpoint: Some(endpoint),
                            },
                            None,
                        );
                    }
                    if let Ok(values) =
                        Reflect::get(resource.as_ref(), &JsValue::from_str("serverTiming"))
                            .and_then(|v| v.dyn_into::<Array>())
                    {
                        for value in values.iter() {
                            if let Ok(server) = value.dyn_into::<PerformanceServerTiming>()
                                && server.name() == "total"
                            {
                                data.add(
                                    Sample {
                                        metric: "api_server",
                                        value: server.duration(),
                                        endpoint: Some(endpoint),
                                    },
                                    None,
                                );
                                break;
                            }
                        }
                    }
                }
                _ => {}
            }
        }
    }
    fn flush(
        data: &Rc<RefCell<Telemetry>>,
        observers: &Rc<RefCell<Vec<Observed>>>,
        final_flush: bool,
    ) {
        if final_flush {
            for observed in observers.borrow().iter() {
                process_entries(observed.kind, observed.observer.take_records(), data);
            }
        }
        data.borrow_mut().flush(final_flush);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(feature = "ssr")]
    #[test]
    fn ssr_keeps_the_real_shared_shell_and_useful_children_in_both_languages() {
        for selected in [Lang::En, Lang::Ru] {
            let owner = Owner::new();
            owner.with(|| {
                let lang = RwSignal::new(selected);
                let html =
                    view! {<SiteShell lang><main><h1>"Arena 42"</h1></main></SiteShell>}.to_html();
                for marker in [
                    "site-header",
                    "site-header__menu",
                    "site-header__utilities",
                    "site-footer",
                    "rust-theme-toggle",
                    "rust-faq-trigger",
                    "id=\"main-content\"",
                    "tabindex=\"-1\"",
                    "/compare",
                ] {
                    assert!(html.contains(marker), "missing shell marker {marker}");
                }
                assert!(html.contains("Arena 42"));
                assert!(html.contains(&selected.t("nav.skip")));
                assert!(html.contains(&selected.t("faq.title")));
                assert!(html.contains(&selected.t("footer.independent")));
                assert!(html.contains("role=\"status\""));
                assert!(html.contains("rel=\"noopener noreferrer\""));
                assert!(!html.contains("/api/auth/me"));
                assert!(!html.contains("/_next/"));
                assert!(!html.contains("role=\"dialog\""));
            });
        }
    }
    #[test]
    fn telemetry_redacts_accounts_and_rejects_private_pages() {
        assert_eq!(
            browser_page("/player/arena/123"),
            Some("/player/arena/:account".into())
        );
        assert_eq!(browser_page("/player/123"), Some("/player/:account".into()));
        assert_eq!(
            browser_page("/population/arena"),
            Some("/population/arena".into())
        );
        for path in [
            "/admin",
            "/profile",
            "/player/arena/1/extra",
            "/population/arena?aid=1",
        ] {
            assert!(browser_page(path).is_none());
        }
        assert_eq!(endpoint("/api/average"), Some("average"));
        assert_eq!(endpoint("/api/seasonal/cohort"), Some("cohort"));
        assert_eq!(endpoint("/api/auth/me"), None);
        assert_eq!(endpoint("/api/favorites"), None);
    }
}
