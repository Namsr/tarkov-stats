use crate::{data::ArenaInitial, i18n::Lang, shell::SiteShell, view::ArenaDashboard};
use leptos::prelude::*;

#[island]
pub fn ArenaApp(initial: ArenaInitial, lang: Lang) -> impl IntoView {
    let language = RwSignal::new(lang);
    view! {<SiteShell lang=language><ArenaDashboard initial lang=language/></SiteShell>}
}

#[cfg(feature = "ssr")]
pub fn document(initial: ArenaInitial, lang: Lang, package: String) -> impl IntoView {
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
                <ArenaApp initial lang/>
            </body>
        </html>
    }
}
