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

#[cfg(feature = "hydrate")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn hydrate() {
    leptos::mount::hydrate_islands();
}
