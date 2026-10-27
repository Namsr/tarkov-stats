use crate::{
    data::{ArenaInitial, ChartBucket, format_metric, format_number, histogram},
    i18n::Lang,
    range::{self, Bounds, Bucket, Edge},
    state::{ArenaState, FIELDS, Filter, METRICS, MODES, number},
};
use leptos::{html, prelude::*};
use serde_json::Value;
#[path = "client.rs"]
mod client;

fn history(state: &ArenaState) {
    #[cfg(feature = "hydrate")]
    client::replace_history(state);
    #[cfg(not(feature = "hydrate"))]
    let _ = state;
}
fn update_filter(state: RwSignal<ArenaState>, update: impl FnOnce(&mut Filter)) {
    state.update(|state| {
        let mut filter = state.filters[state.selected].clone();
        update(&mut filter);
        state.update(filter);
        history(state);
    });
}
fn commit(state: RwSignal<ArenaState>, draft: RwSignal<[String; 4]>) {
    let ranges = draft.get_untracked();
    if state.with_untracked(|state| state.filters[state.selected].ranges != ranges) {
        update_filter(state, |filter| filter.ranges = ranges);
    }
}
fn localized(value: f64, lang: Lang) -> String {
    format_number(value, 0, lang == Lang::Ru)
}
fn short_number(value: f64, lang: Lang) -> String {
    let decimals = if value.fract() == 0.0 { 0 } else { 3 };
    let formatted = format_number(value, decimals, lang == Lang::Ru);
    if decimals == 0 {
        formatted
    } else {
        formatted
            .trim_end_matches('0')
            .trim_end_matches(if lang == Lang::Ru { ',' } else { '.' })
            .into()
    }
}
fn domain(value: &Option<Value>, dimension: &str) -> Option<Bounds> {
    let bounds = value.as_ref()?.get("bounds")?.get(dimension)?;
    let min = bounds["min"].as_f64()?;
    let max = bounds["max"].as_f64()?;
    let original = Bounds { min, max };
    if !range::valid(original) {
        return None;
    }
    Some(if dimension == "hours" {
        Bounds {
            min: 0.0,
            max: max.ceil(),
        }
    } else {
        original
    })
}
#[derive(Clone)]
struct Bars(Vec<ChartBucket>);
impl PartialEq for Bars {
    fn eq(&self, other: &Self) -> bool {
        self.0.len() == other.0.len()
            && self.0.iter().zip(&other.0).all(|(a, b)| {
                a.geometry.min == b.geometry.min
                    && a.geometry.max == b.geometry.max
                    && a.sample_n == b.sample_n
                    && a.metric_n == b.metric_n
                    && a.value == b.value
            })
    }
}
fn range_title(bucket: Bucket, dimension: &str, lang: Lang) -> String {
    let unit = lang.t(if dimension == "hours" {
        "unit.h"
    } else {
        "arena.average.matchesUnit"
    });
    if let Some(max) = bucket.max {
        lang.text(
            "arena.average.bucketRange",
            &[
                ("min", localized(bucket.min.round(), lang)),
                ("max", localized(max.round(), lang)),
                ("unit", unit),
            ],
        )
    } else {
        lang.text(
            "arena.average.bucketFrom",
            &[("min", localized(bucket.min.round(), lang)), ("unit", unit)],
        )
    }
}
fn bucket_href(mut state: ArenaState, bounds: Option<Bounds>, bucket: Bucket) -> Option<String> {
    let bounds = bounds?;
    let mut filter = state.filters[state.selected].clone();
    let discrete = filter.dimension == "matches";
    let (min, max) = if discrete { (2, 3) } else { (0, 1) };
    let low = bucket.min.max(bounds.min);
    let high = bucket
        .max
        .map_or(bounds.max, |end| if discrete { end - 1.0 } else { end })
        .min(bounds.max)
        .max(low);
    filter.ranges[min] = if discrete && low == bounds.min {
        "10".into()
    } else {
        range::filter_value(low, bounds, Edge::Low)
    };
    filter.ranges[max] = range::filter_value(high, bounds, Edge::High);
    state.update(filter);
    state.params.set("mode", "arena");
    state.params.set("arenaMode", MODES[state.selected]);
    Some(format!("?{}", state.params.query()))
}
fn metric_name(metric: &str, lang: Lang) -> String {
    if metric == "players" {
        lang.t("arena.average.metric.players")
    } else {
        lang.t(&format!("arena.metric.{metric}"))
    }
}
fn display_metric(value: Option<f64>, metric: &str, lang: Lang) -> String {
    match value {
        None => lang.t("common.notAvailable"),
        Some(value) if metric == "players" => localized(value, lang),
        Some(value) => format_metric(Some(value), metric, lang == Lang::Ru),
    }
}

