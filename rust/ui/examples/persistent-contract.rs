use serde_json::{Value, json};
use std::io::{self, Read};
use tarkov_ui::{
    persistent::{data, state::PersistentState},
    range::Bounds,
};
fn main() {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input).unwrap();
    let operations: Vec<Value> = serde_json::from_str(&input).unwrap();
    let output=operations.into_iter().map(|op|match op["op"].as_str().unwrap(){
 "bands"=>json!(data::bundled_level_bands()),
"histogram"=>json!(data::histogram(&Some(op["body"].clone()),op["cap"].as_u64().unwrap()as usize)),
 "state"=>{let s=PersistentState::read(op["mode"].as_str().unwrap(),op["query"].as_str().unwrap()).unwrap();json!({"mode":s.mode,"cycleId":s.cycle_id,"statistic":s.statistic,"period":s.period,"dimension":s.dimension,"metric":s.metric,"min":s.min,"max":s.max,"invalid":s.invalid,"requests":s.requests(),"href":s.href()})},
 "range"=>{let bins:Vec<data::Bin>=serde_json::from_value(op["bins"].clone()).unwrap();let bounds:Bounds=serde_json::from_value(op["bounds"].clone()).unwrap();let high=op["high"].as_bool().unwrap();let width=op["width"].as_f64().unwrap();json!({"position":data::position(&bins,bounds,op["value"].as_f64().unwrap(),high,width),"valueAt":data::value_at(&bins,bounds,op["position"].as_f64().unwrap(),high,width),"selection":data::select_bin(&bins[op["index"].as_u64().unwrap()as usize],bounds)})},
 _=>panic!("unknown persistent UI contract operation")}).collect::<Vec<_>>();
    println!("{}", serde_json::to_string(&output).unwrap());
}
