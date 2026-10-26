use super::{
    data::{InitialReply, PersistentInitial},
    state::PersistentState,
};
use crate::view::client::{Reply, Watch, cancel_prefetch, prefetch, remember};
use leptos::prelude::*;
use serde_json::Value;
use std::{cell::RefCell, rc::Rc};
use wasm_bindgen::{JsCast, closure::Closure};
pub struct Runtime {
    watches: Rc<RefCell<Vec<Option<Watch>>>>,
    window: web_sys::Window,
    pop: Closure<dyn FnMut()>,
}
impl Drop for Runtime {
    fn drop(&mut self) {
        let _ = self
            .window
            .remove_event_listener_with_callback("popstate", self.pop.as_ref().unchecked_ref());
        self.watches.borrow_mut().clear();
        cancel_prefetch();
    }
}
pub fn mount(
    state: RwSignal<PersistentState>,
    replies: [RwSignal<InitialReply>; 5],
    retry: RwSignal<u64>,
    selected_loading: RwSignal<bool>,
    initial: PersistentInitial,
) -> Runtime {
    let watches = Rc::new(RefCell::new(
        (0..5).map(|_| None).collect::<Vec<Option<Watch>>>(),
    ));
    let for_effect = watches.clone();
    let keys = Rc::new(RefCell::new([
        String::new(),
        String::new(),
        String::new(),
        String::new(),
        String::new(),
    ]));
    let seed = Rc::new(RefCell::new(Some(initial)));
    Effect::new(move |_| {
        let current = state.get();
        let attempt = retry.get();
        let urls = current.requests();
        let initial = seed.borrow_mut().take();
        let progression_ready = replies[2]
            .get()
            .body
            .as_ref()
            .is_some_and(|b| super::data::matches(&urls[2], b) == Some(true));
        cancel_prefetch();
        for (i, url) in urls.into_iter().enumerate() {
            if i == 3 && !progression_ready {
                for_effect.borrow_mut()[i].take();
                keys.borrow_mut()[i].clear();
                continue;
            }
            let key = format!("{url}|{}", if i == 4 { attempt } else { 0 });
            if keys.borrow()[i] == key {
                continue;
            }
            for_effect.borrow_mut()[i].take();
            keys.borrow_mut()[i] = key;
            if i == 0 && current.invalid {
                selected_loading.set(false);
                replies[i].set(InitialReply {
                    status: 400,
                    ..Default::default()
                });
                continue;
            }
            let seeded = initial
                .as_ref()
                .map(|initial| initial.replies()[i].clone())
                .filter(InitialReply::has_response)
                .map(|v| Reply {
                    body: v.body.unwrap_or(Value::Null),
                    status: v.status,
                    retry: v.retry_after.clamp(1, 15),
                    stale: v.stale,
                    publication_stale: v.publication_stale,
                    generated: v.generated_at,
                });
            if let Some(value) = &seeded {
                if value.status == 200 && super::data::matches(&url, &value.body) == Some(true) {
                    remember(&url, value.clone());
                }
            } else if i != 0
                || !replies[i].with_untracked(|reply| {
                    reply
                        .body
                        .as_ref()
                        .is_some_and(|body| super::data::matches(&url, body) == Some(true))
                })
            {
                // Range-only requests retain the same portrait identity while
                // loading, as the React currentData guard does. Otherwise the
                // debounce would disable a focused/dragged range control.
                replies[i].set(InitialReply::default());
            }
            if i == 0 {
                selected_loading.set(true);
            }
            let reply_url = url.clone();
            for_effect.borrow_mut()[i] = Some(Watch::with_reply(url, seeded, move |answer| {
                if i == 0 {
                    selected_loading.set(false);
                }
                let reply = match answer {
                    Ok(value) => InitialReply {
                        body: Some(value.body),
                        status: value.status,
                        stale: value.stale,
                        publication_stale: value.publication_stale,
                        retry_after: value.retry,
                        generated_at: value.generated,
                    },
                    Err(_) => InitialReply {
                        // Keep the compatible last value on a range-only
                        // failure, alongside the error, as React does.
                        body: if i == 0 {
                            replies[i].with_untracked(|reply| {
                                reply.body.clone().filter(|body| {
                                    super::data::matches(&reply_url, body) == Some(true)
                                })
                            })
                        } else {
                            None
                        },
                        status: 500,
                        ..Default::default()
                    },
                };
                replies[i].set(reply);
            }));
        }
        let mut other = current.clone();
        other.mode = if current.mode == "pve" {
            "regular"
        } else {
            "pve"
        }
        .into();
        prefetch(vec![other.requests()[1].clone()]);
    });
    let window = web_sys::window().expect("hydration window");
    let pop = Closure::wrap(Box::new(move || {
        if let Some(window) = web_sys::window() {
            let search = window.location().search().unwrap_or_default();
            let mode = state.with_untracked(|s| s.mode.clone());
            if let Ok(next) =
                PersistentState::read(&mode, search.strip_prefix('?').unwrap_or(&search))
            {
                state.set(next);
            }
        }
    }) as Box<dyn FnMut()>);
    let _ = window.add_event_listener_with_callback("popstate", pop.as_ref().unchecked_ref());
    Runtime {
        watches,
        window,
        pop,
    }
}
pub fn history(state: &PersistentState) {
    if let Some(window) = web_sys::window() {
        let hash = window.location().hash().unwrap_or_default();
        let _ = window.history().and_then(|h| {
            h.replace_state_with_url(
                &wasm_bindgen::JsValue::NULL,
                "",
                Some(&(state.href() + &hash)),
            )
        });
    }
}
pub fn hide_image(event: &web_sys::Event) {
    if let Some(element) = event
        .target()
        .and_then(|v| v.dyn_into::<web_sys::Element>().ok())
    {
        let _ = element.set_attribute("style", "visibility:hidden");
    }
}
fn event_point(
    target: Option<web_sys::EventTarget>,
    client_x: i32,
    client_y: i32,
    width: f64,
    height: f64,
) -> Option<(f64, f64)> {
    let element = target?.dyn_into::<web_sys::Element>().ok()?;
    let rect = element.get_bounding_client_rect();
    let scale = (rect.width() / width).min(rect.height() / height);
    if scale <= 0.0 {
        return None;
    }
    Some((
        (f64::from(client_x) - rect.left() - (rect.width() - width * scale) / 2.0) / scale,
        (f64::from(client_y) - rect.top() - (rect.height() - height * scale) / 2.0) / scale,
    ))
}
pub fn pointer_point(event: &web_sys::PointerEvent, width: f64, height: f64) -> Option<(f64, f64)> {
    event_point(
        event.current_target(),
        event.client_x(),
        event.client_y(),
        width,
        height,
    )
}
pub fn mouse_point(event: &web_sys::MouseEvent, width: f64, height: f64) -> Option<(f64, f64)> {
    event_point(
        event.current_target(),
        event.client_x(),
        event.client_y(),
        width,
        height,
    )
}
pub fn chart_focused(event: &web_sys::PointerEvent) -> bool {
    event
        .current_target()
        .and_then(|v| v.dyn_into::<web_sys::Element>().ok())
        .and_then(|v| v.query_selector(":focus-visible").ok().flatten())
        .is_some()
}
pub struct Collapse {
    observer: web_sys::ResizeObserver,
    _callback: Closure<dyn FnMut(js_sys::Array)>,
}
impl Drop for Collapse {
    fn drop(&mut self) {
        self.observer.disconnect();
    }
}
fn measure_collapse(element: &web_sys::Element, expanded: bool) {
    let Some(inner) = element.first_element_child() else {
        return;
    };
    let Ok(nodes) = inner.query_selector_all("tbody > tr, .achievement-card") else {
        return;
    };
    let top = inner.get_bounding_client_rect().top();
    let rows = (0..nodes.length())
        .filter_map(|i| nodes.item(i)?.dyn_into::<web_sys::Element>().ok())
        .filter(|row| {
            let rect = row.get_bounding_client_rect();
            rect.width() > 0.0 || rect.height() > 0.0
        })
        .collect::<Vec<_>>();
    let mut positions = Vec::new();
    for row in &rows {
        let position = (row.get_bounding_client_rect().top() - top).round();
        if !positions.contains(&position) {
            positions.push(position)
        }
    }
    let tail_top = positions.get(3).copied();
    let tail = tail_top.and_then(|position| {
        rows.iter()
            .find(|row| (row.get_bounding_client_rect().top() - top).round() == position)
    });
    let height = f64::from(inner.scroll_height());
    let preview = tail
        .map(|row| tail_top.unwrap() + 80.0_f64.min(row.get_bounding_client_rect().height() * 0.85))
        .unwrap_or(height);
    let _ = element.set_attribute(
        "data-can-collapse",
        if tail.is_some() { "true" } else { "false" },
    );
    let _=element.set_attribute("style",&format!("--profile-collapsible-height:{height}px;--profile-collapsible-collapsed-height:{preview}px"));
    for row in rows {
        let position = (row.get_bounding_client_rect().top() - top).round();
        let hidden = !expanded && tail_top.is_some_and(|tail| position >= tail);
        if hidden {
            let _ = row.set_attribute("inert", "");
            let _ = row.set_attribute("aria-hidden", "true");
        } else {
            let _ = row.remove_attribute("inert");
            let _ = row.remove_attribute("aria-hidden");
        }
        let mut classes = row
            .get_attribute("class")
            .unwrap_or_default()
            .split_whitespace()
            .filter(|v| *v != "profile-collapsible__preview-tail")
            .map(str::to_string)
            .collect::<Vec<_>>();
        if !expanded && tail_top == Some(position) {
            classes.push("profile-collapsible__preview-tail".into())
        }
        let _ = row.set_attribute("class", &classes.join(" "));
    }
}
pub fn collapse(element: &web_sys::Element, expanded: bool) -> Option<Collapse> {
    measure_collapse(element, expanded);
    let target = element.clone();
    let callback =
        Closure::wrap(
            Box::new(move |_: js_sys::Array| measure_collapse(&target, expanded))
                as Box<dyn FnMut(js_sys::Array)>,
        );
    let observer = web_sys::ResizeObserver::new(callback.as_ref().unchecked_ref()).ok()?;
    observer.observe(
        &element
            .first_element_child()
            .unwrap_or_else(|| element.clone()),
    );
    Some(Collapse {
        observer,
        _callback: callback,
    })
}
pub fn collapse_scroll() {
    let Some(element) = web_sys::window()
        .and_then(|v| v.document())
        .and_then(|d| d.get_element_by_id("persistent-achievement-collection"))
    else {
        return;
    };
    if element.get_bounding_client_rect().top() >= 0.0 {
        return;
    }
    if let Ok(Some(section)) = element.closest("section") {
        use wasm_bindgen::JsValue;
        if let Ok(function) = js_sys::Reflect::get(&section, &JsValue::from_str("scrollIntoView"))
            .and_then(|v| v.dyn_into::<js_sys::Function>())
        {
            let options = js_sys::Object::new();
            let _ = js_sys::Reflect::set(
                &options,
                &JsValue::from_str("block"),
                &JsValue::from_str("start"),
            );
            let _ = js_sys::Reflect::set(
                &options,
                &JsValue::from_str("behavior"),
                &JsValue::from_str("instant"),
            );
            let _ = function.call1(&section, &options);
        }
    }
}
