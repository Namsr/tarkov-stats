#[cfg(any(feature = "hydrate", test))]
#[path = "crosshair.rs"]
mod crosshair;
use super::data::{InitialReply, LevelBand, format, level_at, num};
use crate::i18n::Lang;
use leptos::{html, prelude::*};
use serde_json::Value;
use std::cmp::Ordering;

#[component]
pub fn Gauges(body: Memo<Option<Value>>, lang: RwSignal<Lang>) -> impl IntoView {
    let items=[("kd_ratio",8.0,2,"killed_pmc",Some("deaths")),("survival_rate",100.0,1,"total_raids",None),("kills_per_raid",5.0,2,"total_kills",Some("level"))].into_iter().map(move |(key,max,digits,detail,note)|view!{
  <article class="arena-combat-card"><h2>{move||lang.get().t(&format!("metric.{key}"))}</h2>
   <Ring value=Signal::derive(move||body.get().as_ref().and_then(|v|num(&v["averages"][key]))) maximum=max digits percentage={key=="survival_rate"} label=Signal::derive(move||lang.get().t(&format!("metric.{key}"))) lang/>
   <strong class="arena-combat-status">{move||format!("{}: {}",lang.get().t(&format!("metric.{detail}")),format(body.get().as_ref().and_then(|v|num(&v["averages"][detail])),0,lang.get()))}</strong>
   {note.map(|note|view!{<p class="arena-combat-note">{move||format!("{}: {}",lang.get().t(&format!("metric.{note}")),format(body.get().as_ref().and_then(|v|num(&v["averages"][note])),0,lang.get()))}</p>})}
  </article>}).collect_view();
    view! {<div class="arena-combat-gauges">{items}</div>}
}
#[component]
fn Ring(
    value: Signal<Option<f64>>,
    maximum: f64,
    digits: usize,
    percentage: bool,
    label: Signal<String>,
    lang: RwSignal<Lang>,
) -> impl IntoView {
    let text = move || {
        format!(
            "{}{}",
            format(value.get(), digits, lang.get()),
            if percentage && value.get().is_some() {
                "%"
            } else {
                ""
            }
        )
    };
    let fraction = move || value.get().map_or(0.0, |v| (v / maximum).clamp(0.0, 1.0));
    let arc = 2.0 * std::f64::consts::PI * 72.0 * 0.75;
    let circle = 2.0 * std::f64::consts::PI * 72.0;
    view! {<div class="arena-combat-ring" role="img" aria-label=move||format!("{}: {}",label.get(),text())><svg viewBox="0 0 200 184" aria-hidden="true"><circle class="arena-combat-ring__track" cx="100" cy="98" r="72" fill="none" stroke-width="10" stroke-linecap="round" stroke-dasharray=format!("{arc} {circle}") transform="rotate(135 100 98)"/><circle class="arena-combat-ring__fill" visibility=move||if value.get().is_some_and(|v|v>0.0){"visible"}else{"hidden"} cx="100" cy="98" r="72" fill="none" stroke-width="10" stroke-linecap="round" stroke-dasharray=move||format!("{} {circle}",arc*fraction()) transform="rotate(135 100 98)"/><circle class="arena-combat-ring__dot" r="5" cx=move||100.0+72.0*((135.0+fraction()*270.0).to_radians()).cos() cy=move||98.0+72.0*((135.0+fraction()*270.0).to_radians()).sin() visibility=move||if value.get().is_some(){"visible"}else{"hidden"}/></svg><div class="arena-combat-ring__value" aria-hidden="true"><strong>{text}</strong><small></small></div></div>}
}
#[component]
pub fn Comparison(
    selected: Memo<Option<Value>>,
    context: Memo<Option<Value>>,
    lang: RwSignal<Lang>,
) -> impl IntoView {
    let rows=[("kd_ratio",2,false),("survival_rate",1,true),("kills_per_raid",2,false),("total_raids",0,false)].into_iter().map(move|(key,digits,percent)|{let a=move||selected.get().as_ref().and_then(|v|num(&v["averages"][key]));let b=move||context.get().as_ref().and_then(|v|num(&v["averages"][key]));let text=move|v:Option<f64>|format!("{}{}",v.map(|v|super::data::format_max(Some(v),digits,lang.get())).unwrap_or_else(||lang.get().t("common.notAvailable")),if percent&&v.is_some(){"%"}else{""});view!{<div class="arena-comparison-row"><div class="arena-comparison-row__heading"><div><h3>{move||lang.get().t(&format!("metric.{key}"))}</h3><p>{move||format!("{}: {}",lang.get().t("radar.series.average"),text(b()))}</p></div><div class="arena-comparison-row__value"><strong>{move||text(a())}</strong><p>{move||a().zip(b()).and_then(|(a,b)|if percent{Some(a-b)}else if b>0.0{Some((a/b-1.0)*100.0)}else{None}).map(|n|format!("{}{}{} {}",if n>0.0{"+"}else{""},super::data::format_max(Some(n),1,lang.get()),if percent{format!(" {}",lang.get().t("arena.combat.pp"))}else{"%".into()},lang.get().t("arena.combat.vsAverage"))).unwrap_or_default()}</p></div></div><div class="arena-comparison-track" role="img" aria-label=move||format!("{}: {}; {}: {}",lang.get().t(&format!("metric.{key}")),text(a()),lang.get().t("radar.series.average"),text(b()))><span class="arena-comparison-fill" style=move||{let ratio=a().zip(b()).filter(|(_,b)|*b>0.0).map(|(a,b)|a/b);format!("width:{}%",ratio.map_or(0.0,|r|if r<=0.0{0.0}else{(0.5+r.ln().atan()/std::f64::consts::PI)*100.0}))}></span><span class="arena-comparison-average" aria-hidden="true" hidden=move||b().is_none()></span></div></div>}}).collect_view();
    view! {<section class="mt-10" aria-label=move||lang.get().t("average.selectionCompare")><h2 class="section-heading mb-3">{move||lang.get().t("average.selectionCompare")}</h2><div class="arena-comparison-bars"><div class="arena-bars-legend"><span><i class="arena-bars-player-key"></i>{move||lang.get().t("average.selection")}</span><span><i class="arena-bars-average-key"></i>{move||lang.get().t("radar.series.average")}</span></div>{rows}</div><p class="arena-combat-footnote">{move||lang.get().text("average.basedOn",&[("n",format(context.get().as_ref().and_then(|v|num(&v["averages"]["n"])),0,lang.get()))])}</p></section>}
}
const COLORS: [&str; 6] = [
    "#9ec49f", "#58a6ff", "#ffb74d", "#e06c75", "#56b6c2", "#9aa0a6",
];
fn metric_value(point: &Value) -> f64 {
    num(&point["n"])
        .filter(|n| *n > 0.0)
        .and_then(|n| num(&point["sum"]).map(|s| s / n))
        .unwrap_or(0.0)
}
fn metric_peak(body: &Option<Value>, key: &str) -> f64 {
    body.as_ref()
        .and_then(|b| b["series"][key].as_array())
        .map(|points| points.iter().map(metric_value).fold(0.0_f64, f64::max))
        .unwrap_or(0.0)
}
#[component]
pub fn Metrics(reply: RwSignal<InitialReply>, lang: RwSignal<Lang>) -> impl IntoView {
    let enabled = RwSignal::new([true; 6]);
    let toggles=super::state::OVERLAY.into_iter().enumerate().map(move|(i,key)|view!{<button type="button" aria-pressed=move||enabled.get()[i].to_string() class:is-active=move||enabled.get()[i] on:click=move|_|enabled.update(|v|v[i] = !v[i])><span aria-hidden="true" style=format!("background:{}",COLORS[i])></span>{move||lang.get().t(&format!("metric.{key}"))}</button>}).collect_view();
    let lines=super::state::OVERLAY.into_iter().enumerate().map(move|(i,key)|view!{
  <path fill="none" stroke=COLORS[i] stroke-width="2" vector-effect="non-scaling-stroke" visibility=move||if enabled.get()[i]{"visible"}else{"hidden"} d=move||{
   let body=reply.get().body;
   let Some(points)=body.as_ref().and_then(|b|b["series"][key].as_array())else{return String::new()};
   let active=enabled.get();let all=super::state::OVERLAY.iter().enumerate().filter(|(i,_)|active[*i]).filter_map(|(_,key)|body.as_ref().unwrap()["series"][*key].as_array()).flatten().filter_map(|p|num(&p["lo"])).collect::<Vec<_>>();
   let min=all.iter().copied().reduce(f64::min).unwrap_or(0.0);let max=all.iter().copied().fold(1.0_f64,f64::max);let peak=metric_peak(&body,key);
   points.iter().enumerate().map(|(i,p)|format!("{}{:.1},{:.1}",if i==0{"M"}else{"L"},44.0+(num(&p["lo"]).unwrap_or(0.0)-min)/(max-min).max(1.0)*702.0,14.0+(1.0-if peak>0.0{metric_value(p)/peak}else{0.0})*212.0)).collect::<Vec<_>>().join(" ")
  }/>
 }).collect_view();
    let labels=super::state::OVERLAY.into_iter().enumerate().map(move|(i,key)|view!{
  <span hidden=move||!enabled.get()[i]||!reply.with(|r|r.body.as_ref().is_some_and(|v|v["series"][key].is_array()))>{move||{
    let maximum=super::data::format_max(Some(metric_peak(&reply.get().body,key)),if i==1{1}else if i<3{2}else{0},lang.get());
    format!("{} · {}",lang.get().t(&format!("metric.{key}")),lang.get().text("average.metricChartMax",&[("n",maximum)]))
  }}</span>
 }).collect_view();
    view! {<section class="data-panel seasonal-chart mt-4" aria-label=move||lang.get().t("average.metricChart")><div class="seasonal-chart__head"><h2 class="section-heading">{move||lang.get().t("average.metricChart")}</h2><div class="seasonal-chart__toggles" aria-label=move||lang.get().t("average.metricChart")>{toggles}</div></div><p class="seasonal-chart__empty" hidden=move||{reply.get().status<400}>{move||lang.get().t("common.loadFailed")}</p><div class="seasonal-chart__scroll"><svg viewBox="0 0 760 260" role="img" aria-label=move||lang.get().t("average.metricChart")>{[0.0,0.5,1.0].into_iter().map(|n|view!{<line x1="44" x2="746" y1=14.0+n*212.0 y2=14.0+n*212.0 class="seasonal-chart__grid"/>}).collect_view()}{lines}<text x="395" y="254" text-anchor="middle" class="seasonal-chart__axis">{move||lang.get().t("average.pmcRaidsPlayed")}</text></svg></div><div class="seasonal-chart__meta">{labels}</div><p class="arena-combat-footnote">{move||lang.get().t("average.metricChartNorm")}</p></section>}
}
fn name(v: &Value, lang: Lang) -> String {
    let primary = if lang == Lang::Ru { "nameRu" } else { "name" };
    v[primary]
        .as_str()
        .or_else(|| v["name"].as_str())
        .or_else(|| v["nameRu"].as_str())
        .or_else(|| v["id"].as_str())
        .unwrap_or("")
        .into()
}
fn description(v: &Value, lang: Lang) -> String {
    [
        if lang == Lang::Ru {
            "descriptionRu"
        } else {
            "description"
        },
        "description",
        "descriptionRu",
    ]
    .into_iter()
    .filter_map(|key| v[key].as_str())
    .find(|s| !s.trim().is_empty())
    .unwrap_or("")
    .into()
}
fn rarity(v: &Value) -> String {
    let raw = v["rarity"].as_str().unwrap_or("").trim().to_lowercase();
    match raw.as_str() {
        "season" | "event" => "seasonal".into(),
        "легендарное" | "легендарная" | "легендарный" => {
            "legendary".into()
        }
        "эпическое" | "эпическая" | "эпический" => "epic".into(),
        "редкое" | "редкая" | "редкий" => "rare".into(),
        "необычное" | "необычная" | "необычный" => "uncommon".into(),
        "обычное" | "обычная" | "обычный" => "common".into(),
        _ => raw
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
            .collect(),
    }
}
fn compare_names(a: &str, b: &str, lang: Lang) -> Ordering {
    #[cfg(feature = "hydrate")]
    {
        use wasm_bindgen::{JsCast, JsValue};
        let compare = (|| -> Option<f64> {
            let intl = js_sys::Reflect::get(&js_sys::global(), &JsValue::from_str("Intl")).ok()?;
            let constructor = js_sys::Reflect::get(&intl, &JsValue::from_str("Collator"))
                .ok()?
                .dyn_into::<js_sys::Function>()
                .ok()?;
            let args = js_sys::Array::new();
            args.push(&JsValue::from_str(lang.as_str()));
            let options = js_sys::Object::new();
            js_sys::Reflect::set(
                &options,
                &JsValue::from_str("sensitivity"),
                &JsValue::from_str("base"),
            )
            .ok()?;
            args.push(&options);
            let collator = js_sys::Reflect::construct(&constructor, &args).ok()?;
            let compare = js_sys::Reflect::get(&collator, &JsValue::from_str("compare"))
                .ok()?
                .dyn_into::<js_sys::Function>()
                .ok()?;
            compare
                .call2(&collator, &JsValue::from_str(a), &JsValue::from_str(b))
                .ok()?
                .as_f64()
        })();
        if let Some(value) = compare {
            return value.total_cmp(&0.0);
        }
    }
    let _ = lang;
    a.to_lowercase().cmp(&b.to_lowercase())
}
pub fn sort_achievements(rows: &[Value], key: &str, descending: bool, lang: Lang) -> Vec<Value> {
    let mut out = rows
        .iter()
        .filter(|v| num(&v["owners"]).is_some_and(|n| n > 0.0))
        .cloned()
        .collect::<Vec<_>>();
    let compare = |a: Option<f64>, b: Option<f64>| match (a, b) {
        (None, None) => Ordering::Equal,
        (None, _) => Ordering::Greater,
        (_, None) => Ordering::Less,
        (Some(a), Some(b)) => {
            if descending {
                b.total_cmp(&a)
            } else {
                a.total_cmp(&b)
            }
        }
    };
    out.sort_by(|a, b| {
        let value = match key {
            "hours" => compare(unlock_hours(a), unlock_hours(b)),
            "percent" => compare(
                num(&a["samplePct"]).or(num(&a["officialPct"])),
                num(&b["samplePct"]).or(num(&b["officialPct"])),
            ),
            "rarity" => {
                let ranks = [
                    "common",
                    "uncommon",
                    "rare",
                    "epic",
                    "legendary",
                    "seasonal",
                ];
                let rank = |v: &Value| {
                    let key = rarity(v);
                    (!key.is_empty())
                        .then(|| ranks.iter().position(|v| *v == key).unwrap_or(6) as f64)
                };
                compare(rank(a), rank(b)).then_with(|| {
                    compare(
                        num(&a["samplePct"]).or(num(&a["officialPct"])),
                        num(&b["samplePct"]).or(num(&b["officialPct"])),
                    )
                })
            }
            _ => {
                let c = compare_names(&name(a, lang), &name(b, lang), lang);
                if descending { c.reverse() } else { c }
            }
        };
        value.then_with(|| {
            compare_names(
                a["id"].as_str().unwrap_or(""),
                b["id"].as_str().unwrap_or(""),
                lang,
            )
        })
    });
    out
}
#[component]
pub fn Achievements(
    reply: RwSignal<InitialReply>,
    lang: RwSignal<Lang>,
    retry: RwSignal<u64>,
) -> impl IntoView {
    let key = RwSignal::new("percent".to_string());
    let descending = RwSignal::new(true);
    let expanded = RwSignal::new(false);
    let container = NodeRef::<html::Div>::new();
    let rows = Memo::new(move |_| {
        sort_achievements(
            reply
                .get()
                .body
                .as_ref()
                .and_then(|b| b["achievements"].as_array())
                .map(Vec::as_slice)
                .unwrap_or(&[]),
            &key.get(),
            descending.get(),
            lang.get(),
        )
    });
    #[cfg(feature = "hydrate")]
    {
        let resize = StoredValue::new_local(None::<super::client::Collapse>);
        Effect::new(move |_| {
            let open = expanded.get();
            let _ = rows.get();
            if let Some(element) = container.get() {
                resize.set_value(super::client::collapse(&element, open));
            }
        });
        on_cleanup(move || {
            resize.update_value(|v| {
                v.take();
            })
        });
    }
    let change = move |next: &str| {
        if key.get_untracked() == next {
            descending.update(|v| *v = !*v)
        } else {
            key.set(next.into());
            descending.set(next == "hours")
        }
    };
    let sort_controls = move || {
        [("alphabet","achievement.col.name"),("percent","achievement.col.percent"),("hours","achievement.col.unlockTime"),("rarity","achievement.col.rarity")].into_iter().map(move|(field,label)|view!{<button type="button" class="achievement-table__sort" class:is-active=move||key.get()==field on:click=move|_|change(field) aria-pressed=move||(key.get()==field).to_string() aria-label=move||sort_label(lang.get(),field,&key.get(),descending.get(),label)>{move||lang.get().t(label)}{move||if key.get()==field{if descending.get(){" ↓"}else{" ↑"}}else{""}}</button>}).collect_view()
    };
    view! {<section id="ach-breakdown" class="mt-10"><div class="data-panel min-h-[240px] p-5"><div class="mb-4 flex flex-wrap items-center justify-between gap-3"><h2 class="section-heading text-base">{move||lang.get().t("profile.section.achievements")}</h2><div class="achievement-mobile-sort" role="group" aria-label=move||lang.get().t("achievement.sortLabel")>{sort_controls}</div></div>
       <div hidden=move||{reply.get().status<400||reply.get().status==503}><p class="mt-4 text-sm text-[var(--danger)]" role="alert">{move||lang.get().t("achv.error")}</p><button type="button" class="ghost-button mt-4 min-h-11" on:click=move|_|retry.update(|v|*v+=1)>{move||lang.get().t("achv.retry")}</button></div>
       <p class="text-sm text-[var(--muted)]" hidden=move||{!rows.get().is_empty()||reply.get().status>=400||reply.get().body.is_none()}>{move||lang.get().t("achv.empty")}</p>
       <div class="space-y-2" role="status" hidden=move||{reply.get().body.is_some()||(reply.get().status>=400&&reply.get().status!=503)} aria-label=move||lang.get().t("common.loading")>{(0..3).map(|_|view!{<div class="h-16 skeleton rounded"></div>}).collect_view()}</div>
    <div node_ref=container id="persistent-achievement-collection" class=move||format!("profile-collapsible__content achievement-collapsible__content {}",if expanded.get()||rows.get().len()<=3{"is-expanded"}else{"is-collapsed"})><div class="profile-collapsible__inner"><div class="achievement-table-wrap"><table class="achievement-table"><caption class="sr-only">{move||lang.get().t("achievement.averageTableCaption")}</caption><thead><tr>{[("alphabet","achievement.col.name"),("description","achievement.col.description"),("percent","achievement.col.percent"),("hours","achievement.col.unlockTime"),("rarity","achievement.col.rarity")].into_iter().map(move|(field,label)|view!{<th scope="col" aria-sort=move||if key.get()!=field{"none"}else if descending.get(){"descending"}else{"ascending"}><button type="button" class="achievement-table__sort" disabled={field=="description"} aria-pressed=move||(key.get()==field).to_string() aria-label=move||sort_label(lang.get(),field,&key.get(),descending.get(),label) on:click=move|_|change(field)>{move||lang.get().t(label)}</button></th>}).collect_view()}</tr></thead><tbody><For each=move||rows.get() key=|v|v.to_string() children=move|row|{let row=StoredValue::new(row);view!{<tr><th scope="row" class="achievement-table__name-cell"><div class="achievement-table__name"><AchievementIcon row/><span title=move||row.with_value(|v|name(v,lang.get()))>{move||row.with_value(|v|name(v,lang.get()))}</span></div></th><td class="achievement-table__description">{move||row.with_value(|v|{let description=description(v,lang.get());if description.is_empty(){lang.get().t("achievement.descriptionUnavailable")}else{description}})}</td><td class="achievement-table__number"><AchievementPercent row reply lang/></td><td class="achievement-table__number achievement-table__completed">{move||row.with_value(|v|unlock_hours(v).filter(|v|*v>0.0).map(|v|format!("{} {}",format(Some(v),0,lang.get()),lang.get().t("unit.h"))).unwrap_or_else(||lang.get().t("achievement.notAvailable")))}</td><td class="achievement-table__rarity">{move||row.with_value(|v|{let r=rarity(v);let label=lang.get().t(&format!("achievement.rarity.{r}"));if r.is_empty(){lang.get().t("achievement.notAvailable")}else if label.starts_with("achievement.rarity."){v["rarity"].as_str().unwrap_or("").into()}else{label}})}</td></tr>}}/></tbody></table></div>
       <div class="achievement-cards" role="list"><For each=move||rows.get() key=|v|v.to_string() children=move|row|{let row=StoredValue::new(row);view!{<article class="achievement-card" role="listitem"><div class="achievement-card__heading"><AchievementIcon row/><div class="min-w-0"><h3 class="achievement-card__name">{move||row.with_value(|v|name(v,lang.get()))}</h3><p class="achievement-card__description">{move||row.with_value(|v|{let d=description(v,lang.get());if d.is_empty(){lang.get().t("achievement.descriptionUnavailable")}else{d}})}</p></div></div><dl class="achievement-card__meta"><div><dt>{move||lang.get().t("achievement.col.percent")}</dt><dd><AchievementPercent row reply lang/></dd></div><div><dt>{move||lang.get().t("achievement.col.unlockTime")}</dt><dd>{move||row.with_value(|v|unlock_hours(v).filter(|v|*v>0.0).map(|v|format!("{} {}",format(Some(v),0,lang.get()),lang.get().t("unit.h"))).unwrap_or_else(||lang.get().t("achievement.notAvailable")))}</dd></div><div><dt>{move||lang.get().t("achievement.col.rarity")}</dt><dd>{move||row.with_value(|v|rarity_label(v,lang.get()))}</dd></div></dl></article>}}/></div></div></div>
       <button type="button" class="profile-collapsible__toggle" hidden=move||{rows.get().len()<=3} aria-controls="persistent-achievement-collection" aria-expanded=move||expanded.get().to_string() on:click=move|_|{#[cfg(feature="hydrate")]if expanded.get_untracked(){super::client::collapse_scroll();}expanded.update(|v|*v = !*v)}>{move||lang.get().t(if expanded.get(){"achievement.collapse"}else{"achievement.expand"})}<span aria-hidden="true">{move||if expanded.get(){"↑"}else{"↓"}}</span></button></div></section>}
}
fn unlock_hours(row: &Value) -> Option<f64> {
    num(&row["unlockHours"])
}
fn rarity_label(row: &Value, lang: Lang) -> String {
    let key = rarity(row);
    if key.is_empty() {
        return lang.t("achievement.notAvailable");
    }
    let text = lang.t(&format!("achievement.rarity.{key}"));
    if text.starts_with("achievement.rarity.") {
        row["rarity"].as_str().unwrap_or("").into()
    } else {
        text
    }
}
#[component]
fn AchievementIcon(row: StoredValue<Value>) -> impl IntoView {
    if let Some(image) = row.with_value(|v| v["imageUrl"].as_str().map(str::to_string)) {
        view!{<img class="achievement-table__icon" src=image alt="" width="56" height="56" loading="lazy" decoding="async" referrerpolicy="no-referrer" on:error=move|event|{#[cfg(feature="hydrate")]super::client::hide_image(&event);#[cfg(not(feature="hydrate"))]let _=event;}/>}.into_any()
    } else {
        view!{<span class="achievement-table__icon achievement-table__icon--empty" aria-hidden="true"></span>}.into_any()
    }
}
fn achievement_percent(row: &Value, total: Option<f64>, lang: Lang) -> (String, String) {
    let percent =
        |v: Option<f64>| v.map(|n| format!("{}%", super::data::format_max(Some(n), 2, lang)));
    let sample = percent(num(&row["samplePct"]));
    let official = percent(num(&row["officialPct"]));
    let primary = if let Some(sample) = &sample {
        if let (Some(owners), Some(eligible)) = (num(&row["owners"]), total) {
            lang.text(
                "achievement.samplePrimary",
                &[
                    ("value", sample.clone()),
                    ("owners", format(Some(owners), 0, lang)),
                    ("eligible", format(Some(eligible), 0, lang)),
                ],
            )
        } else {
            lang.text("achievement.sampleValue", &[("value", sample.clone())])
        }
    } else if let Some(official) = &official {
        lang.text("achievement.bsgPrimary", &[("value", official.clone())])
    } else {
        lang.t("achievement.notAvailable")
    };
    let secondary = if sample.is_some() {
        official
            .map(|value| lang.text("achievement.bsgLine", &[("value", value)]))
            .unwrap_or_default()
    } else {
        String::new()
    };
    (primary, secondary)
}
#[component]
fn AchievementPercent(
    row: StoredValue<Value>,
    reply: RwSignal<InitialReply>,
    lang: RwSignal<Lang>,
) -> impl IntoView {
    let values = move || {
        row.with_value(|v| {
            achievement_percent(
                v,
                reply.get().body.as_ref().and_then(|v| num(&v["total"])),
                lang.get(),
            )
        })
    };
    view! {<div class="achievement-table__percent"><strong>{move||values().0}</strong><small>{move||values().1}</small></div>}
}
#[derive(Clone, PartialEq)]
struct Plot {
    points: Vec<Value>,
    min_x: f64,
    max_x: f64,
    min_y: f64,
    max_y: f64,
}
fn plot(reply: &InitialReply) -> Plot {
    let points = reply
        .body
        .as_ref()
        .and_then(|b| b["series"]["cumulative"]["overall"].as_array())
        .map(|p| {
            p.iter()
                .filter(|p| num(&p["value"]).is_some() && num(&p["pmcRaids"]).is_some())
                .cloned()
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let min_x = points
        .iter()
        .filter_map(|p| num(&p["pmcRaids"]))
        .reduce(f64::min)
        .unwrap_or(1.0);
    let max_x = points
        .iter()
        .filter_map(|p| num(&p["pmcRaids"]))
        .reduce(f64::max)
        .unwrap_or(min_x + 1.0);
    let min_y = points
        .iter()
        .filter_map(|p| num(&p["value"]))
        .fold(0.0_f64, f64::min);
    let max_y = points
        .iter()
        .filter_map(|p| num(&p["value"]))
        .fold(0.0_f64, f64::max);
    let max_y = if max_y == min_y { min_y + 1.0 } else { max_y };
    let min_x = (min_x / 10.0).floor().max(0.0) * 10.0;
    Plot {
        points,
        min_x,
        max_x: (max_x / 10.0).ceil().mul_add(10.0, 0.0).max(min_x + 10.0),
        min_y,
        max_y,
    }
}
fn x(plot: &Plot, value: f64) -> f64 {
    62.0 + (value - plot.min_x) / (plot.max_x - plot.min_x) * 680.0
}
fn y(plot: &Plot, value: f64) -> f64 {
    18.0 + 214.0 - (value - plot.min_y) / (plot.max_y - plot.min_y) * 214.0
}
fn plot_path(plot: &Plot, key: &str) -> String {
    let mut previous: Option<Value> = None;
    plot.points
        .iter()
        .filter_map(|p| {
            let value = num(&p[key])?;
            let series = p.get("seriesId").cloned().unwrap_or(Value::Null);
            let start = previous.as_ref().is_none_or(|prev| prev != &series);
            previous = Some(series);
            Some(format!(
                "{}{:.2},{:.2}",
                if start { "M" } else { "L" },
                x(plot, num(&p["pmcRaids"])?),
                y(plot, value)
            ))
        })
        .collect::<Vec<_>>()
        .join(" ")
}
fn date_label(date: &str, lang: Lang) -> String {
    let parts = date.split('-').collect::<Vec<_>>();
    if parts.len() != 3 {
        return date.into();
    }
    if lang == Lang::Ru {
        format!("{}.{}.{}", parts[2], parts[1], parts[0])
    } else {
        format!(
            "{}/{}/{}",
            parts[1].trim_start_matches('0'),
            parts[2].trim_start_matches('0'),
            parts[0]
        )
    }
}
fn moscow_timestamp(ms: f64, lang: Lang) -> String {
    let seconds = (ms / 1000.0).floor() as i64 + 10800;
    let days = seconds.div_euclid(86400);
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    let year = year + i64::from(month <= 2);
    let seconds_in_day = seconds.rem_euclid(86400);
    let hour = seconds_in_day / 3600;
    let minute = seconds_in_day % 3600 / 60;
    let second = seconds_in_day % 60;
    let date = date_label(&format!("{year:04}-{month:02}-{day:02}"), lang);
    if lang == Lang::Ru {
        format!("{date}, {hour:02}:{minute:02}:{second:02}")
    } else {
        format!(
            "{date}, {}:{minute:02}:{second:02} {}",
            if hour % 12 == 0 { 12 } else { hour % 12 },
            if hour < 12 { "AM" } else { "PM" }
        )
    }
}
fn overall_key(mode: &str) -> &'static str {
    match mode {
        "seasonal" => "seasonal.series.overall",
        "pve" => "progression.series.overall.pve",
        _ => "progression.series.overall",
    }
}
fn point_label(point: &Value, bands: &[LevelBand], lang: Lang, mode: &str) -> String {
    let raw = num(&point["value"]);
    let value = if !bands.is_empty() {
        lang.text(
            "progression.xpLevelValue",
            &[
                ("xp", format(raw, 0, lang)),
                ("level", format(raw.map(|v| level_at(v, bands)), 0, lang)),
            ],
        )
    } else {
        format(raw, 0, lang)
    };
    let date = date_label(point["date"].as_str().unwrap_or(""), lang);
    let mut fields = vec![
        (
            "series",
            lang.t(if mode == "seasonal" {
                "seasonal.series.overall"
            } else {
                "progression.series.overall"
            }),
        ),
        ("date", date),
        ("value", value),
        ("n", format(num(&point["n"]), 0, lang)),
    ];
    if let (Some(min), Some(max)) = (num(&point["raidMin"]), num(&point["raidMax"])) {
        fields.push(("min", format(Some(min), 0, lang)));
        fields.push(("max", format(Some(max), 0, lang)));
        lang.text("progression.pointTipRange", &fields)
    } else {
        fields.push(("raids", format(num(&point["pmcRaids"]), 0, lang)));
        lang.text("progression.pointTip", &fields)
    }
}
fn sort_label(lang: Lang, field: &str, current: &str, descending: bool, label: &str) -> String {
    let next_descending = if current == field {
        !descending
    } else {
        field == "hours"
    };
    lang.text(
        "achievement.sortBy",
        &[
            ("column", lang.t(label)),
            (
                "direction",
                lang.t(if next_descending {
                    "achievement.sort.directionDesc"
                } else {
                    "achievement.sort.directionAsc"
                }),
            ),
        ],
    )
}
fn point_id(point: &Value) -> String {
    point["pointId"]
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| point["pmcRaids"].to_string())
}
#[component]
pub fn Progression(
    reply: RwSignal<InitialReply>,
    bands: Vec<LevelBand>,
    lang: RwSignal<Lang>,
    mode: String,
) -> impl IntoView {
    let bands = StoredValue::new(bands);
    let mode = StoredValue::new(mode);
    let shown = RwSignal::new(true);
    let active = RwSignal::new(None::<String>);
    let plot = Memo::new(move |_| {
        if shown.get() {
            plot(&reply.get())
        } else {
            plot(&InitialReply::default())
        }
    });
    let svg = NodeRef::<leptos::svg::Svg>::new();
    #[cfg(feature = "hydrate")]
    {
        let correction = StoredValue::new_local(None::<crosshair::Adjustment>);
        Effect::new(move |_| {
            let visible = active.get().is_some();
            let _ = (plot.get(), lang.get());
            correction.update_value(|v| {
                v.take();
            });
            if let Some(svg) = svg.get() {
                correction.set_value(Some(crosshair::watch(&svg, 760.0, visible)));
            }
        });
        on_cleanup(move || {
            correction.update_value(|v| {
                v.take();
            })
        });
    }
    let active_label = move || {
        active
            .get()
            .and_then(|id| {
                plot.get()
                    .points
                    .iter()
                    .find(|p| point_id(p) == id)
                    .cloned()
            })
            .map(|p| bands.with_value(|b| point_label(&p, b, lang.get(), &mode.get_value())))
            .unwrap_or_default()
    };
    let _inspect = move |point: Option<(f64, f64)>| {
        if !shown.get_untracked() {
            active.set(None);
            return;
        }
        if let Some((px, py)) = point {
            let mut nearest = None;
            let mut distance = 169.0;
            for p in &plot.get().points {
                let dx = x(&plot.get(), num(&p["pmcRaids"]).unwrap_or(0.0)) - px;
                let dy = y(&plot.get(), num(&p["value"]).unwrap_or(0.0)) - py;
                let candidate = dx * dx + dy * dy;
                if candidate <= distance {
                    nearest = Some(point_id(p));
                    distance = candidate
                }
            }
            active.set(nearest)
        }
    };
    view! {<section class="mt-10" aria-labelledby="average-progression-heading"><h2 id="average-progression-heading" class="section-heading">{move||lang.get().t("player.progression")}</h2><div class="h-72 rounded-xl skeleton" role="status" hidden=move||{reply.get().body.is_some()||(reply.get().status>=400&&reply.get().status!=503)} aria-label=move||lang.get().t("common.loading")></div><p class="mt-10 text-sm text-[var(--danger)]" role="status" hidden=move||{reply.get().body.is_some()||reply.get().status<400||reply.get().status==503}>{move||lang.get().t("progression.unavailable")}</p><section class="data-panel seasonal-chart" hidden=move||reply.get().body.is_none()><div class="seasonal-chart__head"><h2 class="section-heading">{move||lang.get().t("progression.chart.xp")}</h2><div class="seasonal-chart__toggles" aria-label=move||lang.get().t(if mode.with_value(|m|m=="seasonal"){"seasonal.series.toggleAria"}else{"progression.series.toggleAria"})><button type="button" aria-pressed=move||shown.get().to_string() class:is-active=move||shown.get() on:click=move|_|{shown.update(|v|*v = !*v);active.set(None)}><span style="background:#9aa0a6" aria-hidden="true"></span>{move||lang.get().t(overall_key(&mode.get_value()))}</button></div></div>
    <p class="seasonal-chart__empty" hidden=move||{reply.get().status<400}>{move||lang.get().t("progression.unavailable")}</p><p class="seasonal-chart__empty" hidden=move||!plot.get().points.is_empty()>{move||lang.get().t(if mode.with_value(|m|m=="seasonal"){"seasonal.noHistory"}else{"progression.noHistory"})}</p>
    <div class="seasonal-chart__scroll" hidden=move||plot.get().points.is_empty()><svg node_ref=svg viewBox="0 0 760 270" role="group" aria-label=move||lang.get().t("progression.chart.xp") on:pointermove=move|event|{#[cfg(feature="hydrate")]if event.pointer_type()!="touch"{_inspect(super::client::pointer_point(&event,760.0,270.0));}#[cfg(not(feature="hydrate"))]let _=event;} on:click=move|event|{#[cfg(feature="hydrate")]_inspect(super::client::mouse_point(&event,760.0,270.0));#[cfg(not(feature="hydrate"))]let _=event;} on:pointerleave=move|event|{#[cfg(feature="hydrate")]if !super::client::chart_focused(&event){active.set(None)}#[cfg(not(feature="hydrate"))]let _=event;}>
    {move||[0.0,0.25,0.5,0.75,1.0].into_iter().map(move|tick|{let value=plot.get().min_y+(plot.get().max_y-plot.get().min_y)*tick;view!{<g><line x1="62" x2="742" y1=y(&plot.get(),value) y2=y(&plot.get(),value) class="seasonal-chart__grid"/><text x="52" y=y(&plot.get(),value)+4.0 text-anchor="end" class="seasonal-chart__axis" data-chart-tick="">{bands.with_value(|bands|if bands.is_empty(){format(Some(value),0,lang.get())}else{lang.get().text("seasonal.levelBand",&[("level",format(Some(level_at(value,bands)),0,lang.get()))])})}</text></g>}}).collect_view()}
    {move||{let p=plot.get();let start=(p.min_x/10.0).ceil().max(1.0)*10.0;let end=(p.max_x/10.0).floor()*10.0;let count=((end-start)/10.0+1.0).max(0.0);let step=(count/8.0).ceil().max(1.0)*10.0;(0..((end-start)/step+1.0).max(0.0)as usize).map(move|i|{let raid=start+i as f64*step;view!{<g><line x1=x(&plot.get(),raid) x2=x(&plot.get(),raid) y1="18" y2="232" class="seasonal-chart__grid"/><text x=x(&plot.get(),raid) y="252" text-anchor="middle" class="seasonal-chart__axis" data-chart-tick="">{format(Some(raid),0,lang.get())}</text></g>}}).collect_view()}}
    <g visibility=move||if shown.get(){"visible"}else{"hidden"}><path d=move||plot_path(&plot.get(),"value") fill="none" stroke="#9aa0a6" stroke-width="2" vector-effect="non-scaling-stroke"/>
    <For each=move||plot.get().points key=point_id children=move|point|{let id=StoredValue::new(point_id(&point));let fallback=StoredValue::new(point);let p=Memo::new(move |_|plot.get().points.iter().find(|p|point_id(p)==id.get_value()).cloned().unwrap_or_else(||fallback.get_value()));let label=move||p.with(|p|bands.with_value(|b|point_label(p,b,lang.get(),&mode.get_value())));view!{<circle cx=move||p.with(|p|x(&plot.get(),num(&p["pmcRaids"]).unwrap_or(0.0))) cy=move||p.with(|p|y(&plot.get(),num(&p["value"]).unwrap_or(0.0))) r="13" fill="transparent" class="seasonal-chart__hit" role="button" tabindex="0" aria-label=label on:focus=move|_|active.set(Some(id.get_value())) on:blur=move|_|active.set(None) on:keydown=move|event|{match event.key().as_str(){"Escape"=>active.set(None),"Enter"|" "=>{event.prevent_default();active.set(Some(id.get_value()))},_=>{}}}><title>{label}</title></circle>}}/>
    {move||active.get().and_then(|id|plot.get().points.iter().find(|p|point_id(p)==id).cloned()).map(|p|{let px=x(&plot.get(),num(&p["pmcRaids"]).unwrap_or(0.0));let py=y(&plot.get(),num(&p["value"]).unwrap_or(0.0));view!{<g class="chart-crosshair" aria-hidden="true" pointer-events="none"><line x1=px x2=px y1=py y2="232" stroke="#9aa0a6" class="chart-crosshair__guide"/><line x1="62" x2=px y1=py y2=py stroke="#9aa0a6" class="chart-crosshair__guide"/><circle cx=px cy=py r="6" fill="#9aa0a6"/><text style="fill:#9aa0a6" x=px y="252" text-anchor="middle" class="chart-crosshair__label">{format(num(&p["pmcRaids"]),0,lang.get())}</text><text style="fill:#9aa0a6" x="52" y=py+4.0 text-anchor="end" class="chart-crosshair__label">{format(num(&p["value"]),0,lang.get())}</text></g>}})}</g><text x="402" y="265" text-anchor="middle" class="seasonal-chart__axis">{move||lang.get().t("progression.axisPmcRaids")}</text></svg></div>
    <p class="sr-only" role="status" aria-live="polite">{active_label}</p><div class="seasonal-chart__meta"><span>{move||lang.get().text("seasonal.sampleN",&[("n",format(reply.get().body.as_ref().and_then(|v|num(&v["series"]["cumulative"]["n"])),0,lang.get()))])}</span><span>{move||lang.get().text("seasonal.confidenceValue",&[("n",format(reply.get().body.as_ref().and_then(|v|num(&v["series"]["cumulative"]["confidence"])).map(|n|n*100.0),0,lang.get()))])}</span><span>{move||reply.get().body.as_ref().and_then(|v|num(&v["series"]["cumulative"]["freshnessAt"])).filter(|v|*v>0.0).map(|v|lang.get().text("seasonal.freshness",&[("date",moscow_timestamp(v,lang.get()))])).unwrap_or_default()}</span></div></section></section>}
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn achievement_sorts_keep_unknowns_last_in_both_directions_and_localize_fallbacks() {
        let rows = vec![
            json!({"id":"b","owners":1,"samplePct":20,"unlockHours":10,"rarity":"rare","name":"English","nameRu":"Русское"}),
            json!({"id":"a","owners":1,"officialPct":5,"earlyHours":100,"rarity":"event"}),
            json!({"id":"c","owners":1,"rarity":"???"}),
            json!({"id":"discard","owners":0,"samplePct":100}),
        ];
        let ids = |key, descending| {
            sort_achievements(&rows, key, descending, Lang::En)
                .into_iter()
                .map(|v| v["id"].as_str().unwrap().to_string())
                .collect::<Vec<_>>()
        };
        assert_eq!(ids("percent", false), ["a", "b", "c"]);
        assert_eq!(ids("percent", true), ["b", "a", "c"]);
        assert_eq!(ids("hours", true), ["b", "a", "c"]);
        assert_eq!(unlock_hours(&rows[1]), None);
        assert_eq!(ids("rarity", false), ["b", "a", "c"]);
        assert_eq!(name(&rows[0], Lang::Ru), "Русское");
        assert_eq!(name(&rows[1], Lang::Ru), "a");
    }
    #[test]
    fn cumulative_plot_keeps_subunit_bounds_series_breaks_and_publication_date() {
        let reply = InitialReply {
            body: Some(
                json!({"series":{"cumulative":{"overall":[{"pointId":"a","value":0.25,"pmcRaids":10,"seriesId":1},{"pointId":"b","value":0.5,"pmcRaids":11,"seriesId":2}]}}}),
            ),
            ..Default::default()
        };
        let p = plot(&reply);
        assert_eq!(p.min_x, 10.0);
        assert_eq!(p.max_x, 20.0);
        assert_eq!(p.max_y, 0.5);
        assert_eq!(y(&p, 0.5), 18.0);
        assert_eq!(plot_path(&p, "value").matches('M').count(), 2);
        assert_eq!(
            moscow_timestamp(1735689600000.0, Lang::Ru),
            "01.01.2025, 03:00:00"
        );
    }
    #[test]
    fn achievement_sort_controls_expose_current_and_next_direction_in_both_locales() {
        for lang in [Lang::En, Lang::Ru] {
            let expected = lang.text(
                "achievement.sortBy",
                &[
                    ("column", lang.t("achievement.col.percent")),
                    ("direction", lang.t("achievement.sort.directionAsc")),
                ],
            );
            assert_eq!(
                sort_label(lang, "percent", "percent", true, "achievement.col.percent"),
                expected
            );
            let html=Owner::new().with(||view!{<Achievements reply=RwSignal::new(InitialReply::default()) lang=RwSignal::new(lang) retry=RwSignal::new(0)/>}.to_html());
            assert!(html.matches("aria-pressed=\"true\"").count() >= 2);
            assert!(html.matches(&format!("aria-label=\"{expected}\"")).count() >= 2);
            assert!(html.contains("aria-sort=\"descending\""));
        }
    }
    #[test]
    fn unseeded_metric_panel_does_not_publish_false_zero_maxima() {
        let html=Owner::new().with(||view!{<Metrics reply=RwSignal::new(InitialReply::default()) lang=RwSignal::new(Lang::En)/>}.to_html());
        let meta = html
            .split("class=\"seasonal-chart__meta\"")
            .nth(1)
            .unwrap()
            .split("</div>")
            .next()
            .unwrap();
        let labels = meta.split("<span").skip(1).collect::<Vec<_>>();
        assert_eq!(labels.len(), 6);
        assert!(
            labels
                .iter()
                .all(|label| label.split('>').next().unwrap().contains("hidden"))
        );
        let body = serde_json::json!({"series":crate::persistent::state::OVERLAY.into_iter().map(|m|(m,Vec::<Value>::new())).collect::<std::collections::BTreeMap<_,_>>()});
        let html=Owner::new().with(||view!{<Metrics reply=RwSignal::new(InitialReply{body:Some(body),..Default::default()}) lang=RwSignal::new(Lang::En)/>}.to_html());
        let meta = html
            .split("class=\"seasonal-chart__meta\"")
            .nth(1)
            .unwrap()
            .split("</div>")
            .next()
            .unwrap();
        assert!(
            meta.split("<span").skip(1).all(|label| !label
                .split('>')
                .next()
                .unwrap()
                .contains("hidden")),
            "actual empty series has a known zero maximum"
        );
    }
}
