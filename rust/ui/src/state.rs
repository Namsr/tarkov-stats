use serde::{Deserialize, Serialize};

pub const MODES: [&str; 5] = [
    "teamFight",
    "lastHero",
    "checkpoint",
    "blastGang",
    "shootOutDuo",
];
pub const METRICS: [&str; 5] = [
    "kd_ratio",
    "win_rate",
    "headshot_rate",
    "kills_per_match",
    "damage_per_match",
];
pub const FIELDS: [&str; 4] = ["minHours", "maxHours", "minMatches", "maxMatches"];

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Params(pub Vec<(String, String)>);
impl Params {
    pub fn parse(query: &str) -> Self {
        Self(
            url::form_urlencoded::parse(query.strip_prefix('?').unwrap_or(query).as_bytes())
                .into_owned()
                .collect(),
        )
    }
    pub fn get(&self, name: &str) -> Option<&str> {
        self.0
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }
    pub fn set(&mut self, key: &str, value: &str) {
        let position = self
            .0
            .iter()
            .position(|(name, _)| name == key)
            .unwrap_or(self.0.len());
        self.remove(key);
        self.0.insert(position, (key.into(), value.into()));
    }
    pub fn remove(&mut self, name: &str) {
        self.0.retain(|(key, _)| key != name);
    }
    pub fn query(&self) -> String {
        url::form_urlencoded::Serializer::new(String::new())
            .extend_pairs(self.0.iter().map(|(k, v)| (k, v)))
            .finish()
    }
}
pub fn trim(value: &str) -> &str {
    value.trim_matches(|ch:char| matches!(ch, '\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}'))
}
pub fn number(value: &str) -> Option<f64> {
    let value = trim(value);
    if value.is_empty() {
        return None;
    }
    let radix = if value.starts_with("0x") || value.starts_with("0X") {
        Some(16)
    } else if value.starts_with("0o") || value.starts_with("0O") {
        Some(8)
    } else if value.starts_with("0b") || value.starts_with("0B") {
        Some(2)
    } else {
        None
    };
    let parsed = if let Some(radix) = radix {
        if value.len() == 2 {
            return None;
        }
        value[2..].chars().try_fold(0.0, |total, ch| {
            ch.to_digit(radix)
                .map(|digit| total * f64::from(radix) + f64::from(digit))
        })?
    } else {
        value.parse::<f64>().ok()?
    };
    (parsed.is_finite() && parsed >= 0.0).then_some(if parsed == 0.0 { 0.0 } else { parsed })
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Filter {
    pub dimension: String,
    pub metric: String,
    pub ranges: [String; 4],
}
impl Default for Filter {
    fn default() -> Self {
        Self {
            dimension: "matches".into(),
            metric: "players".into(),
            ranges: ["".into(), "".into(), "10".into(), "".into()],
        }
    }
}
impl Filter {
    fn read(params: &Params, mode: &str) -> Self {
        let metric = params
            .get(&format!("arena_{mode}_metric"))
            .unwrap_or("players");
        Self {
            dimension: if params.get(&format!("arena_{mode}_dimension")) == Some("hours") {
                "hours"
            } else {
                "matches"
            }
            .into(),
            metric: if metric == "players" || METRICS.contains(&metric) {
                metric
            } else {
                "players"
            }
            .into(),
            ranges: std::array::from_fn(|i| {
                params
                    .get(&format!("arena_{mode}_{}", FIELDS[i]))
                    .unwrap_or(if i == 2 { "10" } else { "" })
                    .into()
            }),
        }
    }
    pub fn invalid(&self) -> bool {
        let values = self.ranges.each_ref().map(|v| number(v));
        self.ranges
            .iter()
            .zip(values)
            .any(|(raw, value)| !trim(raw).is_empty() && value.is_none())
            || [(0, 1), (2, 3)].iter().any(|&(a, b)| {
                values[a]
                    .zip(values[b])
                    .is_some_and(|(low, high)| low > high)
            })
    }
    pub fn request(&self, mode: &str, statistic: &str) -> String {
        let mut params = Params::default();
        for (key, value) in [
            ("mode", "arena"),
            ("arenaMode", mode),
            ("statistic", statistic),
            ("dimension", self.dimension.as_str()),
            ("metric", self.metric.as_str()),
        ] {
            params.set(key, value);
        }
        for (key, raw) in FIELDS.iter().zip(&self.ranges) {
            if let Some(value) = number(raw) {
                params.set(key, &value.to_string());
            }
        }
        format!("/api/average?{}", params.query())
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArenaState {
    pub selected: usize,
    pub statistic: String,
    pub filters: [Filter; 5],
    pub params: Params,
}
impl ArenaState {
    pub fn read(query: &str) -> Self {
        let params = Params::parse(query);
        Self {
            selected: params
                .get("arenaMode")
                .and_then(|mode| MODES.iter().position(|&key| key == mode))
                .unwrap_or(0),
            statistic: if params.get("arenaStatistic") == Some("median") {
                "median"
            } else {
                "trimmed_mean"
            }
            .into(),
            filters: std::array::from_fn(|i| Filter::read(&params, MODES[i])),
            params,
        }
    }
    pub fn select(&mut self, index: usize) {
        if index < MODES.len() {
            self.selected = index;
            self.params.set("arenaMode", MODES[index]);
        }
    }
    pub fn set_statistic(&mut self, statistic: &str) {
        self.statistic = if statistic == "median" {
            "median"
        } else {
            "trimmed_mean"
        }
        .into();
        self.params.set("arenaStatistic", &self.statistic);
    }
    pub fn update(&mut self, filter: Filter) {
        self.params.set("arenaStatistic", &self.statistic);
        let mode = MODES[self.selected];
        self.params
            .set(&format!("arena_{mode}_dimension"), &filter.dimension);
        self.params
            .set(&format!("arena_{mode}_metric"), &filter.metric);
        for (field, raw) in FIELDS.iter().zip(&filter.ranges) {
            let key = format!("arena_{mode}_{field}");
            let value = trim(raw);
            if value.is_empty() {
                self.params.remove(&key);
            } else {
                self.params.set(&key, value);
            }
        }
        self.filters[self.selected] = filter;
    }
    pub fn selected_request(&self) -> String {
        self.filters[self.selected].request(MODES[self.selected], &self.statistic)
    }
    pub fn context_request(&self) -> String {
        Self::context(
            MODES[self.selected],
            &self.statistic,
            &self.filters[self.selected].dimension,
        )
    }
    pub fn context(mode: &str, statistic: &str, dimension: &str) -> String {
        let filter = Filter {
            dimension: dimension.into(),
            ranges: std::array::from_fn(|_| String::new()),
            ..Filter::default()
        };
        filter.request(mode, statistic)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn deep_links_are_read_before_render_and_each_mode_keeps_its_filters() {
        let mut state = ArenaState::read(
            "arenaMode=lastHero&arenaStatistic=median&arena_lastHero_dimension=hours&arena_lastHero_minHours=12&unknown=keep&unknown=again",
        );
        assert_eq!(state.selected, 1);
        assert_eq!(state.statistic, "median");
        assert_eq!(state.filters[1].ranges[0], "12");
        state.select(0);
        assert_eq!(state.filters[0].ranges[2], "10");
        state.select(1);
        assert_eq!(state.filters[1].ranges[0], "12");
        assert!(state.params.query().contains("unknown=keep&unknown=again"));
    }
    #[test]
    fn browser_search_and_bare_queries_restore_the_same_mode_and_first_values() {
        for query in [
            "arenaMode=lastHero&arenaStatistic=median",
            "arenaMode=lastHero&arenaMode=checkpoint&arenaStatistic=median&arenaStatistic=trimmed_mean&arena_lastHero_minHours=12&arena_lastHero_minHours=99&unknown=keep&unknown=again",
            "arena_lastHero_minHours=12&arena_lastHero_minHours=99&arenaMode=lastHero&arenaStatistic=median",
            "arena_lastHero_minHours=&arena_lastHero_minHours=99&arenaMode=lastHero&arenaStatistic=median",
        ] {
            let bare = ArenaState::read(query);
            let browser = ArenaState::read(&format!("?{query}"));
            assert_eq!(browser, bare, "{query}");
            assert_eq!(browser.selected, 1);
            assert_eq!(browser.statistic, "median");
            assert_eq!(browser.params.query(), query);
            if query.contains("minHours=12") {
                assert_eq!(browser.filters[1].ranges[0], "12");
                assert!(browser.selected_request().contains("minHours=12"));
                assert!(!browser.selected_request().contains("minHours=99"));
            } else if query.starts_with("arena_lastHero_minHours=") {
                assert_eq!(browser.filters[1].ranges[0], "");
                assert!(!browser.selected_request().contains("minHours="));
            }
        }
        assert_eq!(Params::parse("?"), Params::default());
        // URLSearchParams removes one prefix only, not literal/encoded key data.
        assert_eq!(
            Params::parse("??arenaMode=lastHero").get("?arenaMode"),
            Some("lastHero")
        );
        assert_eq!(
            Params::parse("?%3FarenaMode=lastHero").get("?arenaMode"),
            Some("lastHero")
        );
    }
    #[test]
    fn first_duplicates_and_invalid_enums_use_existing_ui_defaults() {
        let state = ArenaState::read(
            "arenaMode=invalid&arenaMode=lastHero&arenaStatistic=bad&arena_teamFight_dimension=bad&arena_teamFight_metric=no",
        );
        assert_eq!(state.selected, 0);
        assert_eq!(state.statistic, "trimmed_mean");
        assert_eq!(state.filters[0], Filter::default());
        let mut params = Params::parse("x=1&a=2&a=3&z=4");
        params.set("a", "5");
        assert_eq!(params.query(), "x=1&a=5&z=4");
    }
    #[test]
    fn invalid_ranges_are_visible_and_do_not_become_false_zeroes() {
        let mut filter = Filter::default();
        filter.ranges[0] = "bad".into();
        assert!(filter.invalid());
        filter.ranges[0] = "20".into();
        filter.ranges[1] = "10".into();
        assert!(filter.invalid());
        filter.ranges[0] = "0x8".into();
        assert!(!filter.invalid());
        assert_eq!(number(" -0 "), Some(0.0));
        assert_eq!(number("+0x8"), None);
        assert_eq!(number("Infinity"), None);
        assert_eq!(number("\u{feff}"), None);
    }
    #[test]
    fn initial_selected_and_unfiltered_context_are_distinct() {
        let state = ArenaState::read("");
        assert!(state.selected_request().contains("minMatches=10"));
        assert!(!state.context_request().contains("minMatches"));
        let mut next = state;
        let mut filter = next.filters[0].clone();
        filter.ranges[0] = " 5 ".into();
        next.update(filter);
        assert!(next.params.query().contains("minHours=5"));
        assert!(next.selected_request().contains("minHours=5"));
    }
}
