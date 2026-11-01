// Match the existing ChartCrosshair DOM correction, without changing chart data.
#[derive(Clone, Copy, Debug)]
struct Rect {
    left: f64,
    right: f64,
    top: f64,
    bottom: f64,
}
fn shift(x: f64, width: f64, chart_width: f64) -> f64 {
    if x < 2.0 {
        2.0 - x
    } else if x + width > chart_width - 2.0 {
        chart_width - 2.0 - x - width
    } else {
        0.0
    }
}
fn overlaps(a: Rect, b: Rect) -> bool {
    a.left < b.right + 3.0
        && a.right + 3.0 > b.left
        && a.top < b.bottom + 3.0
        && a.bottom + 3.0 > b.top
}
#[cfg(feature = "hydrate")]
mod browser {
    use super::*;
    use wasm_bindgen::{JsCast, JsValue, closure::Closure};
    use web_sys::Element;
    fn style(element: &Element, opacity: &str) {
        if let Ok(style) = js_sys::Reflect::get(element, &JsValue::from_str("style")) {
            let _ = js_sys::Reflect::set(
                &style,
                &JsValue::from_str("opacity"),
                &JsValue::from_str(opacity),
            );
        }
    }
    fn elements(svg: &Element, selector: &str, limit: u32) -> Vec<Element> {
        let Ok(nodes) = svg.query_selector_all(selector) else {
            return Vec::new();
        };
        (0..nodes.length().min(limit))
            .filter_map(|i| nodes.item(i)?.dyn_into::<Element>().ok())
            .collect()
    }
    fn rect(element: &Element) -> Rect {
        let box_ = element.get_bounding_client_rect();
        Rect {
            left: box_.left(),
            right: box_.right(),
            top: box_.top(),
            bottom: box_.bottom(),
        }
    }
    fn adjust(svg: &Element, width: f64, visible: bool) {
        let labels = elements(svg, ".chart-crosshair text", 2);
        for label in &labels {
            let _ = label.remove_attribute("transform");
            let box_ = (|| -> Option<(f64, f64)> {
                let get_box = js_sys::Reflect::get(label, &JsValue::from_str("getBBox"))
                    .ok()?
                    .dyn_into::<js_sys::Function>()
                    .ok()?;
                let value = get_box.call0(label).ok()?;
                let x = js_sys::Reflect::get(&value, &JsValue::from_str("x"))
                    .ok()?
                    .as_f64()?;
                let width = js_sys::Reflect::get(&value, &JsValue::from_str("width"))
                    .ok()?
                    .as_f64()?;
                (x.is_finite() && width.is_finite()).then_some((x, width))
            })();
            if let Some((x, label_width)) = box_ {
                let _ = label.set_attribute(
                    "transform",
                    &format!("translate({} 0)", shift(x, label_width, width)),
                );
            }
        }
        let boxes = labels.iter().map(rect).collect::<Vec<_>>();
        for tick in elements(svg, "[data-chart-tick]", 128) {
            style(
                &tick,
                if visible && boxes.iter().any(|b| overlaps(rect(&tick), *b)) {
                    "0"
                } else {
                    "1"
                },
            );
        }
    }
    pub struct Adjustment {
        svg: Element,
        observer: Option<web_sys::ResizeObserver>,
        _observer_callback: Closure<dyn FnMut(js_sys::Array)>,
        frame: Option<i32>,
        _frame_callback: Closure<dyn FnMut(f64)>,
    }
    impl Drop for Adjustment {
        fn drop(&mut self) {
            if let Some(observer) = &self.observer {
                observer.disconnect()
            }
            if let Some(window) = web_sys::window()
                && let Some(frame) = self.frame
            {
                let _ = window.cancel_animation_frame(frame);
            }
            for tick in elements(&self.svg, "[data-chart-tick]", 128) {
                style(&tick, "1")
            }
        }
    }
    pub fn watch(svg: &Element, width: f64, visible: bool) -> Adjustment {
        adjust(svg, width, visible);
        let observed = svg.clone();
        let observer_callback =
            Closure::wrap(
                Box::new(move |_: js_sys::Array| adjust(&observed, width, visible))
                    as Box<dyn FnMut(js_sys::Array)>,
            );
        let observer =
            web_sys::ResizeObserver::new(observer_callback.as_ref().unchecked_ref()).ok();
        if let Some(observer) = &observer {
            observer.observe(svg)
        }
        let rendered = svg.clone();
        let frame_callback = Closure::wrap(
            Box::new(move |_: f64| adjust(&rendered, width, visible)) as Box<dyn FnMut(f64)>,
        );
        let frame = web_sys::window().and_then(|w| {
            w.request_animation_frame(frame_callback.as_ref().unchecked_ref())
                .ok()
        });
        Adjustment {
            svg: svg.clone(),
            observer,
            _observer_callback: observer_callback,
            frame,
            _frame_callback: frame_callback,
        }
    }
}
#[cfg(feature = "hydrate")]
pub use browser::{Adjustment, watch};
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn long_crosshair_labels_shift_inside_chart_and_only_nearby_ticks_hide() {
        assert_eq!(shift(-80.0, 100.0, 760.0), 82.0);
        assert_eq!(shift(720.0, 110.0, 760.0), -72.0);
        assert_eq!(shift(250.0, 120.0, 760.0), 0.0);
        let label = Rect {
            left: 2.0,
            right: 150.0,
            top: 20.0,
            bottom: 36.0,
        };
        assert!(overlaps(
            Rect {
                left: 145.0,
                right: 160.0,
                top: 36.0,
                bottom: 50.0
            },
            label
        ));
        assert!(!overlaps(
            Rect {
                left: 153.0,
                right: 170.0,
                top: 20.0,
                bottom: 36.0
            },
            label
        ));
    }
}
