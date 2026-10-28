use axis_probability::{AXIS_PREDICTION_VERSION, AxisMatch, build_axis_win_probabilities};
use serde::{Deserialize, Serialize};
use std::io::{self, Read};

#[derive(Deserialize)]
struct Input {
    matches: Vec<AxisMatch>,
}
#[derive(Serialize)]
struct Output {
    version: u32,
    predictions: Vec<(f64, axis_probability::AxisWinProbability)>,
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    const MAX_INPUT_BYTES: u64 = 8 * 1024 * 1024;
    let mut input = Vec::new();
    io::stdin()
        .lock()
        .take(MAX_INPUT_BYTES + 1)
        .read_to_end(&mut input)?;
    if input.len() as u64 > MAX_INPUT_BYTES {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "input exceeds 8 MiB").into());
    }
    let input: Input = serde_json::from_slice(&input)?;
    let predictions = build_axis_win_probabilities(&input.matches)?;
    println!(
        "{}",
        serde_json::to_string(&Output {
            version: AXIS_PREDICTION_VERSION,
            predictions
        })?
    );
    Ok(())
}