/// Full server-rendered GET form with Rust/WASM enhancement. Draft input values
/// are separate signals; neither typing nor a language switch replaces inputs.
#[component]
pub fn ArenaDashboard(initial: ArenaInitial, lang: RwSignal<Lang>) -> impl IntoView {
    let state = RwSignal::new(initial.state.clone());
    let draft = RwSignal::new(initial.state.filters[initial.state.selected].ranges.clone());
    let selected = RwSignal::new(initial.selected.clone());
    let context = RwSignal::new(initial.context.clone());
    let overview = RwSignal::new(initial.overview.clone().or_else(|| initial.context.clone()));
    let selected_loading = RwSignal::new(
        initial.selected.is_none()
            && initial.meta.selected_status != 400
            && initial.meta.selected_status < 500
            || initial.meta.selected_status == 503,
    );
    let selected_error = RwSignal::new(
        initial.selected.is_none()
            && initial.meta.selected_status >= 500
            && initial.meta.selected_status != 503,
    );
    let context_loading = RwSignal::new(
        initial.context.is_none()
            && (initial.meta.context_status == 200 || initial.meta.context_status == 503),
    );
    let context_error = RwSignal::new(
        initial.context.is_none()
            && initial.meta.context_status >= 500
            && initial.meta.context_status != 503,
    );
    let width = RwSignal::new(0.0_f64);
    let hydrated = RwSignal::new(false);
    let chart = NodeRef::<html::Section>::new();
    let last_filter = StoredValue::new((
        initial.state.selected,
        initial.state.filters[initial.state.selected].clone(),
    ));
    Effect::new(move |_| {
        let current = state.get();
        let filter = current.filters[current.selected].clone();
        if last_filter.get_value() != (current.selected, filter.clone()) {
            draft.set(filter.ranges.clone());
            last_filter.set_value((current.selected, filter));
        }
    });
    #[cfg(feature = "hydrate")]
    {
        Effect::new(move |_| hydrated.set(true));
        let runtime = StoredValue::new_local(None::<client::Runtime>);
        let seed = StoredValue::new(Some(initial.clone()));
        Effect::new(move |_| {
            let initial = seed.get_value();
            seed.set_value(None);
            if let Some(initial) = initial {
                runtime.set_value(Some(client::mount(
                    client::Signals {
                        state,
                        selected,
                        context,
                        overview,
                        selected_loading,
                        selected_error,
                        context_loading,
                        context_error,
                    },
                    initial,
                )));
            }
        });
        let resize = StoredValue::new_local(None::<client::Resize>);
        Effect::new(move |_| {
            if let Some(element) = chart.get() {
                resize.set_value(client::observe(&element, width));
            }
        });
        on_cleanup(move || {
            runtime.update_value(|value| {
                value.take();
            });
            resize.update_value(|value| {
                value.take();
            });
        });
    }
    let current = Memo::new(move |_| {
        let state = state.get();
        if state.filters[state.selected].invalid() {
            return None;
        }
        selected
            .get()
            .filter(|body| client::matches(&state.selected_request(), body))
    });
    let chart_context = Memo::new(move |_| {
        let state = state.get();
        context
            .get()
            .filter(|body| client::matches(&state.context_request(), body))
    });
    let invalid = move || state.with(|state| state.filters[state.selected].invalid());
    let bounds = move || {
        state.with(|state| {
            domain(
                &chart_context.get(),
                &state.filters[state.selected].dimension,
            )
        })
    };
    let fields = move || {
        state.with(|state| {
            if state.filters[state.selected].dimension == "hours" {
                (0, 1)
            } else {
                (2, 3)
            }
        })
    };
    let selection = move || {
        bounds().map(|bounds| {
            let (low, high) = fields();
            draft.with(|draft| range::selection(bounds, number(&draft[low]), number(&draft[high])))
        })
    };
    let bars = Memo::new(move |_| {
        let state = state.get();
        let filter = &state.filters[state.selected];
        let bins = if width.get() > 0.0 {
            ((width.get() + 6.0) / 32.0).floor().max(1.0) as usize
        } else {
            36
        };
        Bars(
            chart_context
                .get()
                .as_ref()
                .map(|body| histogram(body, &filter.metric, bins))
                .unwrap_or_default(),
        )
    });
    let set_range = move |low: f64, high: f64| {
        if let Some(bounds) = bounds() {
            let (min, max) = fields();
            let matches =
                state.with_untracked(|state| state.filters[state.selected].dimension == "matches");
            draft.update(|draft| {
                draft[min] = if matches && low == bounds.min {
                    "10".into()
                } else {
                    range::filter_value(low, bounds, Edge::Low)
                };
                draft[max] = range::filter_value(high, bounds, Edge::High);
            });
        }
    };
    let slider_position = move |edge| {
        if let (Some(bounds), Some(selection)) = (bounds(), selection()) {
            let geometry: Vec<_> = bars.get().0.iter().map(|bar| bar.geometry).collect();
            range::position(
                &geometry,
                bounds,
                if edge == Edge::Low {
                    selection.low
                } else {
                    selection.high
                },
                edge,
                fields().0 == 2,
                width.get(),
                6.0,
            )
        } else {
            if edge == Edge::Low { 0.0 } else { 1.0 }
        }
    };
    let slider_change = move |edge: Edge, requested: f64| {
        if let (Some(bounds), Some(selection)) = (bounds(), selection()) {
            let geometry: Vec<_> = bars.get().0.iter().map(|bar| bar.geometry).collect();
            let gap = if width.get() > 0.0 {
                20.0 / width.get()
            } else {
                0.0
            };
            let position = if edge == Edge::Low {
                requested.min(slider_position(Edge::High) - gap)
            } else {
                requested.max(slider_position(Edge::Low) + gap)
            };
            let value = range::value_at(
                &geometry,
                bounds,
                position.clamp(0.0, 1.0),
                edge,
                fields().0 == 2,
                width.get(),
                6.0,
            );
            if edge == Edge::Low {
                set_range(value.min(selection.high).max(bounds.min), selection.high);
            } else {
                set_range(selection.low, value.max(selection.low).min(bounds.max));
            }
        }
    };
    let modes = MODES.into_iter().enumerate().map(move |(index, mode)| view! {
        <button type="submit" name="arenaMode" value=mode id=format!("arena-mode-{mode}")
            aria-pressed=move ||(state.get().selected==index).to_string() class="arena-mode-picker__item"
            on:click=move |event| { event.prevent_default(); commit(state,draft); state.update(|state| { state.select(index); history(state); }); }>
            <span class="arena-mode-picker__name">{move ||lang.get().t(&format!("arena.mode.{mode}"))}</span>
            <span class="arena-mode-picker__count">{move || overview.with(|value| value.as_ref().and_then(|value| value["population"]["playedAccounts"][mode].as_f64())).map(|value| lang.get().text("arena.average.playedAccounts", &[("n",localized(value,lang.get()))])).unwrap_or_else(|| lang.get().t(if context_loading.get(){"common.loading"}else{"common.notAvailable"}))}</span>
        </button>
    }).collect_view();
    let metrics = METRICS.into_iter().map(move |metric| view! {
        <div class="metric-card" class:skeleton=move || selected_loading.get() && current.get().is_none()>
            <span class="metric-card__label">{move ||lang.get().t(&format!("arena.metric.{metric}"))}</span>
            <p class="mt-2 metric-card__value">{move || display_metric(current.get().as_ref().and_then(|value| value["metrics"][metric]["value"].as_f64()),metric,lang.get())}</p>
        </div>
    }).collect_view();
    let statistic = [("trimmed_mean","average.statistic.trimmedMean"),("median","average.statistic.median")].into_iter().map(move |(value,key)|view! {
        <label><input type="radio" name="arenaStatistic" value=value checked=move ||state.get().statistic==value prop:checked=move ||state.get().statistic==value
            on:change=move |_| { commit(state,draft); state.update(|state| { state.set_statistic(value); history(state); }); }/><span>{move ||lang.get().t(key)}</span></label>
    }).collect_view();
    let dimensions = [("hours","average.dimensionHours"),("matches","arena.average.dimension.matches")].into_iter().map(move |(value,key)|view! {
        <label><input type="radio" name=move ||state.with(|state|format!("arena_{}_dimension",MODES[state.selected])) value=value
            checked=move ||state.with(|state|state.filters[state.selected].dimension==value) prop:checked=move ||state.with(|state|state.filters[state.selected].dimension==value)
            on:change=move |_|update_filter(state, |filter|filter.dimension=value.into())/><span>{move ||lang.get().t(key)}</span></label>
    }).collect_view();
    let metric_options = std::iter::once("players").chain(METRICS).map(move |metric|view! { <option value=metric selected=move ||state.with(|state|state.filters[state.selected].metric==metric)>{move ||metric_name(metric,lang.get())}</option> }).collect_view();
    let inputs = [(false,"average.rangeFrom"),(true,"average.rangeTo")].into_iter().map(move |(high,key)|view! {
        <label class="text-xs text-[var(--muted)]"><span class="mb-1 block">{move ||lang.get().t(key)}</span>
            <input type="number" min="0" step="any" inputmode="decimal"
                name=move ||state.with(|state|format!("arena_{}_{}",MODES[state.selected],FIELDS[if high {fields().1}else{fields().0}]))
                value=move ||draft.with(|draft|draft[if high {fields().1}else{fields().0}].clone()) prop:value=move ||draft.with(|draft|draft[if high {fields().1}else{fields().0}].clone())
                placeholder=move ||bounds().map(|bounds|if high {bounds.max}else{bounds.min}).map(|n|n.to_string())
                aria-label=move ||lang.get().t(key)
                on:input=move |event| { let value=event_target_value(&event); draft.update(|draft|draft[if high {fields().1}else{fields().0}]=value); }
                on:blur=move |_|commit(state,draft)
                on:keydown=move |event| { if event.key()=="Enter" { event.prevent_default(); commit(state,draft); } }
                class="min-h-11 w-full rounded-lg border border-[var(--card-border)] bg-[var(--input-bg)] px-3 py-2 text-sm text-[var(--foreground)] focus:border-[var(--accent)] focus:outline-none"/>
        </label>
    }).collect_view();
    let sliders = [Edge::Low,Edge::High].into_iter().map(move |edge|view! {
        <input type="range" min="0" max="10000" step="1" value=move ||(slider_position(edge)*10000.0).round().to_string() prop:value=move ||(slider_position(edge)*10000.0).round().to_string()
            disabled=move ||selection().is_none() || !hydrated.get() aria-label=move ||lang.get().t(if edge==Edge::Low{"average.rangeMinAria"}else{"average.rangeMaxAria"})
            aria-valuemin=move ||selection().zip(bounds()).map_or(0.0,|(selected,bounds)|if edge==Edge::Low{bounds.min}else{selected.low})
            aria-valuemax=move ||selection().zip(bounds()).map_or(1.0,|(selected,bounds)|if edge==Edge::Low{selected.high}else{bounds.max})
            aria-valuenow=move ||selection().map_or(0.0,|selected|if edge==Edge::Low{selected.low}else{selected.high})
            aria-valuetext=move ||selection().map(|selected|format!("{} {}",short_number(if edge==Edge::Low{selected.low}else{selected.high},lang.get()),lang.get().t(if fields().0==0{"unit.h"}else{"arena.average.matchesUnit"}))).unwrap_or_else(||lang.get().t("common.notAvailable"))
            on:input=move |event| { if let Ok(value)=event_target_value(&event).parse::<f64>() { slider_change(edge,value/10000.0); } }
            on:keydown=move |event| { let delta=match event.key().as_str(){"ArrowLeft"|"ArrowDown"=>Some(-1.0),"ArrowRight"|"ArrowUp"=>Some(1.0),_=>None}; if let Some(delta)=delta { event.prevent_default(); if let(Some(selected),Some(bounds))=(selection(),bounds()){if edge==Edge::Low{set_range((selected.low+delta).clamp(bounds.min,selected.high),selected.high)}else{set_range(selected.low,(selected.high+delta).clamp(selected.low,bounds.max))}} } }
            on:keyup=move |_|commit(state,draft) on:blur=move |_|commit(state,draft)
            on:pointerdown=move |_event|{#[cfg(feature="hydrate")]client::capture(&_event);}
            on:pointerup=move |_event|{#[cfg(feature="hydrate")]client::release(&_event);commit(state,draft);}
            on:pointercancel=move |_event|{#[cfg(feature="hydrate")]client::release(&_event);commit(state,draft);}
            class:z-30=move ||edge==Edge::Low && selection().zip(bounds()).is_some_and(|(selected,bounds)|selected.low >= bounds.max-(bounds.max-bounds.min)*0.05) class="pointer-events-none absolute inset-0 z-20 h-8 w-full appearance-none bg-transparent outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] [&::-webkit-slider-runnable-track]:h-1 [&::-webkit-slider-runnable-track]:bg-transparent [&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:h-5 [&::-webkit-slider-thumb]:w-5 [&::-webkit-slider-thumb]:-mt-2 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-[var(--card-bg)] [&::-webkit-slider-thumb]:bg-[var(--accent)] [&::-webkit-slider-thumb]:shadow-md [&::-moz-range-track]:h-1 [&::-moz-range-track]:bg-transparent [&::-moz-range-thumb]:pointer-events-auto [&::-moz-range-thumb]:h-5 [&::-moz-range-thumb]:w-5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-[var(--card-bg)] [&::-moz-range-thumb]:bg-[var(--accent)]"/>
    }).collect_view();
    let population_modes = [("regular","regular"),("pve","pve"),("arena","arena"),("seasonal","pvp-season")].into_iter().map(move |(mode,path)|view! {
        <a href=format!("/population/{path}") aria-current=if mode=="arena"{Some("page")}else{None} class="mode-switch__item">{move ||lang.get().t(&format!("fav.mode.{mode}"))}</a>
    }).collect_view();
    view! {<main class="page-frame">
      <a href="/" class="inline-block text-sm text-[var(--muted)] transition-colors hover:text-[var(--foreground)]">{move ||lang.get().t("common.back")}</a>
      <form method="get" on:submit=move |event|{event.prevent_default();commit(state,draft);}>
        <div class="average-hero"><h1 class="page-title">{move ||lang.get().t("nav.population")}</h1><nav class="mode-switch" aria-label=move ||lang.get().t("mode.selectorAria")>{population_modes}</nav></div>
        <section class="average-toolbar" aria-label=move ||lang.get().t("average.settings")>
          <fieldset class="segmented-control"><legend>{move ||lang.get().t("average.statistic.label")}</legend><div class="segmented-control__options">{statistic}</div></fieldset>
          <details class="compact-details"><summary>{move ||lang.get().t("average.calculation.help")}</summary><p>{move ||lang.get().t("arena.average.statisticNote")}</p></details>
        </section>
        <section class="summary-strip surface"><div class="summary-strip__copy"><div class="section-kicker">{move ||lang.get().t("average.accountsScanned")}</div><div class="summary-strip__number" aria-live="polite">{move ||overview.with(|value|value.as_ref().and_then(|value|value["population"]["scannedAccounts"].as_f64())).map(|n|localized(n,lang.get())).unwrap_or_else(||lang.get().t(if context_loading.get(){"common.loading"}else{"common.notAvailable"}))}</div></div></section>
        <nav class="arena-mode-picker" aria-label=move ||lang.get().t("arena.average.modeSelector")>{modes}</nav>
        <section class="data-panel mt-5 p-5 sm:p-6" aria-labelledby=move ||state.with(|state|format!("arena-mode-{}",MODES[state.selected]))>
          <p class="mt-4 text-sm text-[var(--danger)]" role="alert" hidden=move ||!invalid()>{move ||lang.get().t("arena.average.invalidRange")}</p>
          <p class="mt-4 text-sm text-[var(--danger)]" role="alert" hidden=move ||!selected_error.get() || selected_loading.get()>{move ||lang.get().t("arena.average.error")}</p>
          <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-5" hidden=move ||current.get().is_none() && !selected_loading.get()>{metrics}</div>
          <div class="average-chart-toolbar">
            <fieldset class="segmented-control"><legend>{move ||lang.get().t("average.dimensionLabel")}</legend><div class="segmented-control__options">{dimensions}</div></fieldset>
            <label class="native-select"><span>{move ||lang.get().t("average.metricLabel")}</span><select name=move ||state.with(|state|format!("arena_{}_metric",MODES[state.selected])) prop:value=move ||state.with(|state|state.filters[state.selected].metric.clone()) on:change=move |event|{let value=event_target_value(&event);update_filter(state,|filter|filter.metric=value);}>{metric_options}</select></label>
            <span class="sample-status" aria-live="polite">{move ||current.get().as_ref().and_then(|value|value["sampleN"].as_f64()).map(|n|lang.get().text("average.basedOn",&[("n",localized(n,lang.get()))])).unwrap_or_else(||if selected_loading.get(){lang.get().t("common.loading")}else{String::new()})}</span>
          </div>
          <section node_ref=chart class="chart-panel data-panel mt-4" aria-labelledby=move ||state.with(|state|format!("arena-histogram-{}-{}-{}",MODES[state.selected],state.filters[state.selected].dimension,state.filters[state.selected].metric))>
            <div class="mb-4 text-xs text-[var(--muted)]"><span class="font-semibold text-[var(--accent)]" id=move ||state.with(|state|format!("arena-histogram-{}-{}-{}",MODES[state.selected],state.filters[state.selected].dimension,state.filters[state.selected].metric))>{move ||state.with(|state|metric_name(&state.filters[state.selected].metric,lang.get()))}</span>" · "{move ||lang.get().t(if fields().0==0{"average.dimensionHours"}else{"arena.average.dimension.matches"})}</div>
            <div class="h-60 rounded skeleton" hidden=move ||!context_loading.get() || chart_context.get().is_some()></div>
            <p class="h-60 pt-2 text-sm text-[var(--muted)]" hidden=move ||context_loading.get() || !bars.get().0.is_empty()>{move ||lang.get().t(if context_error.get(){"arena.average.error"}else{"arena.average.empty"})}</p>
            <div class="overflow-x-auto" hidden=move ||bars.get().0.is_empty()>
              <div class="flex h-60 items-end gap-1.5 border-b border-[var(--card-border)]">
                <For each=move ||bars.get().0 key=|bar|format!("{}-{:?}-{:?}-{}-{}",bar.geometry.min,bar.geometry.max,bar.value,bar.metric_n,bar.sample_n) children=move |bar| {
                  let geometry=bar.geometry;let value=bar.value;let n=bar.metric_n;
                  let title=move ||state.with(|state|{let filter=&state.filters[state.selected];lang.get().text("arena.average.bucketTitle",&[("range",range_title(geometry,&filter.dimension,lang.get())),("value",display_metric(value,&filter.metric,lang.get())),("n",localized(n,lang.get()))])});
                  view!{<a role="button" href=move ||bucket_href(state.get(),bounds(),geometry) class="flex h-full min-w-[26px] flex-1 flex-col items-center justify-end focus-visible:outline-2 focus-visible:outline-[var(--accent)]" title=title aria-label=title aria-disabled=move ||selection().is_none().to_string()
                    on:keydown=move |event|{if event.key()==" "{event.prevent_default();if let Some(bounds)=bounds(){let low=geometry.min.max(bounds.min);let high=geometry.max.map_or(bounds.max,|max|if fields().0==2{max-1.0}else{max}).min(bounds.max).max(low);set_range(low,high);commit(state,draft);}}}
                    on:click=move |event|{event.prevent_default();if let Some(bounds)=bounds(){let low=geometry.min.max(bounds.min);let high=geometry.max.map_or(bounds.max,|max|if fields().0==2{max-1.0}else{max}).min(bounds.max).max(low);set_range(low,high);commit(state,draft);}}>
                    <span class="mb-2 text-[10px] leading-none tabular-nums text-[var(--muted)]">{move ||state.with(|state|display_metric(value,&state.filters[state.selected].metric,lang.get()))}</span>
                    <span class="relative w-full overflow-hidden rounded-t bg-[var(--accent)]/15" style=move ||{let max=bars.get().0.iter().filter_map(|bar|bar.value).fold(1.0_f64,f64::max);format!("height:{}%;min-height:{}px",value.map(|value|(value/max*88.0).max(2.0)).unwrap_or(0.0),if value.is_some(){2}else{0})}>
                      <span class="absolute inset-y-0 bg-[var(--accent)]/70 transition-[left,width] duration-150 motion-reduce:transition-none hover:bg-[var(--accent)]" style=move ||{let(left,width)=selection().zip(bounds()).map(|(selected,bounds)|range::slice(geometry,selected,bounds,fields().0==2)).unwrap_or((0.0,0.0));format!("left:{left}%;width:{width}%")}></span>
                    </span>
                  </a>}
                }/>
              </div>
              <div class="mt-3 flex gap-1.5"><For each=move ||bars.get().0 key=|bar|format!("{}-{:?}-{:?}-{}-{}",bar.geometry.min,bar.geometry.max,bar.value,bar.metric_n,bar.sample_n) children=move |bar|view!{<span class="min-w-[26px] flex-1 text-center text-[9px] leading-tight text-[var(--muted)]">{move ||bar.geometry.max.map(|max|format!("{}–{}",localized(bar.geometry.min.round(),lang.get()),localized(max.round(),lang.get()))).unwrap_or_else(||format!("{}+",localized(bar.geometry.min.round(),lang.get())))}</span>}/></div>
              <p class="mt-3 text-center text-[10px] text-[var(--muted)]">{move ||lang.get().t(if fields().0==0{"unit.h"}else{"arena.average.matchesUnit"})}</p>
            </div>
            <div class="mt-6 border-t border-[var(--card-border)] pt-5">
              <p class="mb-3 text-center text-sm text-[var(--muted)]" aria-live="polite">{move ||{let(low,high)=fields();let domain=bounds();let values=draft.get();let low=number(&values[low]).or(domain.map(|b|b.min));let high=number(&values[high]).or(domain.map(|b|b.max));if let(Some(low),Some(high))=(low,high){lang.get().text("average.selectedRange",&[("min",short_number(low,lang.get())),("max",short_number(high,lang.get())),("unit",lang.get().t(if fields().0==0{"unit.h"}else{"arena.average.matchesUnit"}))])}else{lang.get().t(if context_error.get(){"arena.average.error"}else if context_loading.get(){"common.loading"}else{"arena.average.empty"})}}}</p>
              <div class="relative h-8 w-full" class:opacity-50=move ||selection().is_none()><div aria-hidden="true" class="absolute left-0 right-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-[var(--card-border)]"></div><div aria-hidden="true" class="absolute top-1/2 h-1 -translate-y-1/2 rounded-full bg-[var(--accent)]" style=move ||format!("left:{}%;right:{}%",slider_position(Edge::Low)*100.0,100.0-slider_position(Edge::High)*100.0)></div>{sliders}</div>
              <div class="mt-3 grid grid-cols-2 gap-3">{inputs}</div>
            </div>
          </section>
          <button type="submit" class="mt-4 min-h-11 rounded-lg border border-[var(--card-border)] px-4 py-2 text-sm focus-visible:outline-2 focus-visible:outline-[var(--accent)]">{move ||lang.get().t("arena.average.applyFilters")}</button>
        </section>
        <input type="hidden" name="mode" value="arena"/><input type="hidden" name="arenaMode" value=move ||MODES[state.get().selected]/>
        {move ||{let state=state.get();let selected=MODES[state.selected];state.params.0.iter().filter(|(key,_)|key!="mode"&&key!="arenaMode"&&key!="arenaStatistic"&&key!=&format!("arena_{selected}_dimension")&&key!=&format!("arena_{selected}_metric")&&!FIELDS.iter().any(|field|key==&format!("arena_{selected}_{field}"))).map(|(key,value)|view!{<input type="hidden" name=key.clone() value=value.clone()/>}).collect_view()}}
        {move ||{let state=state.get();let(min,max)=if state.filters[state.selected].dimension=="hours"{(0,1)}else{(2,3)};FIELDS.iter().enumerate().filter(|(index,_)|*index!=min&&*index!=max).map(|(index,key)|view!{<input type="hidden" name=format!("arena_{}_{}",MODES[state.selected],key) value=state.filters[state.selected].ranges[index].clone()/>}).collect_view()}}
      </form>
    </main>}
}

#[component]
pub fn ArenaContent(initial: ArenaInitial, lang: Lang) -> impl IntoView {
    view! {<ArenaDashboard initial lang=RwSignal::new(lang)/>}
}

#[cfg(all(test, feature = "ssr"))]
mod tests {
    use super::*;
    use serde_json::json;
    fn initial() -> ArenaInitial {
        let state = ArenaState::read("unknown=keep&unknown=again");
        let mut payload = json!({"mode":"arena","schemaVersion":5,"filterIdentity":{"mode":"teamFight","statistic":"trimmed_mean","dimension":"matches","metric":"players","minHours":null,"maxHours":null,"minMatches":null,"maxMatches":null},"population":{"scannedAccounts":1234,"playedAccounts":{"teamFight":42}},"sampleN":20,"metrics":{"kd_ratio":{"value":1.005}},"bounds":{"matches":{"min":10,"max":99}},"buckets":[{"min":10,"max":20,"sampleN":20,"metrics":{}}]});
        let context = payload.clone();
        payload["filterIdentity"]["minMatches"] = json!(10);
        ArenaInitial::new(state, Some(payload), Some(context.clone()), Some(context))
    }
    #[test]
    fn useful_data_and_all_native_form_controls_are_server_rendered() {
        let html =
            Owner::new().with(|| view! {<ArenaContent initial=initial() lang=Lang::En/>}.to_html());
        for content in [
            "1,234",
            "1.01",
            "arena-mode-teamFight",
            "arena-mode-shootOutDuo",
            "arenaStatistic",
            "type=\"range\"",
            "type=\"number\"",
            "Apply filters",
            "unknown",
            "keep",
            "again",
        ] {
            assert!(html.contains(content), "missing {content}");
        }
        assert!(!html.contains("/_next/"));
    }
    #[test]
    fn api_valid_ranges_outside_the_sample_do_not_block_native_get() {
        for (dimension, low, high) in [
            ("matches", "10", ""),
            ("matches", "0", "1"),
            ("matches", "200", "300"),
            ("hours", "0.25", "1000.5"),
        ] {
            let mut fixture = initial();
            let filter = &mut fixture.state.filters[0];
            filter.dimension = dimension.into();
            let (min, max) = if dimension == "matches" {
                (2, 3)
            } else {
                (0, 1)
            };
            filter.ranges[min] = low.into();
            filter.ranges[max] = high.into();
            for payload in [&mut fixture.context, &mut fixture.selected] {
                payload.as_mut().unwrap()["bounds"][dimension] = json!({"min":70,"max":130});
                payload.as_mut().unwrap()["filterIdentity"]["dimension"] = json!(dimension);
            }
            let html = Owner::new()
                .with(|| view! {<ArenaContent initial=fixture lang=Lang::En/>}.to_html());
            let inputs: Vec<_> = html
                .split("<input")
                .filter(|part| part.starts_with(" type=\"number\""))
                .map(|part| part.split('>').next().unwrap())
                .collect();
            assert_eq!(inputs.len(), 2);
            for input in &inputs {
                // API filters may be outside the observed sample; the slider alone clamps to it.
                assert!(input.contains(" min=\"0\""), "{input}");
                assert!(!input.contains(" max="), "{input}");
            }
            assert!(
                inputs[0].contains(&format!(" value=\"{low}\"")),
                "{}",
                inputs[0]
            );
            assert!(
                inputs[1].contains(&format!(" value=\"{high}\"")),
                "{}",
                inputs[1]
            );
        }
    }
    #[test]
    fn slider_describes_actual_sample_values_and_localized_units() {
        for lang in [Lang::En, Lang::Ru] {
            let mut fixture = initial();
            for payload in [&mut fixture.context, &mut fixture.selected] {
                payload.as_mut().unwrap()["bounds"]["matches"] = json!({"min":70,"max":130});
                payload.as_mut().unwrap()["buckets"] =
                    json!([{"min":70,"max":131,"sampleN":20,"metrics":{}}]);
            }
            let html = Owner::new().with(|| view! {<ArenaContent initial=fixture lang/>}.to_html());
            let sliders: Vec<_> = html
                .split("<input")
                .filter(|part| part.starts_with(" type=\"range\""))
                .map(|part| part.split('>').next().unwrap())
                .collect();
            assert_eq!(sliders.len(), 2);
            for (input, actual, position) in [(sliders[0], 70, 0), (sliders[1], 130, 10000)] {
                assert!(
                    input.contains(&format!(" aria-valuenow=\"{actual}\"")),
                    "{input}"
                );
                assert!(
                    input.contains(&format!(
                        " aria-valuetext=\"{actual} {}\"",
                        lang.t("arena.average.matchesUnit")
                    )),
                    "{input}"
                );
                assert!(input.contains(&format!(" value=\"{position}\"")), "{input}");
            }
            assert!(html.contains("value=\"10\""));
        }
    }
    #[test]
    fn bucket_native_link_keeps_unknown_parameters_and_inclusive_ranges() {
        let state = ArenaState::read("arenaMode=lastHero&unknown=keep&unknown=again");
        let href = bucket_href(
            state,
            Some(Bounds {
                min: 10.0,
                max: 99.0,
            }),
            Bucket {
                min: 25.0,
                max: Some(50.0),
            },
        )
        .unwrap();
        let parsed = ArenaState::read(href.trim_start_matches('?'));
        assert_eq!(parsed.filters[1].ranges[2], "25");
        assert_eq!(parsed.filters[1].ranges[3], "49");
        assert!(href.contains("unknown=keep&unknown=again"));
        assert!(
            bucket_href(
                parsed,
                None,
                Bucket {
                    min: 0.0,
                    max: None
                }
            )
            .is_none()
        );
    }
    #[test]
    fn strict_client_identity_rejects_a_missing_bound_or_wrong_filter() {
        let fixture = initial();
        let mut payload = fixture.selected.unwrap();
        let url = fixture.state.selected_request();
        assert!(client::matches(&url, &payload));
        payload["filterIdentity"]
            .as_object_mut()
            .unwrap()
            .remove("maxMatches");
        assert!(!client::matches(&url, &payload));
        payload["filterIdentity"]["maxMatches"] = Value::Null;
        payload["filterIdentity"]["minMatches"] = json!(11);
        assert!(!client::matches(&url, &payload));
    }
    #[test]
    fn invalid_filter_and_russian_labels_do_not_drop_the_form() {
        let mut initial = initial();
        initial.state.filters[0].ranges[0] = "bad".into();
        let html = Owner::new().with(|| view! {<ArenaContent initial lang=Lang::Ru/>}.to_html());
        assert!(html.contains(&Lang::Ru.t("arena.average.invalidRange")));
        assert!(html.contains(&Lang::Ru.t("arena.average.applyFilters")));
    }
}
