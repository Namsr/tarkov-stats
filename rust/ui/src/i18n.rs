use serde::{Deserialize, Serialize};
use std::{collections::HashMap, sync::LazyLock};

type Messages = HashMap<String, HashMap<String, String>>;
static MESSAGES: LazyLock<Messages> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../../lib/i18n/messages.json"))
        .expect("checked shared UI dictionary")
});
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Lang {
    En,
    Ru,
}
impl Lang {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::En => "en",
            Self::Ru => "ru",
        }
    }
    pub fn t(self, key: &str) -> String {
        MESSAGES
            .get(self.as_str())
            .and_then(|entries| entries.get(key))
            .or_else(|| MESSAGES.get("en").and_then(|entries| entries.get(key)))
            .cloned()
            .unwrap_or_else(|| key.into())
    }
    pub fn text(self, key: &str, vars: &[(&str, String)]) -> String {
        let text = self.t(key);
        let mut output = String::new();
        let mut rest = text.as_str();
        while let Some(start) = rest.find('{') {
            output.push_str(&rest[..start]);
            let tail = &rest[start + 1..];
            if let Some(end) = tail.find('}') {
                let key = &tail[..end];
                let valid = !key.is_empty()
                    && key
                        .bytes()
                        .all(|ch| ch.is_ascii_alphanumeric() || ch == b'_');
                if let Some((_, value)) = vars.iter().find(|(name, _)| valid && *name == key) {
                    output.push_str(value);
                } else {
                    output.push_str(&rest[start..start + end + 2]);
                }
                rest = &tail[end + 1..];
            } else {
                output.push_str(&rest[start..]);
                rest = "";
                break;
            }
        }
        output.push_str(rest);
        output
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shared_languages_and_fallbacks() {
        assert_eq!(MESSAGES["en"].len(), MESSAGES["ru"].len());
        assert_eq!(Lang::En.t("meta.title"), "Tarkov Stats Comparator");
        assert!(Lang::Ru.t("meta.title").contains("Tarkov Stats"));
        let missing_key = "unknown.key";
        assert_eq!(Lang::En.t(missing_key), missing_key);
        assert!(
            Lang::En
                .text("average.basedOn", &[("n", "42".into())])
                .contains("42")
        );
    }
}
