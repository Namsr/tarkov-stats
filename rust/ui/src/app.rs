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
    unavailable: bool,
) -> impl IntoView {
    let language = RwSignal::new(lang);
    let content = if unavailable {
        view!{<main class="page-frame"><h1 class="page-title">{move||language.get().t("seasonal.unavailable")}</h1><a href="/" class="mt-6 inline-block text-[var(--accent)] hover:underline">{move||language.get().t("common.back")}</a></main>}.into_any()
    } else {
        view! {<crate::persistent::view::PersistentDashboard initial lang=language/>}.into_any()
    };
    view! {<SiteShell lang=language>{content}</SiteShell>}
}
#[cfg(feature = "ssr")]
pub fn persistent_document(
    initial: crate::persistent::data::PersistentInitial,
    lang: Lang,
    package: String,
) -> impl IntoView {
    full_document(
        view! {<PersistentApp initial lang unavailable=false/>},
        lang,
        package,
    )
}
#[cfg(feature = "ssr")]
pub fn persistent_unavailable_document(lang: Lang, package: String) -> impl IntoView {
    use crate::persistent::{
        data::{InitialReply, PersistentInitial},
        state::PersistentState,
    };
    // This state is serialized only to keep the same single hydration root.
    // The unavailable branch never mounts the dashboard or starts data requests.
    let initial = PersistentInitial {
        state: PersistentState::read("regular", "").expect("known placeholder mode"),
        selected: InitialReply::default(),
        context: InitialReply::default(),
        progression: InitialReply::default(),
        metrics: InitialReply::default(),
        achievements: InitialReply::default(),
        level_bands: Vec::new(),
        seasonal_cycle: None,
    };
    full_document(
        view! {<PersistentApp initial lang unavailable=true/>},
        lang,
        package,
    )
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

#[cfg(all(test, feature = "ssr"))]
mod tests {
    use super::*;
    #[test]
    fn unavailable_seasonal_uses_same_hydration_root_without_dashboard_data() {
        for lang in [Lang::En, Lang::Ru] {
            use crate::persistent::{
                data::{InitialReply, PersistentInitial},
                state::PersistentState,
            };
            let initial = PersistentInitial {
                state: PersistentState::read("regular", "").unwrap(),
                selected: InitialReply::default(),
                context: InitialReply::default(),
                progression: InitialReply::default(),
                metrics: InitialReply::default(),
                achievements: InitialReply::default(),
                level_bands: Vec::new(),
                seasonal_cycle: None,
            };
            let html = Owner::new()
                .with(|| view! {<PersistentApp initial lang unavailable=true/>}.to_html());
            assert!(html.contains(&lang.t("seasonal.unavailable")));
            assert!(html.contains(&lang.t("common.back")));
            assert!(html.contains("page-frame"));
            assert!(!html.contains("average-toolbar"));
            assert!(!html.contains("name=\"statistic\""));
            assert!(!html.contains("seasonal-chart__hit"));
            assert!(!html.contains("/_next/"));
        }
    }
}
