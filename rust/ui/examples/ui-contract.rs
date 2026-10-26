use serde_json::{Value, json};
use std::io::{self, Read};
use tarkov_ui::{
    data,
    range::{self, Bounds, Bucket, Edge},
    state::ArenaState,
};
fn n(value: &Value, key: &str) -> f64 {
    value[key].as_f64().expect("numeric fixture field")
}
fn run(value: &Value) -> Value {
    match value["op"].as_str().unwrap() {
        "format" => json!(data::format_number(
            n(value, "value"),
            value["decimals"].as_u64().unwrap() as usize,
            value["russian"].as_bool().unwrap()
        )),
        "state" => {
            let state = ArenaState::read(value["query"].as_str().unwrap());
            json!({"selected":state.selected,"statistic":state.statistic,"invalid":state.filters[state.selected].invalid(),"request":state.selected_request(),"context":state.context_request()})
        }
        "range" => {
            let bounds: Bounds = serde_json::from_value(value["bounds"].clone()).unwrap();
            let buckets: Vec<Bucket> = serde_json::from_value(value["buckets"].clone()).unwrap();
            let edge = if value["edge"] == "high" {
                Edge::High
            } else {
                Edge::Low
            };
            let discrete = value["discrete"].as_bool().unwrap();
            let width = n(value, "width");
            let gap = n(value, "gap");
            let picked = range::selection(bounds, value["low"].as_f64(), value["high"].as_f64());
            json!({"selection":picked,"position":range::position(&buckets,bounds,n(value,"value"),edge,discrete,width,gap),"valueAt":range::value_at(&buckets,bounds,n(value,"position"),edge,discrete,width,gap),"slices":buckets.iter().map(|bucket|range::slice(*bucket,picked,bounds,discrete)).collect::<Vec<_>>()})
        }
        _ => panic!("unknown fixture operation"),
    }
}
fn main() {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input).unwrap();
    let ops: Vec<Value> = serde_json::from_str(&input).unwrap();
    println!("{}", Value::Array(ops.iter().map(run).collect()));
}
