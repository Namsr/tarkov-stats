use crate::state::{Params, number, trim};
use serde::{Deserialize, Serialize};
pub const METRICS: [&str; 14] = [
    "players",
    "kd_ratio",
    "pmc_kd_ratio",
    "survival_rate",
    "kills_per_raid",
    "total_raids",
    "pmc_raids",
    "total_kills",
    "killed_pmc",
    "deaths",
    "prestige",
    "level",
    "longest_win_streak",
    "achv_count",
];
pub const OVERLAY: [&str; 6] = [
    "kd_ratio",
    "survival_rate",
    "kills_per_raid",
    "total_kills",
    "deaths",
    "total_raids",
];
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PersistentState {
    pub mode: String,
    pub statistic: String,
    pub period: String,
    pub dimension: String,
    pub metric: String,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub params: Params,
    pub invalid: bool,
}
impl PersistentState {
    pub fn read(mode: &str, query: &str) -> Result<Self, String> {
        if !["pve", "regular"].contains(&mode) {
            return Err("Invalid persistent population mode".into());
        }
        let params = Params::parse(query);
        let raw_min = params.get("min").unwrap_or("");
        let raw_max = params.get("max").unwrap_or("");
        let min = number(raw_min);
        let max = number(raw_max);
        let invalid = (!trim(raw_min).is_empty() && min.is_none())
            || (!trim(raw_max).is_empty() && max.is_none())
            || min.zip(max).is_some_and(|(a, b)| a > b);
        Ok(Self {
            mode: mode.into(),
            statistic: if params.get("statistic") == Some("median") {
                "median"
            } else {
                "trimmed_mean"
            }
            .into(),
            period: if params.get("period") == Some("90d") {
                "90d"
            } else {
                "all"
            }
            .into(),
            dimension: if params.get("dimension") == Some("pmc_raids") {
                "pmc_raids"
            } else {
                "hours"
            }
            .into(),
            metric: params
                .get("metric")
                .filter(|v| METRICS.contains(v))
                .unwrap_or("players")
                .into(),
            min,
            max,
            invalid,
            params,
        })
    }
    pub fn sync(&mut self) {
        for (key, value) in [
            ("statistic", self.statistic.clone()),
            ("period", self.period.clone()),
            ("dimension", self.dimension.clone()),
            ("metric", self.metric.clone()),
        ] {
            if (key == "statistic" && value == "trimmed_mean")
                || (key == "period" && value == "all")
            {
                self.params.remove(key)
            } else {
                self.params.set(key, &value)
            }
        }
        for (key, value) in [("min", self.min), ("max", self.max)] {
            if let Some(v) = value {
                self.params.set(key, &v.to_string())
            } else {
                self.params.remove(key)
            }
        }
        self.invalid = false;
    }
    pub fn requests(&self) -> [String; 5] {
        let mut q = Params::default();
        for (k, v) in [
            ("mode", self.mode.as_str()),
            ("statistic", &self.statistic),
            ("period", &self.period),
            ("dimension", &self.dimension),
            ("metric", &self.metric),
        ] {
            q.set(k, v)
        }
        let context = format!("/api/average?{}", q.query());
        for (k, v) in [("min", self.min), ("max", self.max)] {
            if let Some(v) = v {
                q.set(k, &v.to_string())
            }
        }
        let selected = format!("/api/average?{}", q.query());
        let metrics = format!(
            "/api/average/metrics?mode={}&statistic={}&period={}",
            self.mode, self.statistic, self.period
        );
        [
            selected,
            context,
            format!(
                "/api/progression/average?mode={}&cycle=persistent",
                self.mode
            ),
            metrics,
            format!("/api/average/achievements?mode={}", self.mode),
        ]
    }
    pub fn href(&self) -> String {
        let query = self.params.query();
        format!(
            "/population/{}{}{}",
            self.mode,
            if query.is_empty() { "" } else { "?" },
            query
        )
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn raw_query_defaults_duplicates_unknown_and_ranges_are_preserved() {
        let mut s = PersistentState::read(
            "pve",
            "statistic=median&statistic=bad&period=90d&unknown=one&unknown=two&min=0x10&max=20",
        )
        .unwrap();
        assert_eq!(s.statistic, "median");
        assert_eq!(s.min, Some(16.0));
        assert!(!s.invalid);
        assert!(s.requests()[0].contains("min=16"));
        assert!(!s.requests()[1].contains("min="));
        s.sync();
        assert!(s.params.query().contains("unknown=one&unknown=two"));
        assert_eq!(
            PersistentState::read("pve", "?statistic=median")
                .unwrap()
                .statistic,
            "trimmed_mean"
        );
        assert!(PersistentState::read("arena", "").is_err());
        assert!(PersistentState::read("pve", "min=3&max=1").unwrap().invalid);
    }
}
