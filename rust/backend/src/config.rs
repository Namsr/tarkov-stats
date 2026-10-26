use chrono::{DateTime, Local, NaiveDate, NaiveDateTime};
use std::collections::HashMap;
use std::env;
use url::Url;

pub fn trim(value: &str) -> &str {
    value.trim_matches(|ch: char| matches!(ch, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'))
}

pub fn cycle(value: &str) -> Option<String> {
    let value = trim(value);
    (!value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .enumerate()
            .all(|(i, ch)| ch.is_ascii_alphanumeric() || (i > 0 && b"._-".contains(&ch))))
    .then(|| value.into())
}

pub fn timestamp(value: &str) -> Option<i64> {
    if value.is_empty() {
        return None;
    }
    let value = trim(value);
    if let Ok(number) = value.parse::<f64>()
        && number.is_finite()
        && number > 0.0
    {
        let millis = if number < 1_000_000_000_000.0 {
            number * 1000.0
        } else {
            number
        };
        if millis <= i64::MAX as f64 {
            return Some(millis.round() as i64);
        }
    }
    let parsed = DateTime::parse_from_rfc3339(value)
        .or_else(|_| DateTime::parse_from_rfc2822(value))
        .ok()
        .map(|d| d.timestamp_millis())
        .or_else(|| {
            NaiveDate::parse_from_str(value, "%Y-%m-%d")
                .ok()
                .and_then(|d| d.and_hms_opt(0, 0, 0))
                .map(|d| d.and_utc().timestamp_millis())
        })
        .or_else(|| {
            [
                "%Y-%m-%dT%H:%M:%S%.f",
                "%Y-%m-%d %H:%M:%S%.f",
                "%Y-%m-%dT%H:%M",
            ]
            .iter()
            .find_map(|format| NaiveDateTime::parse_from_str(value, format).ok())
            .and_then(|d| d.and_local_timezone(Local).earliest())
            .map(|d| d.timestamp_millis())
        });
    parsed.filter(|value| *value > 0)
}

#[derive(Clone)]
pub struct Config {
    pub cycle: Option<String>,
    ready: bool,
    starts: i64,
    ends: Option<i64>,
    json_feed: bool,
}
impl Config {
    pub fn from_env() -> Self {
        Self::from_map(&env::vars().collect())
    }
    pub fn from_map(values: &HashMap<String, String>) -> Self {
        let get = |key: &str| values.get(key).map(String::as_str);
        let cycle = get("SEASONAL_CYCLE_ID").and_then(cycle);
        let starts = get("SEASONAL_STARTS_AT").and_then(timestamp);
        let ends = get("SEASONAL_ENDS_AT").and_then(timestamp);
        let valid_ends = get("SEASONAL_ENDS_AT").is_none_or(|raw| raw.is_empty() || ends.is_some())
            && ends.zip(starts).is_none_or(|(end, start)| end > start);
        let source = get("SEASONAL_COLLECTION_SOURCE");
        let operator = source.is_none_or(|source| trim(source).is_empty() || source == "operator");
        let json_feed = source == Some("json_feed");
        let contract = matches!(
            get("SEASONAL_UPSTREAM_CONTRACT"),
            Some("game_mode" | "profile_section" | "direct_profile")
        );
        let template = get("SEASONAL_PROFILE_URL_TEMPLATE").unwrap_or("");
        let profile_url = template.contains("{aid}")
            && valid_url(
                &template
                    .replace("{mode}", "pvp-season")
                    .replace("{aid}", "1"),
                None,
            );
        let json_ready = !json_feed
            || (get("SEASONAL_UPSTREAM_FIXTURE_CONFIRMED") == Some("true")
                && get("SEASONAL_PROFILE_UPDATED_URL")
                    .is_some_and(|url| valid_url(url, Some("updated.json")))
                && get("SEASONAL_PROFILE_INDEX_URL")
                    .is_some_and(|url| valid_url(url, Some("index.json"))));
        let ready = cycle.is_some()
            && starts.is_some()
            && valid_ends
            && contract
            && (operator || json_feed)
            && profile_url
            && json_ready
            && get("SEASONAL_ENABLED") == Some("true");
        Self {
            cycle,
            ready,
            starts: starts.unwrap_or(0),
            ends,
            json_feed,
        }
    }
    pub fn ready(&self, cycle: &str, now: i64) -> bool {
        self.ready
            && self.cycle.as_deref() == Some(cycle)
            && (!self.json_feed || (self.starts <= now && self.ends.is_none_or(|end| end >= now)))
    }
}

fn valid_url(value: &str, path: Option<&str>) -> bool {
    Url::parse(value).is_ok_and(|url| {
        url.scheme() == "https"
            && url.host_str() == Some("players.tarkov.dev")
            && url.username().is_empty()
            && url.password().is_none_or(str::is_empty)
            && path.is_none_or(|path| {
                url.path()
                    .trim_end_matches('/')
                    .ends_with(&format!("/{path}"))
            })
    })
}

pub fn player_id(value: &str) -> Option<i64> {
    let value = trim(value);
    let aid = |digits: &str| {
        (1..=15)
            .contains(&digits.len())
            .then_some(digits)
            .filter(|digits| digits.bytes().all(|ch| ch.is_ascii_digit()))
            .and_then(|digits| digits.parse::<i64>().ok())
            .filter(|aid| *aid > 0)
    };
    let lower = value.to_ascii_lowercase();
    for (position, _) in lower.match_indices("players/") {
        let tail = &lower[position + 8..];
        for mode in ["regular/", "pve/", "arena/", "pvp-season/"] {
            if let Some(tail) = tail.strip_prefix(mode) {
                let n = tail.bytes().take_while(u8::is_ascii_digit).count();
                if tail.as_bytes().get(n).is_none_or(|ch| b"/?#".contains(ch))
                    && let Some(aid) = aid(&tail[..n])
                {
                    return Some(aid);
                }
            }
        }
    }
    aid(value)
}

pub fn query(raw: &str) -> HashMap<String, String> {
    let mut values = HashMap::new();
    for (key, value) in url::form_urlencoded::parse(raw.as_bytes()) {
        values
            .entry(key.into_owned())
            .or_insert_with(|| value.into_owned());
    }
    values
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn query_uses_first_decoded_value() {
        let q = query("aid=&aid=123&%63ycle=s+1&revision=a%2Bb");
        assert_eq!(q["aid"], "");
        assert_eq!(q["cycle"], "s 1");
        assert_eq!(q["revision"], "a+b");
    }
    #[test]
    fn player_ids_preserve_links_trimming_and_digit_limit() {
        assert_eq!(player_id(" \u{feff}123 "), Some(123));
        assert_eq!(
            player_id("https://tarkov.dev/PLAYERS/PVP-SEASON/123?x"),
            Some(123)
        );
        assert_eq!(player_id("123x"), None);
        assert_eq!(player_id("1234567890123456"), None);
        assert_eq!(
            player_id("players/regular/1234567890123456 players/pve/44"),
            Some(44)
        );
    }
    #[test]
    fn timestamps_accept_supported_configuration_formats() {
        assert_eq!(timestamp("2026-07-01T00:00:00Z"), timestamp("1782864000"));
        assert_eq!(timestamp("2026-07-01"), timestamp("1782864000000"));
        assert_eq!(timestamp("invalid"), None);
    }
    #[test]
    fn operator_and_json_rollout_keep_different_time_gates() {
        let mut values: HashMap<String, String> = [
            ("SEASONAL_ENABLED", "true"),
            ("SEASONAL_CYCLE_ID", "s1"),
            ("SEASONAL_STARTS_AT", "2026-07-01"),
            ("SEASONAL_UPSTREAM_CONTRACT", "game_mode"),
            (
                "SEASONAL_PROFILE_URL_TEMPLATE",
                "https://players.tarkov.dev/{mode}/{aid}.json",
            ),
        ]
        .into_iter()
        .map(|(k, v)| (k.into(), v.into()))
        .collect();
        assert!(Config::from_map(&values).ready("s1", 1));
        values.insert("SEASONAL_COLLECTION_SOURCE".into(), "json_feed".into());
        assert!(!Config::from_map(&values).ready("s1", 1));
    }
}
