#[cfg(any(feature = "ssr", not(feature = "hydrate-persistent")))]
use crate::{data::ArenaInitial, view::ArenaDashboard};
use crate::{i18n::Lang, shell::SiteShell};
use leptos::prelude::*;

#[cfg(any(feature = "ssr", not(feature = "hydrate-persistent")))]
#[island]
pub fn ArenaApp(initial: ArenaInitial, lang: Lang) -> impl IntoView {
    let language = RwSignal::new(lang);
    view! {<SiteShell lang=language><ArenaDashboard initial lang=language/></SiteShell>}
}

#[cfg(feature = "ssr")]
pub fn document(initial: ArenaInitial, lang: Lang, package: String) -> impl IntoView {
    full_document(view! {<ArenaApp initial lang/>}, lang, package)
}

#[cfg(any(feature = "ssr", feature = "hydrate-persistent"))]
#[island]
pub fn PersistentApp(
    initial: crate::persistent::data::PersistentInitial,
    lang: Lang,
) -> impl IntoView {
    let language = RwSignal::new(lang);
    view! {<SiteShell lang=language><crate::persistent::view::PersistentDashboard initial lang=language/></SiteShell>}
}
#[cfg(feature = "ssr")]
pub fn persistent_document(
    initial: crate::persistent::data::PersistentInitial,
    lang: Lang,
    package: String,
) -> impl IntoView {
    full_document(view! {<PersistentApp initial lang/>}, lang, package)
}
#[cfg(feature = "ssr")]
fn full_document(child: impl IntoView, lang: Lang, package: String) -> impl IntoView {
    let options = LeptosOptions::builder()
        .output_name("tarkov_ui")
        .site_pkg_dir(package.clone())
        .build();
    view! {
        <!DOCTYPE html>
        <html lang=lang.as_str() class="h-full antialiased">
            <head>
                <meta charset="utf-8"/>
                <meta name="viewport" content="width=device-width, initial-scale=1"/>
                <title>{lang.t("meta.title")}</title>
                <meta name="description" content=lang.t("meta.description")/>
                <link rel="icon" href="/favicon.ico"/>
                <link rel="stylesheet" href=format!("/{package}/tarkov_ui.css")/>
                <HydrationScripts options islands=true/>
            </head>
            <body class="min-h-full flex flex-col bg-[var(--background)] text-[var(--foreground)]">
                {child}
            </body>
        </html>
    }
}
