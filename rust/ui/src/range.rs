// Shared SSR/WASM geometry, ported from lib/arena/average-range.ts.
use serde::{Deserialize, Serialize};
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct Bounds {
    pub min: f64,
    pub max: f64,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct Bucket {
    pub min: f64,
    pub max: Option<f64>,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct Selection {
    pub low: f64,
    pub high: f64,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Edge {
    Low,
    High,
}
fn clamp(value: f64, bounds: Bounds) -> f64 {
    value.clamp(bounds.min, bounds.max)
}
pub fn valid(bounds: Bounds) -> bool {
    bounds.min.is_finite() && bounds.max.is_finite() && bounds.min >= 0.0 && bounds.max > bounds.min
}
fn padding(bounds: Bounds, discrete: bool) -> f64 {
    if discrete {
        1.0
    } else {
        f64::EPSILON.max((bounds.max - bounds.min) / 10000.0)
    }
}
fn visible(buckets: &[Bucket], bounds: Bounds, discrete: bool) -> Vec<(f64, f64)> {
    let end = bounds.max + padding(bounds, discrete);
    buckets
        .iter()
        .map(|bucket| {
            (
                bucket.min.max(bounds.min),
                bucket.max.unwrap_or(end).min(end),
            )
        })
        .filter(|(start, end)| end > start)
        .collect()
}
pub fn selection(bounds: Bounds, low: Option<f64>, high: Option<f64>) -> Selection {
    let low = clamp(low.unwrap_or(bounds.min), bounds);
    let high = clamp(high.unwrap_or(bounds.max), bounds);
    Selection {
        low: low.min(high),
        high: low.max(high),
    }
}
pub fn filter_value(value: f64, bounds: Bounds, edge: Edge) -> String {
    if value
        == if edge == Edge::Low {
            bounds.min
        } else {
            bounds.max
        }
    {
        String::new()
    } else {
        clamp(value, bounds).to_string()
    }
}
pub fn position(
    buckets: &[Bucket],
    bounds: Bounds,
    value: f64,
    edge: Edge,
    discrete: bool,
    chart_width: f64,
    gap: f64,
) -> f64 {
    let visible = visible(buckets, bounds, discrete);
    if visible.is_empty() {
        return 0.0;
    }
    let target = value
        + if edge == Edge::High {
            padding(bounds, discrete)
        } else {
            0.0
        };
    if target <= visible[0].0 {
        return 0.0;
    }
    if target >= visible[visible.len() - 1].1 {
        return 1.0;
    }
    let width = chart_width.max(1.0);
    let gap = if chart_width > 0.0 { gap } else { 0.0 };
    let bar_width = ((width - gap * (visible.len() - 1) as f64) / visible.len() as f64).max(0.0);
    for (index, &(start, end)) in visible.iter().enumerate() {
        if index > 0 && target <= start {
            return (index as f64 * (bar_width + gap) - if edge == Edge::High { gap } else { 0.0 })
                / width;
        }
        if target < end || (edge == Edge::High && target == end) {
            let fraction = ((target - start) / (end - start)).clamp(0.0, 1.0);
            return (index as f64 * (bar_width + gap) + fraction * bar_width) / width;
        }
    }
    1.0
}
pub fn value_at(
    buckets: &[Bucket],
    bounds: Bounds,
    position: f64,
    edge: Edge,
    discrete: bool,
    chart_width: f64,
    gap: f64,
) -> f64 {
    let visible = visible(buckets, bounds, discrete);
    if visible.is_empty() {
        return if edge == Edge::Low {
            bounds.min
        } else {
            bounds.max
        };
    }
    let padding = padding(bounds, discrete);
    let width = chart_width.max(1.0);
    let gap = if chart_width > 0.0 { gap } else { 0.0 };
    let bar_width = ((width - gap * (visible.len() - 1) as f64) / visible.len() as f64).max(0.0);
    let cell_width = bar_width + gap;
    let pixel = (position * width).clamp(0.0, width);
    let index = ((pixel / cell_width.max(1.0)).floor() as usize).min(visible.len() - 1);
    let (start, end) = visible[index];
    let offset = pixel - index as f64 * cell_width;
    if offset > bar_width && index < visible.len() - 1 {
        let boundary = if edge == Edge::Low {
            visible[index + 1].0
        } else {
            end
        };
        return clamp(
            if discrete && edge == Edge::High {
                boundary.round() - 1.0
            } else if edge == Edge::High {
                boundary - padding
            } else {
                boundary
            },
            bounds,
        );
    }
    let fraction = (offset / bar_width.max(1.0)).clamp(0.0, 1.0);
    let boundary = start + fraction * (end - start);
    clamp(
        if discrete && edge == Edge::High {
            boundary.round() - 1.0
        } else if discrete {
            boundary.round()
        } else if edge == Edge::High {
            boundary - padding
        } else {
            boundary
        },
        bounds,
    )
}
pub fn slice(bucket: Bucket, selection: Selection, bounds: Bounds, discrete: bool) -> (f64, f64) {
    let padding = padding(bounds, discrete);
    let start = bucket.min.max(bounds.min);
    let end = bucket
        .max
        .unwrap_or(bounds.max + padding)
        .min(bounds.max + padding);
    let width = (end - start).max(f64::EPSILON);
    let selected_start = start.max(selection.low);
    let selected_end = end.min(if selection.high >= bounds.max {
        end
    } else {
        selection.high + padding
    });
    let overlap = (selected_end - selected_start).max(0.0);
    (
        ((selected_start - start) / width * 100.0).clamp(0.0, 100.0),
        (overlap / width * 100.0).clamp(0.0, 100.0),
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn inclusive_discrete_high_edge_and_open_top_do_not_drop_last_match() {
        let bounds = Bounds {
            min: 10.0,
            max: 100.0,
        };
        let picked = selection(bounds, Some(20.0), Some(29.0));
        assert_eq!(
            slice(
                Bucket {
                    min: 20.0,
                    max: Some(30.0)
                },
                picked,
                bounds,
                true
            ),
            (0.0, 100.0)
        );
        assert_eq!(
            slice(
                Bucket {
                    min: 90.0,
                    max: None
                },
                selection(bounds, None, None),
                bounds,
                true
            ),
            (0.0, 100.0)
        );
    }
    #[test]
    fn reversed_outside_filters_remain_clamped_and_edges_restore_open_url() {
        let bounds = Bounds {
            min: 0.0,
            max: 100.0,
        };
        let picked = selection(bounds, Some(200.0), Some(-10.0));
        assert_eq!(picked.low, 0.0);
        assert_eq!(picked.high, 100.0);
        assert_eq!(filter_value(100.0, bounds, Edge::High), "");
        assert_eq!(filter_value(20.0, bounds, Edge::High), "20");
        assert!(!valid(Bounds { min: 1.0, max: 1.0 }));
        assert!(!valid(Bounds {
            min: 0.0,
            max: f64::NAN
        }));
    }
    #[test]
    fn equal_width_bars_and_gaps_have_inverse_low_and_high_edges() {
        let bounds = Bounds {
            min: 0.0,
            max: 99.0,
        };
        let buckets = [
            Bucket {
                min: 0.0,
                max: Some(10.0),
            },
            Bucket {
                min: 10.0,
                max: Some(50.0),
            },
            Bucket {
                min: 50.0,
                max: None,
            },
        ];
        for width in [100.0, 360.0, 768.0, 1280.0] {
            for value in [0.0, 5.0, 9.0, 10.0, 25.0, 49.0, 50.0, 75.0, 99.0] {
                for edge in [Edge::Low, Edge::High] {
                    let pos = position(&buckets, bounds, value, edge, true, width, 6.0);
                    let restored = value_at(&buckets, bounds, pos, edge, true, width, 6.0);
                    assert!(
                        (restored - value).abs() < 1e-8,
                        "{width} {value} {edge:?}: {pos} -> {restored}"
                    );
                }
            }
        }
    }
}
