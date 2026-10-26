use super::{
    data::{self, PersistentInitial},
    panels,
    state::PersistentState,
};
use crate::{i18n::Lang, range::Bounds};
use leptos::{html, prelude::*};

fn history(state: &PersistentState) {
    #[cfg(feature = "hydrate")]
    super::client::history(state);
    #[cfg(not(feature = "hydrate"))]
    let _ = state;
}
fn update(state: RwSignal<PersistentState>, change: impl FnOnce(&mut PersistentState)) {
    state.update(|s| {
        change(s);
        s.sync();
        history(s)
    });
}
#[component]
pub fn PersistentDashboard(initial: PersistentInitial, lang: RwSignal<Lang>) -> impl IntoView {
    let seasonal = StoredValue::new(initial.seasonal_cycle.clone());
    let bands = initial.level_bands.clone();
    let state = RwSignal::new(initial.state.clone());
    let replies = initial.replies().map(RwSignal::new);
    let [
        selected_reply,
        context_reply,
        progression,
        metrics,
        achievements,
    ] = replies;
    let retry = RwSignal::new(0_u64);
    let selected_loading = RwSignal::new(false);
    let chart = NodeRef::<html::Div>::new();
    let width = RwSignal::new(0.0_f64);
    let hydrated = RwSignal::new(false);
    let visual = RwSignal::new(None::<Bounds>);
    let draft = RwSignal::new([
        initial.state.min.map(|v| v.to_string()).unwrap_or_default(),
        initial.state.max.map(|v| v.to_string()).unwrap_or_default(),
    ]);
    #[cfg(feature = "hydrate")]
    {
        let runtime = StoredValue::new_local(None::<super::client::Runtime>);
        let seed = StoredValue::new(Some(initial.clone()));
        Effect::new(move |_| {
            if let Some(initial) = seed.get_value() {
                seed.set_value(None);
                runtime.set_value(Some(super::client::mount(
                    state,
                    replies,
                    retry,
                    selected_loading,
                    initial,
                )));
                hydrated.set(true)
            }
        });
        let resize = StoredValue::new_local(None::<crate::view::client::Resize>);
        Effect::new(move |_| {
            if let Some(element) = chart.get() {
                resize.set_value(crate::view::client::observe(&element, width));
            }
        });
        on_cleanup(move || {
            runtime.update_value(|v| {
                v.take();
            });
            resize.update_value(|v| {
                v.take();
            });
        });
    }
    let selected = Memo::new(move |_| {
        selected_reply.get().body.filter(|b| {
            !state.get().invalid && data::matches(&state.get().requests()[0], b) == Some(true)
        })
    });
    let context = Memo::new(move |_| {
        context_reply
            .get()
            .body
            .filter(|b| data::matches(&state.get().requests()[1], b) == Some(true))
    });
    let bins = Memo::new(move |_| {
        data::histogram(
            &selected.get(),
            if width.get() > 0.0 {
                ((width.get() + 6.0) / 32.0).floor().max(1.0) as usize
            } else {
                36
            },
        )
    });
    let bounds = move || data::bounds(&selected.get(), &bins.get(), &state.get().dimension);
    let selection = move || {
        visual.get().unwrap_or_else(|| {
            let b = bounds();
            let s = state.get();
            Bounds {
                min: s.min.unwrap_or(b.min).clamp(b.min, b.max),
                max: s.max.unwrap_or(b.max).clamp(b.min, b.max),
            }
        })
    };
    let commit = move || {
        let values = draft.get_untracked();
        let low = crate::state::number(&values[0]);
        let high = crate::state::number(&values[1]);
        let invalid = (!crate::state::trim(&values[0]).is_empty() && low.is_none())
            || (!crate::state::trim(&values[1]).is_empty() && high.is_none())
            || low.zip(high).is_some_and(|(a, b)| a > b);
        if invalid {
            state.update(|s| s.invalid = true);
            return;
        }
        update(state, |s| {
            s.min = low;
            s.max = high
        });
    };
    #[cfg(feature = "hydrate")]
    let debounce = StoredValue::new_local(None::<crate::view::client::Timer>);
    let choose = move |range: Bounds| {
        visual.set(Some(range));
        draft.set([range.min.to_string(), range.max.to_string()]);
        #[cfg(feature = "hydrate")]
        debounce.set_value(crate::view::client::Timer::new(250, commit));
    };
    let reset = move || {
        visual.set(None);
        draft.set([String::new(), String::new()]);
    };
    let last = StoredValue::new(initial.state.clone());
    Effect::new(move |_| {
        let current = state.get();
        if current.requests() != last.get_value().requests() {
            visual.set(None);
            draft.set([
                current.min.map(|v| v.to_string()).unwrap_or_default(),
                current.max.map(|v| v.to_string()).unwrap_or_default(),
            ]);
            last.set_value(current);
        }
    });
    let unit = move || {
        lang.get().t(if state.get().dimension == "hours" {
            "unit.h"
        } else {
            "average.unitRaids"
        })
    };
    let sliders=[false,true].into_iter().map(move|high|{let position=move|high|data::position(&bins.get(),bounds(),if high{selection().max}else{selection().min},high,width.get());view!{
 <input type="range" min="0" max="10000" step="1" value=move||(position(high)*10000.0).round().to_string() prop:value=move||(position(high)*10000.0).round().to_string() disabled=move||!hydrated.get()||selected.get().is_none()||bounds().max<=bounds().min aria-label=move||lang.get().t(if high{"average.rangeMaxAria"}else{"average.rangeMinAria"}) aria-valuemin=move||if high{selection().min}else{bounds().min} aria-valuemax=move||if high{bounds().max}else{selection().max} aria-valuenow=move||if high{selection().max}else{selection().min} aria-valuetext=move||format!("{} {}",data::format_max(Some(if high{selection().max}else{selection().min}),3,lang.get()),unit())
 on:input=move|event|{if let Ok(raw)=event_target_value(&event).parse::<f64>(){let span=50.0_f64.min(bounds().max-bounds().min);let gap=if width.get()>0.0{20.0/width.get()}else{0.0};let requested=if high{(raw/10000.0).max(position(false)+gap)}else{(raw/10000.0).min(position(true)-gap)};let value=data::value_at(&bins.get(),bounds(),requested.clamp(0.0,1.0),high,width.get());let old=selection();choose(if high{Bounds{min:old.min,max:value.clamp((old.min+span).min(bounds().max),bounds().max)}}else{Bounds{min:value.clamp(bounds().min,(old.max-span).max(bounds().min)),max:old.max}});}}
 on:keydown=move|event|{let delta=match event.key().as_str(){"ArrowLeft"|"ArrowDown"=>Some(-1.0),"ArrowRight"|"ArrowUp"=>Some(1.0),_=>None};if let Some(delta)=delta{event.prevent_default();let old=selection();let b=bounds();let span=50.0_f64.min(b.max-b.min);choose(if high{Bounds{min:old.min,max:(old.max+delta).clamp((old.min+span).min(bounds().max),b.max)}}else{Bounds{min:(old.min+delta).clamp(b.min,(old.max-span).max(bounds().min)),max:old.max}});}}
 on:pointerdown=move|event|{#[cfg(feature="hydrate")]crate::view::client::capture(&event);#[cfg(not(feature="hydrate"))]let _=event;} on:pointerup=move|event|{#[cfg(feature="hydrate")]crate::view::client::release(&event);#[cfg(not(feature="hydrate"))]let _=event;} on:pointercancel=move|event|{#[cfg(feature="hydrate")]crate::view::client::release(&event);#[cfg(not(feature="hydrate"))]let _=event;}
 class:z-30=move||{!high&&selection().min>=bounds().max-(bounds().max-bounds().min)*0.05} class="pointer-events-none absolute inset-0 z-20 h-8 w-full appearance-none bg-transparent outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] [&::-webkit-slider-runnable-track]:h-1 [&::-webkit-slider-runnable-track]:bg-transparent [&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:h-5 [&::-webkit-slider-thumb]:w-5 [&::-webkit-slider-thumb]:-mt-2 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-[var(--card-bg)] [&::-webkit-slider-thumb]:bg-[var(--accent)] [&::-moz-range-thumb]:pointer-events-auto [&::-moz-range-thumb]:h-5 [&::-moz-range-thumb]:w-5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-[var(--card-bg)] [&::-moz-range-thumb]:bg-[var(--accent)]"/>
 }}).collect_view();
    let inputs=[false,true].into_iter().map(move|high|view!{<label class="text-xs text-[var(--muted)]"><span class="mb-1 block">{move||lang.get().t(if high{"average.rangeTo"}else{"average.rangeFrom"})}</span><input type="number" min="0" step="any" inputmode="decimal" name=if high{"max"}else{"min"} value=move||draft.get()[usize::from(high)].clone() prop:value=move||draft.get()[usize::from(high)].clone() placeholder=move||if high{bounds().max.to_string()}else{bounds().min.to_string()} aria-label=move||lang.get().t(if high{"average.rangeTo"}else{"average.rangeFrom"}) on:input=move|event|draft.update(|v|v[usize::from(high)]=event_target_value(&event)) on:blur=move|_|commit() on:keydown=move|event|{if event.key()=="Enter"{event.prevent_default();commit()}} class="min-h-11 w-full rounded-lg border border-[var(--card-border)] bg-[var(--input-bg)] px-3 py-2 text-sm text-[var(--foreground)] focus:border-[var(--accent)] focus:outline-none"/></label>}).collect_view();
    let options=[("metric.players",&["players"][..]),("average.groupCombat",&["kd_ratio","pmc_kd_ratio","kills_per_raid","total_kills","killed_pmc","deaths"][..]),("average.groupSurvival",&["survival_rate","longest_win_streak"][..]),("average.groupProgress",&["total_raids","pmc_raids","level","prestige","achv_count"][..])].into_iter().map(move|(label,keys)|view!{<optgroup label=move||lang.get().t(label)>{keys.iter().map(move|key|{let key=*key;view!{<option value=key selected=move||state.get().metric==key>{move||format!("{}{}",if key=="players"{String::new()}else{format!("{} ",lang.get().t("common.avg"))},lang.get().t(&format!("metric.{key}")))}</option>}}).collect_view()}</optgroup>}).collect_view();
    view! {<main class="page-frame"><a href="/" class="inline-block text-sm text-[var(--muted)] transition-colors hover:text-[var(--foreground)]">{move||lang.get().t("common.back")}</a><form method="get" on:submit=move|event|{event.prevent_default();commit();}>
    <div class="average-hero"><h1 class="page-title">{move||lang.get().t("nav.population")}</h1><nav class="mode-switch" aria-label=move||lang.get().t("mode.selectorAria")>{[("regular","regular"),("pve","pve"),("arena","arena"),("seasonal","pvp-season")].into_iter().map(move|(mode,path)|view!{<a class="mode-switch__item" aria-current=move||if state.get().mode==mode{Some("page")}else{None} href=move||{let mut p=crate::state::Params::default();p.set("statistic",&state.get().statistic);p.set("period",&state.get().period);if mode=="seasonal" && let Some(cycle)=seasonal.get_value(){p.set("cycle",&cycle)}format!("/population/{path}?{}",p.query())}>{move||lang.get().t(&format!("fav.mode.{mode}"))}</a>}).collect_view()}</nav></div>
    <section class="average-toolbar" aria-label=move||lang.get().t("average.settings")><fieldset class="segmented-control"><legend>{move||lang.get().t("average.statistic.label")}</legend><div class="segmented-control__options">{[("trimmed_mean","average.statistic.trimmedMean"),("median","average.statistic.median")].into_iter().map(move|(value,label)|view!{<label><input type="radio" name="statistic" value=value checked=move||state.get().statistic==value prop:checked=move||state.get().statistic==value on:change=move|_|update(state,|s|s.statistic=value.into())/><span>{move||lang.get().t(label)}</span></label>}).collect_view()}</div></fieldset><fieldset class="segmented-control"><legend>{move||lang.get().t("average.period.label")}</legend><div class="segmented-control__options">{[("all","average.period.all"),("90d","average.period.last90Days")].into_iter().map(move|(value,label)|view!{<label><input type="radio" name="period" value=value checked=move||state.get().period==value prop:checked=move||state.get().period==value on:change=move|_|{reset();update(state,|s|{s.period=value.into();s.min=None;s.max=None;});}/><span>{move||lang.get().t(label)}</span></label>}).collect_view()}</div></fieldset><details class="compact-details"><summary>{move||lang.get().t("average.calculation.help")}</summary><div class="grid gap-3"><p>{move||lang.get().t("average.robustNote")}</p><p>{move||lang.get().t("average.period.note")}</p></div></details></section>
    <p class="average-sampleline" aria-live="polite">{move||if selected_loading.get()||(selected_reply.get().body.is_none()&&(selected_reply.get().status<400||selected_reply.get().status==503)){lang.get().t("common.loading")}else{lang.get().text("average.basedOn",&[("n",data::format(data::sample_count(selected.get().as_ref()),0,lang.get()))])}}</p><p role="alert" class="mt-5 text-sm text-[var(--danger)]" hidden=move||{(selected_reply.get().status<400||selected_reply.get().status==503)&&!state.get().invalid}>{move||lang.get().t(if state.get().invalid{"arena.average.invalidRange"}else{"common.loadFailed"})}</p>
    <div class="arena-combat-gauges mt-5" role="status" hidden=move||{selected.get().is_some()||(selected_reply.get().status>=400&&selected_reply.get().status!=503)} aria-label=move||lang.get().t("common.loading")>{(0..3).map(|_|view!{<div class="h-64 rounded-xl skeleton"></div>}).collect_view()}</div><p class="mt-5 text-[var(--muted)]" hidden=move||{data::sample_count(selected.get().as_ref()).unwrap_or(-1.0)!=0.0}>{move||lang.get().t("average.emptyRange")}</p><div class="mt-5" hidden=move||{data::sample_count(selected.get().as_ref()).unwrap_or(0.0)<=0.0}><panels::Gauges body=selected lang/></div>
    <section class="mt-10"><div class="mb-4 average-chart-toolbar"><fieldset class="segmented-control"><legend>{move||lang.get().t("average.dimensionLabel")}</legend><div class="segmented-control__options">{[("hours","average.dimensionHours"),("pmc_raids","average.dimensionPmcRaids")].into_iter().map(move|(value,label)|view!{<label><input type="radio" name="dimension" value=value checked=move||state.get().dimension==value prop:checked=move||state.get().dimension==value on:change=move|_|{reset();update(state,|s|{s.dimension=value.into();s.min=None;s.max=None;});}/><span>{move||lang.get().t(label)}</span></label>}).collect_view()}</div></fieldset><label class="native-select"><span>{move||lang.get().t("average.metricLabel")}</span><select name="metric" prop:value=move||state.get().metric on:change=move|event|update(state,|s|s.metric=event_target_value(&event))>{options}</select></label></div>
    <div node_ref=chart class="chart-panel data-panel"><div class="h-60 rounded skeleton" role="status" aria-label=move||lang.get().t("common.loading") hidden=move||{selected.get().is_some()||(selected_reply.get().status>=400&&selected_reply.get().status!=503)}></div><p class="text-sm text-[var(--muted)]" hidden=move||{selected.get().is_none()||!bins.get().is_empty()}>{move||lang.get().t("average.noDataYet")}</p><div class="overflow-x-auto transition-opacity motion-reduce:transition-none" hidden=move||selected.get().is_none()||bins.get().is_empty() class:opacity-60=move||selected_loading.get() aria-busy=move||selected_loading.get().to_string()><div class="flex h-60 items-end gap-1.5 border-b border-[var(--card-border)]"><For each=move||bins.get() key=|b|format!("{}-{:?}",b.lo,b.hi) children=move|bin|{let id=StoredValue::new((bin.lo,bin.hi));let fallback=StoredValue::new(bin);let b=Memo::new(move |_|bins.with(|bins|bins.iter().find(|b|(b.lo,b.hi)==id.get_value()).cloned()).unwrap_or_else(||fallback.get_value()));let value=move||b.with(|b|if state.get().metric=="players"{b.n}else if b.n>0.0{b.sum/b.n}else{0.0});let title=move||b.with(|b|lang.get().text(if state.get().metric=="players"{"average.barTipCountDimension"}else{"average.barTipAvgDimension"},&[("label",b.label.clone()),("unit",unit()),("n",data::format(Some(b.n),0,lang.get())),("avg",data::metric_label(value(),&state.get().metric,lang.get()))]));view!{<a role="button" class="flex h-full min-w-[26px] flex-1 flex-col items-center justify-end focus-visible:outline-2 focus-visible:outline-[var(--accent)]" title=title aria-label=title href=move||{let mut s=state.get();let range=b.with(|b|data::select_bin(b,bounds()));s.min=Some(range.min);s.max=Some(range.max);s.sync();s.href()} on:click=move|event|{event.prevent_default();choose(b.with(|b|data::select_bin(b,bounds())))} on:keydown=move|event|{if event.key()==" "{event.prevent_default();choose(b.with(|b|data::select_bin(b,bounds())));}}><span class="mb-2 text-[10px] leading-none text-[var(--muted)]">{move||data::metric_label(value(),&state.get().metric,lang.get())}</span><div class="relative w-full overflow-hidden rounded-t bg-[var(--accent)]/15" style=move||{let peak=bins.get().iter().map(|b|if state.get().metric=="players"{b.n}else if b.n>0.0{b.sum/b.n}else{0.0}).fold(1.0_f64,f64::max);format!("height:{}%;min-height:2px",value()/peak*88.0)}><div class="absolute inset-y-0 bg-[var(--accent)]/70 transition-[left,width] duration-150 motion-reduce:transition-none hover:bg-[var(--accent)]" style=move||b.with(|b|{let end=b.hi.unwrap_or(bounds().max+1.0);let width=(end-b.lo).max(1.0);let start=b.lo.max(selection().min);let end=end.min(selection().max+1.0);format!("left:{}%;width:{}%",((start-b.lo)/width*100.0).clamp(0.0,100.0),((end-start).max(0.0)/width*100.0).clamp(0.0,100.0))})></div></div></a>}}/></div><div class="mt-3 flex gap-1.5">{move||{let all=bins.get();let step=((all.len()as f64)/12.0).ceil().max(1.0)as usize;all.iter().enumerate().map(|(i,b)|view!{<span class="chart-axis-label min-w-[26px] flex-1 text-center text-[11px] leading-tight text-[var(--muted)]" aria-hidden={i%step!=0}>{if i%step==0{b.label.clone()}else{String::new()}}</span>}).collect_view()}}</div><div class="mt-3 text-center text-[10px] text-[var(--muted)]">{move||lang.get().t(if state.get().dimension=="hours"{"average.hoursPlayed"}else{"average.pmcRaidsPlayed"})}</div></div>
    <div class="mt-6 border-t border-[var(--card-border)] pt-5"><p class="mb-3 text-center text-sm text-[var(--muted)]" aria-live="polite">{move||lang.get().text("average.selectedRange",&[("min",data::format_max(Some(selection().min),3,lang.get())),("max",data::format_max(Some(selection().max),3,lang.get())),("unit",unit())])}</p><div class="relative h-8 w-full"><div class="absolute left-0 right-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-[var(--card-border)]" aria-hidden="true"></div><div class="absolute top-1/2 h-1 -translate-y-1/2 rounded-full bg-[var(--accent)]" aria-hidden="true" style=move||format!("left:{}%;right:{}%",data::position(&bins.get(),bounds(),selection().min,false,width.get())*100.0,100.0-data::position(&bins.get(),bounds(),selection().max,true,width.get())*100.0)></div>{sliders}</div><div class="mt-3 grid grid-cols-2 gap-3">{inputs}</div><button type="submit" class="mt-4 min-h-11 rounded-lg border border-[var(--card-border)] px-4 py-2 focus-visible:outline-2 focus-visible:outline-[var(--accent)]">{move||lang.get().t("arena.average.applyFilters")}</button></div></div></section>
    <div hidden=move||{(state.get().min.is_none()&&state.get().max.is_none())||data::sample_count(selected.get().as_ref()).unwrap_or(0.0)<=0.0||context.get().is_none()}><panels::Comparison selected context lang/></div><panels::Progression reply=progression bands lang mode=initial.state.mode.clone()/><div hidden=move||progression.get().body.is_none()><panels::Metrics reply=metrics lang/></div>
    <div class="detail-grid detail-grid--compact mt-10" hidden=move||{data::sample_count(selected.get().as_ref()).unwrap_or(0.0)<=0.0}>{[("total_raids",0),("total_kills",0),("killed_pmc",0),("deaths",0),("run_through",1),("longest_win_streak",1),("achv_count",1),("hours",0),("level",0),("prestige",2)].into_iter().map(move|(key,digits)|view!{<div class="metric-card flex flex-col gap-2"><span class="metric-card__label">{move||lang.get().t(&format!("metric.{}",if key=="total_raids"&&state.get().dimension=="pmc_raids"{"pmc_raids"}else{key}))}</span><div class="flex items-end gap-2"><span class="metric-card__value tabular-nums">{move||data::format(selected.get().as_ref().and_then(|v|data::num(&v["averages"][if key=="total_raids"&&state.get().dimension=="pmc_raids"{"pmc_raids"}else{key}])),digits,lang.get())}</span></div></div>}).collect_view()}</div><panels::Achievements reply=achievements lang retry/>
    {move||state.get().params.0.into_iter().filter(|(k,_)|!["statistic","period","dimension","metric","min","max"].contains(&k.as_str())).map(|(k,v)|view!{<input type="hidden" name=k value=v/>}).collect_view()}
    </form></main>}
}
#[cfg(all(test, feature = "ssr"))]
mod tests {
    use super::*;
    use crate::persistent::data::{InitialReply, LevelBand};
    use serde_json::json;
    fn fixture() -> PersistentInitial {
        let state = PersistentState::read(
            "pve",
            "statistic=median&period=90d&unknown=%3Cscript%3E&unknown=two",
        )
        .unwrap();
        let body = json!({"mode":"pve","cycleId":"persistent","statistic":"median","period":"90d","dimension":"hours","metric":"players","averages":{"n":23,"kd_ratio":1.25,"survival_rate":50,"kills_per_raid":2.5,"total_raids":100,"killed_pmc":12,"deaths":50,"total_kills":250,"level":20},"metricCounts":{},"bounds":{"min":0,"max":100},"buckets":[{"lo":0,"hi":50,"n":10,"sum":0},{"lo":50,"hi":100,"n":13,"sum":0}]});
        let good = |body| InitialReply {
            body: Some(body),
            ..Default::default()
        };
        let progression = json!({"mode":"pve","cycleId":"persistent","series":{"cumulative":{"kind":"cumulative","n":23,"confidence":0.8,"freshnessAt":1735689600000_i64,"overall":[{"pointId":"one","date":"2025-01-01","pmcRaids":10,"value":1000,"n":23},{"pointId":"two","date":"2025-01-02","pmcRaids":20,"value":2000,"n":24}]}}});
        PersistentInitial {
            state,
            selected: good(body.clone()),
            context: good(body),
            progression: good(progression),
            metrics: good(
                json!({"mode":"pve","cycleId":"persistent","statistic":"median","period":"90d","series":{}}),
            ),
            achievements: good(
                json!({"total":23,"achievements":[{"id":"one","name":"Synthetic achievement","nameRu":"Тестовое достижение","description":"Synthetic description","descriptionRu":"Тестовое описание","owners":3,"samplePct":12.5,"officialPct":1,"unlockHours":20,"rarity":"rare","imageUrl":"/fixture-achievement.webp"}]}),
            ),
            level_bands: vec![
                LevelBand {
                    level: 1.0,
                    experience: 0.0,
                },
                LevelBand {
                    level: 2.0,
                    experience: 1000.0,
                },
            ],
            seasonal_cycle: Some("fixture-season".into()),
        }
    }
    #[test]
    fn every_panel_and_native_filter_is_real_server_html_in_both_languages() {
        for lang in [Lang::En, Lang::Ru] {
            let html = Owner::new().with(|| {
                view! {<PersistentDashboard initial=fixture() lang=RwSignal::new(lang)/>}.to_html()
            });
            for expected in [
                lang.t("metric.kd_ratio"),
                lang.t("progression.chart.xp"),
                lang.t("average.metricChart"),
                lang.t("profile.section.achievements"),
                lang.t("achievement.col.unlockTime"),
                lang.t("arena.average.applyFilters"),
            ] {
                assert!(html.contains(&expected), "missing {expected}")
            }
            for expected in [
                "23",
                "statistic",
                "period",
                "dimension",
                "metric",
                "type=\"range\"",
                "type=\"number\"",
                "method=\"get\"",
                "achievement-cards",
                "achievement-table",
                "seasonal-chart__hit",
                "unknown",
                "two",
            ] {
                assert!(html.contains(expected), "missing {expected}")
            }
            assert!(html.contains(if lang == Lang::Ru { "1,25" } else { "1.25" }));
            assert!(!html.contains("/_next/"));
            assert!(!html.contains("<script>"));
            assert!(html.contains("&lt;script&gt;"));
            assert!(!html.contains("seasonal-chart__corridor"));
        }
    }
    #[test]
    fn useful_main_html_survives_unseeded_auxiliary_data() {
        let mut initial = fixture();
        initial.achievements = InitialReply::default();
        initial.metrics = InitialReply::default();
        let html = Owner::new()
            .with(|| view! {<PersistentDashboard initial lang=RwSignal::new(Lang::En)/>}.to_html());
        assert!(html.contains("1.25"));
        assert!(!html.contains("profile.section.achievements"));
        assert!(html.contains("h-16 skeleton"));
    }
}
