#![recursion_limit = "256"]
pub mod data;
pub mod i18n;
pub mod range;
pub mod state;
#[cfg(any(feature = "ssr", feature = "hydrate"))]
pub mod view;

#[cfg(any(feature = "ssr", feature = "hydrate"))]
pub mod shell;

#[cfg(any(feature = "ssr", feature = "hydrate"))]
pub mod app;

#[cfg(all(target_arch = "wasm32", feature = "hydrate"))]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn hydrate() {
    let messages = web_sys::window()
        .and_then(|window| window.document())
        .and_then(|document| document.get_element_by_id("rust-ui-messages"))
        .and_then(|element| element.text_content());
    if messages.is_some_and(|messages| i18n::install_messages(&messages)) {
        leptos::mount::hydrate_islands();
    }
}
