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
    #[serde(default = "persistent_cycle")]
    pub cycle_id: String,
    pub statistic: String,
    pub period: String,
    pub dimension: String,
    pub metric: String,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub params: Params,
    pub invalid: bool,
}
fn persistent_cycle() -> String {
    "persistent".into()
}
impl PersistentState {
    pub fn read(mode: &str, query: &str) -> Result<Self, String> {
        let cycle = if mode == "seasonal" {
            Params::parse(query).get("cycle").unwrap_or("").to_string()
        } else {
            persistent_cycle()
        };
        Self::read_for_cycle(mode, &cycle, query)
    }
    pub fn read_for_cycle(mode: &str, cycle: &str, query: &str) -> Result<Self, String> {
        if !["pve", "regular", "seasonal"].contains(&mode) {
            return Err("Invalid persistent population mode".into());
        }
        let mut params = Params::parse(query);
        if mode == "seasonal" {
            if cycle.is_empty()
                || cycle == "persistent"
                || params.0.iter().filter(|(k, _)| k == "cycle").count() > 1
                || params
                    .get("cycle")
                    .is_some_and(|value| !value.is_empty() && value != cycle)
            {
                return Err("Invalid Seasonal cycle".into());
            }
            params.set("cycle", cycle);
        }
        let raw_min = params.get("min").unwrap_or("");
        let raw_max = params.get("max").unwrap_or("");
        let min = number(raw_min);
        let max = number(raw_max);
        let invalid = (!trim(raw_min).is_empty() && min.is_none())
            || (!trim(raw_max).is_empty() && max.is_none())
            || min.zip(max).is_some_and(|(a, b)| a > b);
        Ok(Self {
            mode: mode.into(),
            cycle_id: if mode == "seasonal" {
                cycle.into()
            } else {
                persistent_cycle()
            },
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
        let seasonal = self.mode == "seasonal";
        let mut q = Params::default();
        if seasonal {
            q.set("cycle", &self.cycle_id)
        } else {
            q.set("mode", &self.mode)
        }
        for (k, v) in [
            ("statistic", &self.statistic),
            ("period", &self.period),
            ("dimension", &self.dimension),
            ("metric", &self.metric),
        ] {
            q.set(k, v)
        }
        let path = if seasonal {
            "/api/seasonal/average"
        } else {
            "/api/average"
        };
        let context = format!("{path}?{}", q.query());
        for (k, v) in [("min", self.min), ("max", self.max)] {
            if let Some(v) = v {
                q.set(k, &v.to_string())
            }
        }
        let selected = format!("{path}?{}", q.query());
        let mut metrics = Params::default();
        metrics.set("mode", &self.mode);
        metrics.set("statistic", &self.statistic);
        metrics.set("period", if seasonal { "all" } else { &self.period });
        if seasonal {
            metrics.set("cycle", &self.cycle_id)
        }
        let mut aux = Params::default();
        aux.set("mode", &self.mode);
        if seasonal {
            aux.set("cycle", &self.cycle_id)
        }
        let achievements = format!("/api/average/achievements?{}", aux.query());
        aux.set("cycle", &self.cycle_id);
        [
            selected,
            context,
            format!("/api/progression/average?{}", aux.query()),
            format!("/api/average/metrics?{}", metrics.query()),
            achievements,
        ]
    }
    pub fn href(&self) -> String {
        let query = self.params.query();
        format!(
            "/population/{}{}{}",
            if self.mode == "seasonal" {
                "pvp-season"
            } else {
                &self.mode
            },
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
    #[test]
    fn seasonal_cycle_and_period_contract_keeps_all_five_requests_isolated() {
        let mut s = PersistentState::read_for_cycle(
            "seasonal",
            "fixture-2",
            "statistic=median&period=90d&min=0x10&unknown=one&unknown=two",
        )
        .unwrap();
        assert_eq!(s.cycle_id, "fixture-2");
        assert!(s.href().starts_with("/population/pvp-season?"));
        let urls = s.requests();
        for url in &urls {
            assert!(url.contains("cycle=fixture-2"), "{url}");
        }
        assert!(urls[0].starts_with("/api/seasonal/average?"));
        assert!(urls[0].contains("period=90d"));
        assert!(urls[0].contains("min=16"));
        assert!(!urls[1].contains("min="));
        assert!(urls[3].contains("period=all"));
        s.sync();
        assert!(s.href().contains("unknown=one&unknown=two"));
        assert!(PersistentState::read_for_cycle("seasonal", "fixture-2", "cycle=other").is_err());
        assert!(
            PersistentState::read_for_cycle(
                "seasonal",
                "fixture-2",
                "cycle=fixture-2&cycle=fixture-2"
            )
            .is_err()
        );
        assert!(PersistentState::read_for_cycle("seasonal", "fixture-2", "cycle=").is_ok());
        assert!(PersistentState::read("seasonal", "").is_err());
        let raw = PersistentState::read_for_cycle(
            "seasonal",
            "fixture-2",
            "?statistic=median&period=90d",
        )
        .unwrap();
        assert_eq!(raw.statistic, "trimmed_mean");
        assert_eq!(raw.period, "90d");
    }
}
