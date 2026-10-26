use super::state::PersistentState;
use crate::{i18n::Lang, range::Bounds, state::Params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct InitialReply {
    pub body: Option<Value>,
    pub status: u16,
    pub stale: bool,
    pub publication_stale: bool,
    pub retry_after: u64,
    pub generated_at: f64,
}
impl InitialReply {
    pub fn has_response(&self) -> bool {
        self.body.is_some() || self.status != 200
    }
}
impl Default for InitialReply {
    fn default() -> Self {
        Self {
            body: None,
            status: 200,
            stale: false,
            publication_stale: false,
            retry_after: 5,
            generated_at: 0.0,
        }
    }
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct LevelBand {
    pub level: f64,
    pub experience: f64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PersistentInitial {
    pub state: PersistentState,
    #[serde(default)]
    pub selected: InitialReply,
    #[serde(default)]
    pub context: InitialReply,
    #[serde(default)]
    pub progression: InitialReply,
    #[serde(default)]
    pub metrics: InitialReply,
    #[serde(default)]
    pub achievements: InitialReply,
    #[serde(default)]
    pub level_bands: Vec<LevelBand>,
    #[serde(default)]
    pub seasonal_cycle: Option<String>,
}
pub fn bundled_level_bands() -> Vec<LevelBand> {
    let rows: Vec<Value> = serde_json::from_str(include_str!(
        "../../../../lib/player-levels-v2026-07-22.json"
    ))
    .expect("checked shared player XP snapshot");
    let mut rows = rows
        .into_iter()
        .filter_map(|v| Some((num(&v["level"])?, num(&v["exp"]).filter(|v| *v >= 0.0)?)))
        .collect::<Vec<_>>();
    rows.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut experience = 0.0;
    rows.into_iter()
        .map(|(level, exp)| {
            experience += exp;
            LevelBand { level, experience }
        })
        .collect()
}
impl PersistentInitial {
    pub fn replies(&self) -> [InitialReply; 5] {
        [
            self.selected.clone(),
            self.context.clone(),
            self.progression.clone(),
            self.metrics.clone(),
            self.achievements.clone(),
        ]
    }
}
pub fn matches(url: &str, body: &Value) -> Option<bool> {
    let (path, query) = url.split_once('?').unwrap_or((url, ""));
    if ![
        "/api/average",
        "/api/seasonal/average",
        "/api/progression/average",
        "/api/average/metrics",
        "/api/average/achievements",
    ]
    .contains(&path)
    {
        return None;
    }
    let p = Params::parse(query);
    let mode = if path == "/api/seasonal/average" {
        "seasonal"
    } else {
        p.get("mode").unwrap_or("regular")
    };
    if !["regular", "pve", "seasonal"].contains(&mode) {
        return None;
    }
    let cycle = if mode == "seasonal" {
        let Some(cycle) = p.get("cycle") else {
            return Some(false);
        };
        cycle
    } else {
        "persistent"
    };
    if cycle.is_empty() || (mode == "seasonal" && cycle == "persistent") {
        return Some(false);
    }
    let valid = if path == "/api/average/achievements" {
        body["total"].as_f64().is_some_and(|v| v >= 0.0) && body["achievements"].is_array()
    } else if body["mode"] != mode || body["cycleId"] != cycle {
        false
    } else if path == "/api/progression/average" {
        body["series"]["cumulative"]["overall"].is_array()
    } else if body["statistic"] != p.get("statistic").unwrap_or("trimmed_mean")
        || body["period"] != p.get("period").unwrap_or("all")
    {
        false
    } else if path == "/api/average/metrics" {
        super::state::OVERLAY
            .iter()
            .all(|m| body["series"][m].is_array())
    } else {
        body["dimension"] == p.get("dimension").unwrap_or("hours")
            && body["metric"] == p.get("metric").unwrap_or("players")
            && body["buckets"].is_array()
            && body["metricCounts"].is_object()
            && (body["averages"].is_object() || body["averages"].is_null())
    };
    Some(valid)
}
pub fn num(value: &Value) -> Option<f64> {
    value.as_f64().filter(|v| v.is_finite())
}
pub fn sample_count(body: Option<&Value>) -> Option<f64> {
    body.map(|v| num(&v["averages"]["n"]).unwrap_or(0.0))
}
pub fn format(value: Option<f64>, digits: usize, lang: Lang) -> String {
    value
        .map(|v| crate::data::format_number(v, digits, lang == Lang::Ru))
        .unwrap_or_else(|| "—".into())
}
pub fn format_max(value: Option<f64>, digits: usize, lang: Lang) -> String {
    let value = format(value, digits, lang);
    if digits == 0 {
        return value;
    }
    value
        .trim_end_matches('0')
        .trim_end_matches(if lang == Lang::Ru { ',' } else { '.' })
        .into()
}
pub fn metric_label(value: f64, key: &str, lang: Lang) -> String {
    let digits = match key {
        "players" | "total_raids" | "pmc_raids" | "total_kills" | "killed_pmc" | "deaths"
        | "level" => 0,
        "survival_rate" | "longest_win_streak" | "achv_count" => 1,
        _ => 2,
    };
    let formatted = if digits == 0 && value.abs() >= 1000.0 {
        let s = format!("{:.1}", value / 1000.0);
        format!("{}k", s.trim_end_matches('0').trim_end_matches('.'))
    } else {
        format(Some(value), digits, lang)
    };
    format!(
        "{formatted}{}",
        if key == "survival_rate" { "%" } else { "" }
    )
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Bin {
    pub lo: f64,
    pub hi: Option<f64>,
    pub n: f64,
    pub sum: f64,
    pub label: String,
}
fn bound_label(value: f64) -> String {
    if value >= 1000.0 {
        let s = format!("{:.2}", value / 1000.0);
        format!("{}k", s.trim_end_matches('0').trim_end_matches('.'))
    } else {
        value.to_string()
    }
}
pub fn histogram(body: &Option<Value>, cap: usize) -> Vec<Bin> {
    let Some(raw) = body.as_ref().and_then(|v| v["buckets"].as_array()) else {
        return Vec::new();
    };
    let mut cells = raw
        .iter()
        .filter_map(|v| {
            let lo = num(&v["lo"])?;
            let hi = num(&v["hi"]);
            let n = num(&v["n"])?;
            let sum = num(&v["sum"])?;
            (n > 0.0 && hi.is_none_or(|hi| hi > lo)).then(|| Bin {
                lo,
                hi,
                n,
                sum,
                label: String::new(),
            })
        })
        .collect::<Vec<_>>();
    cells.sort_by(|a, b| a.lo.total_cmp(&b.lo));
    if cells.is_empty() {
        return cells;
    }
    let mut threshold = 5.0;
    loop {
        let mut out: Vec<Bin> = Vec::new();
        let mut current = Bin {
            lo: cells[0].lo,
            hi: None,
            n: 0.0,
            sum: 0.0,
            label: String::new(),
        };
        for b in &cells {
            current.hi = b.hi;
            current.n += b.n;
            current.sum += b.sum;
            if current.n >= threshold {
                let next = current.hi.unwrap_or(current.lo);
                out.push(current);
                current = Bin {
                    lo: next,
                    hi: None,
                    n: 0.0,
                    sum: 0.0,
                    label: String::new(),
                };
            }
        }
        if current.n > 0.0 {
            if let Some(last) = out.last_mut() {
                last.n += current.n;
                last.sum += current.sum;
                last.hi = current.hi
            } else {
                out.push(current)
            }
        }
        if out.len() <= cap.clamp(1, 36) || out.len() <= 1 {
            for b in &mut out {
                b.label =
                    b.hi.map(|hi| format!("{}–{}", bound_label(b.lo), bound_label(hi)))
                        .unwrap_or_else(|| format!("{}+", bound_label(b.lo)))
            }
            return out;
        }
        threshold = (threshold * 1.5).ceil();
    }
}
pub fn bounds(body: &Option<Value>, bins: &[Bin], dimension: &str) -> Bounds {
    if let Some(v) = body.as_ref()
        && let (Some(min), Some(max)) = (num(&v["bounds"]["min"]), num(&v["bounds"]["max"]))
        && min >= 0.0
        && max > min
    {
        return Bounds {
            min: min.floor(),
            max: max.ceil(),
        };
    }
    let fallback = Bounds {
        min: 0.0,
        max: if dimension == "hours" { 5000.0 } else { 1000.0 },
    };
    let Some(first) = bins.first() else {
        return fallback;
    };
    let last = bins.last().unwrap();
    let previous = bins.get(bins.len().saturating_sub(2));
    let width = last
        .hi
        .map(|h| h - last.lo)
        .or_else(|| previous.and_then(|p| p.hi.map(|h| h - p.lo)))
        .unwrap_or(fallback.max - fallback.min);
    Bounds {
        min: first.lo.floor().max(0.0),
        max: last
            .hi
            .unwrap_or(last.lo + width)
            .ceil()
            .max(first.lo.floor() + 1.0),
    }
}
pub fn position(bins: &[Bin], bounds: Bounds, value: f64, high: bool, width: f64) -> f64 {
    let value = value + if high { 1.0 } else { 0.0 };
    if bins.is_empty() || value <= bins[0].lo {
        return 0.0;
    }
    let gap = if width > 0.0 { 6.0 } else { 0.0 };
    let width = width.max(1.0);
    let bar = ((width - gap * (bins.len() - 1) as f64) / bins.len() as f64).max(0.0);
    for (i, b) in bins.iter().enumerate() {
        let end = b.hi.unwrap_or(bounds.max + 1.0);
        if value < end || (high && value == end) {
            return (i as f64 * (bar + gap)
                + ((value - b.lo) / (end - b.lo).max(1.0)).clamp(0.0, 1.0) * bar)
                / width;
        }
    }
    1.0
}
pub fn value_at(bins: &[Bin], bounds: Bounds, position: f64, high: bool, width: f64) -> f64 {
    if bins.is_empty() {
        return if high { bounds.max } else { bounds.min };
    }
    let gap = if width > 0.0 { 6.0 } else { 0.0 };
    let width = width.max(1.0);
    let bar = ((width - gap * (bins.len() - 1) as f64) / bins.len() as f64).max(0.0);
    let pixel = (position * width).clamp(0.0, width);
    let i = ((pixel / (bar + gap).max(1.0)).floor() as usize).min(bins.len() - 1);
    let b = &bins[i];
    let end = b.hi.unwrap_or(bounds.max + 1.0);
    let offset = pixel - i as f64 * (bar + gap);
    if offset > bar && i < bins.len() - 1 {
        return if high {
            end.ceil() - 1.0
        } else {
            bins[i + 1].lo.ceil()
        };
    }
    let boundary = b.lo + (offset / bar.max(1.0)).clamp(0.0, 1.0) * (end - b.lo).max(1.0);
    ((boundary + 0.5).floor() - if high { 1.0 } else { 0.0 }).clamp(bounds.min, bounds.max)
}
pub fn select_bin(bin: &Bin, bounds: Bounds) -> Bounds {
    let span = 50.0_f64.min(bounds.max - bounds.min);
    let mut min = bin.lo.ceil().max(bounds.min);
    let mut max = (bin.hi.unwrap_or(bounds.max + 1.0).ceil() - 1.0).min(bounds.max);
    if max - min < span {
        max = min + span
    }
    if max > bounds.max {
        max = bounds.max;
        min = (max - span).max(bounds.min)
    }
    Bounds { min, max }
}
pub fn level_at(xp: f64, bands: &[LevelBand]) -> f64 {
    bands
        .iter()
        .take_while(|b| xp >= b.experience)
        .last()
        .map_or(0.0, |b| b.level)
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn cold_auxiliary_seed_and_publication_age_do_not_become_false_fresh_responses() {
        assert!(!InitialReply::default().has_response());
        assert!(
            !InitialReply {
                publication_stale: true,
                ..Default::default()
            }
            .has_response()
        );
        assert!(
            InitialReply {
                status: 503,
                retry_after: 3,
                ..Default::default()
            }
            .has_response()
        );
        let reply = InitialReply {
            body: Some(json!({"mode":"pve"})),
            publication_stale: true,
            generated_at: 1234.0,
            ..Default::default()
        };
        assert!(reply.has_response());
        assert!(!reply.stale);
        let restored: InitialReply =
            serde_json::from_str(&serde_json::to_string(&reply).unwrap()).unwrap();
        assert!(restored.publication_stale);
        assert!(!restored.stale);
        assert_eq!(restored.generated_at, 1234.0);
    }
    #[test]
    fn persistent_identity_checks_each_url_dimension_and_keeps_nullable_legacy_empty_counts() {
        let url =
            "/api/average?mode=pve&statistic=median&period=90d&dimension=pmc_raids&metric=kd_ratio";
        let base = json!({"mode":"pve","cycleId":"persistent","statistic":"median","period":"90d","dimension":"pmc_raids","metric":"kd_ratio","averages":null,"metricCounts":{},"buckets":[]});
        assert_eq!(matches(url, &base), Some(true));
        assert_eq!(sample_count(Some(&base)), Some(0.0));
        assert_eq!(sample_count(None), None);
        for (field, wrong) in [
            ("mode", "regular"),
            ("cycleId", "season"),
            ("statistic", "trimmed_mean"),
            ("period", "all"),
            ("dimension", "hours"),
            ("metric", "players"),
        ] {
            let mut bad = base.clone();
            bad[field] = json!(wrong);
            assert_eq!(matches(url, &bad), Some(false), "{field}");
            bad.as_object_mut().unwrap().remove(field);
            assert_eq!(matches(url, &bad), Some(false), "missing {field}");
        }
        let metrics = json!({"mode":"pve","cycleId":"persistent","statistic":"median","period":"90d","series":crate::persistent::state::OVERLAY.into_iter().map(|m|(m,Vec::<Value>::new())).collect::<std::collections::BTreeMap<_,_>>()});
        assert_eq!(
            matches(
                "/api/average/metrics?mode=pve&statistic=median&period=90d",
                &metrics
            ),
            Some(true)
        );
        let mut missing = metrics;
        missing["series"].as_object_mut().unwrap().remove("deaths");
        assert_eq!(
            matches(
                "/api/average/metrics?mode=pve&statistic=median&period=90d",
                &missing
            ),
            Some(false)
        );
    }
    #[test]
    fn pooled_histogram_preserves_weighted_sums_and_inclusive_geometry() {
        let body = Some(
            json!({"buckets":[{"lo":0,"hi":50,"n":2,"sum":100},{"lo":50,"hi":100,"n":3,"sum":3}]}),
        );
        let bins = histogram(&body, 36);
        assert_eq!(bins.len(), 1);
        assert_eq!(bins[0].sum / bins[0].n, 20.6);
        let bounds = Bounds {
            min: 0.0,
            max: 99.0,
        };
        let selected = select_bin(&bins[0], bounds);
        assert_eq!(selected.min, 0.0);
        assert_eq!(selected.max, 99.0);
        assert_eq!(value_at(&bins, bounds, 1.0, true, 360.0), 99.0);
        assert_eq!(position(&bins, bounds, 99.0, true, 360.0), 1.0);
    }
    #[test]
    fn seasonal_identity_rejects_old_cycle_and_mismatched_overlay_period() {
        let s = PersistentState::read_for_cycle("seasonal", "cycle-two", "period=90d").unwrap();
        let urls = s.requests();
        let mut body = serde_json::json!({"mode":"seasonal","cycleId":"cycle-two","statistic":"trimmed_mean","period":"90d","dimension":"hours","metric":"players","averages":null,"metricCounts":{},"buckets":[]});
        assert_eq!(matches(&urls[0], &body), Some(true));
        body["cycleId"] = serde_json::json!("cycle-one");
        assert_eq!(matches(&urls[0], &body), Some(false));
        body["cycleId"] = serde_json::json!("cycle-two");
        body["mode"] = serde_json::json!("regular");
        assert_eq!(matches(&urls[0], &body), Some(false));
        let mut series = serde_json::json!({"mode":"seasonal","cycleId":"cycle-two","statistic":"trimmed_mean","period":"all","series":super::super::state::OVERLAY.into_iter().map(|m|(m,Vec::<serde_json::Value>::new())).collect::<std::collections::BTreeMap<_,_>>()});
        assert_eq!(matches(&urls[3], &series), Some(true));
        series["period"] = serde_json::json!("90d");
        assert_eq!(matches(&urls[3], &series), Some(false));
    }
}
