use crate::{range::Bucket, state::ArenaState};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ArenaInitial {
    pub state: ArenaState,
    pub selected: Option<Value>,
    pub context: Option<Value>,
    pub overview: Option<Value>,
    #[serde(default)]
    pub meta: InitialMeta,
    #[serde(default)]
    pub seasonal_cycle: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct InitialMeta {
    pub selected_status: u16,
    pub context_status: u16,
    pub selected_stale: bool,
    pub context_stale: bool,
    pub selected_retry_after: u64,
    pub context_retry_after: u64,
    pub selected_generated_at: f64,
    pub context_generated_at: f64,
}
impl Default for InitialMeta {
    fn default() -> Self {
        Self {
            selected_status: 200,
            context_status: 200,
            selected_stale: false,
            context_stale: false,
            selected_retry_after: 5,
            context_retry_after: 5,
            selected_generated_at: 0.0,
            context_generated_at: 0.0,
        }
    }
}
impl ArenaInitial {
    pub fn new(
        state: ArenaState,
        selected: Option<Value>,
        context: Option<Value>,
        overview: Option<Value>,
    ) -> Self {
        Self {
            state,
            selected,
            context,
            overview,
            meta: InitialMeta::default(),
            seasonal_cycle: None,
        }
    }
}
#[derive(Clone, Debug)]
pub struct ChartBucket {
    pub geometry: Bucket,
    pub sample_n: f64,
    pub metric_n: f64,
    pub value: Option<f64>,
}
fn finite(value: &Value) -> Option<f64> {
    value.as_f64().filter(|v| v.is_finite())
}
fn merge(source: &[ChartBucket], threshold: f64) -> Vec<ChartBucket> {
    let mut result: Vec<ChartBucket> = Vec::new();
    let mut cursor = source[0].geometry.min;
    let mut max = None;
    let mut n = 0.0;
    for cell in source {
        max = cell.geometry.max;
        n += cell.sample_n;
        if n >= threshold {
            result.push(ChartBucket {
                geometry: Bucket { min: cursor, max },
                sample_n: n,
                metric_n: n,
                value: Some(n),
            });
            cursor = max.unwrap_or(cursor);
            n = 0.0;
        }
    }
    if n > 0.0 {
        if let Some(last) = result.last_mut() {
            last.geometry.max = max;
            last.sample_n += n;
            last.metric_n = last.sample_n;
            last.value = Some(last.sample_n);
        } else {
            result.push(ChartBucket {
                geometry: Bucket { min: cursor, max },
                sample_n: n,
                metric_n: n,
                value: Some(n),
            });
        }
    }
    result
}
pub fn histogram(payload: &Value, metric: &str, max_bins: usize) -> Vec<ChartBucket> {
    let Some(buckets) = payload["buckets"].as_array() else {
        return Vec::new();
    };
    let mut source: Vec<_> = buckets
        .iter()
        .filter_map(|row| {
            let min = finite(&row["min"])?;
            let max = finite(&row["max"]);
            let n = finite(&row["sampleN"])?;
            (n > 0.0 && (max.is_none() || max.is_some_and(|end| end > min))).then_some(
                ChartBucket {
                    geometry: Bucket { min, max },
                    sample_n: n,
                    metric_n: n,
                    value: Some(n),
                },
            )
        })
        .collect();
    source.sort_by(|a, b| a.geometry.min.total_cmp(&b.geometry.min));
    if source.is_empty() {
        return Vec::new();
    }
    let cap = max_bins.clamp(1, 36);
    let mut threshold = 5.0;
    let mut bins = merge(&source, threshold);
    while bins.len() > cap && bins.len() > 1 {
        threshold = (threshold * 1.5).ceil();
        bins = merge(&source, threshold);
    }
    if metric != "players" {
        for bin in &mut bins {
            let mut count = 0.0;
            let mut weighted = 0.0;
            for row in buckets {
                let Some(min) = finite(&row["min"]) else {
                    continue;
                };
                if min < bin.geometry.min || bin.geometry.max.is_some_and(|max| min >= max) {
                    continue;
                }
                let summary = &row["metrics"][metric];
                let Some(value) = finite(&summary["value"]) else {
                    continue;
                };
                let Some(n) = finite(&summary["count"]).filter(|n| *n > 0.0) else {
                    continue;
                };
                count += n;
                weighted += value * n;
            }
            bin.metric_n = count;
            bin.value = (count > 0.0).then_some(weighted / count);
        }
    }
    bins
}
// Fixed locale and decimal rounding shared by SSR and hydration. Floating-point
// shortest decimal text is rounded like Intl's default halfExpand, not bankers'
// rounding, before grouping; no server Node/Intl runtime is needed.
pub fn format_number(value: f64, decimals: usize, russian: bool) -> String {
    if !value.is_finite() {
        return String::from("\u{2014}");
    }
    let decimals = decimals.min(20);
    let negative = value.is_sign_negative();
    let raw = value.abs().to_string();
    let (integer, fraction) = raw.split_once('.').unwrap_or((raw.as_str(), ""));
    let mut digits: Vec<u8> = integer
        .bytes()
        .chain(fraction.bytes().take(decimals))
        .collect();
    digits.extend(std::iter::repeat_n(
        b'0',
        decimals.saturating_sub(fraction.len()),
    ));
    if fraction
        .as_bytes()
        .get(decimals)
        .is_some_and(|ch| *ch >= b'5')
    {
        let mut index = digits.len();
        loop {
            if index == 0 {
                digits.insert(0, b'1');
                break;
            }
            index -= 1;
            if digits[index] < b'9' {
                digits[index] += 1;
                break;
            }
            digits[index] = b'0';
        }
    }
    let split = digits.len() - decimals;
    let mut result = String::new();
    if negative {
        result.push('-');
    }
    for (index, ch) in digits[..split].iter().enumerate() {
        if index > 0 && (split - index).is_multiple_of(3) {
            result.push(if russian { '\u{00a0}' } else { ',' });
        }
        result.push(char::from(*ch));
    }
    if decimals > 0 {
        result.push(if russian { ',' } else { '.' });
        for ch in &digits[split..] {
            result.push(char::from(*ch));
        }
    }
    result
}
pub fn format_metric(value: Option<f64>, metric: &str, russian: bool) -> String {
    let Some(value) = value.filter(|v| v.is_finite()) else {
        return String::from("\u{2014}");
    };
    let decimals = match metric {
        "win_rate" | "headshot_rate" => 1,
        "damage_per_match" => 0,
        _ => 2,
    };
    let mut result = format_number(value, decimals, russian);
    if matches!(metric, "win_rate" | "headshot_rate") {
        result.push('%');
    }
    result
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn weighted_metric_chart_uses_metric_coverage_and_keeps_player_counts() {
        let payload = json!({"buckets":[{"min":0,"max":10,"sampleN":3,"metrics":{"kd_ratio":{"value":2,"count":2}}},{"min":10,"max":20,"sampleN":3,"metrics":{"kd_ratio":{"value":6,"count":1}}},{"min":20,"max":null,"sampleN":1,"metrics":{"kd_ratio":{"value":null,"count":0}}}]});
        let bars = histogram(&payload, "kd_ratio", 36);
        assert_eq!(bars.len(), 1);
        assert_eq!(bars[0].sample_n, 7.0);
        assert_eq!(bars[0].metric_n, 3.0);
        assert_eq!(bars[0].value, Some(10.0 / 3.0));
        assert!(bars[0].geometry.max.is_none());
        assert_eq!(histogram(&payload, "players", 36)[0].value, Some(7.0));
    }
    #[test]
    fn locale_rounding_matches_decimal_half_expand_and_null_is_not_zero() {
        assert_eq!(format_number(1.005, 2, false), "1.01");
        assert_eq!(format_number(2.675, 2, false), "2.68");
        assert_eq!(format_number(999.999, 2, false), "1,000.00");
        assert_eq!(format_number(1234.5, 1, true), "1\u{00a0}234,5");
        assert_eq!(format_metric(None, "kd_ratio", false), "\u{2014}");
        assert_eq!(format_metric(Some(0.0), "win_rate", false), "0.0%");
    }
}
