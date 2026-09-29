//! The seven error strings owned by `createTimestampObjectParser`.
//!
//! Every message below is byte-for-byte the `message` of the `new Error(...)`
//! that `scripts/regular-profile-sync-core.mjs` throws. They are operator
//! visible: `log` serializes `error.message` and
//! `warmup-leaderboard-profiles.mjs` embeds `${error.name}: ${error.message}`
//! into a rethrown string, so any drift shows up verbatim in the sync logs.
//!
//! Do not "improve" these. There is no `cause`, no `retryable` flag and no own
//! property on any of them, which is exactly why `error?.retryable === false`
//! evaluates to `false` and PvE/Arena silently retry a parse failure.

use std::fmt;
use std::io;

/// A parse failure raised by the ported state machine.
///
/// The order follows the state machine: states `start`, `key`, `colon`,
/// `value` and `comma` each own one message, `finish` owns the truncation
/// check, and `done` owns the trailing-data check.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ParseError {
    /// The first non-whitespace code unit is not `{`.
    NotAnObject,
    /// In the `key` state the unit is neither `"` nor `}`.
    ExpectedString,
    /// In the `colon` state the unit is not `:`.
    ExpectedColon,
    /// The unit is not `"` and `/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/` does not match.
    ExpectedNumeric,
    /// After a complete value the unit is neither `,` nor `}`.
    ///
    /// This is also where a chunk boundary that leaves a bare `.` or a
    /// `e`/`E`/`+`/`-` in the buffer lands, on a final chunk as much as on a
    /// non-final one: the `final` wait rule is never reached.
    ExpectedCommaOrBrace,
    /// The `final` whole-state check failed.
    Truncated,
    /// Non-whitespace remains after the closing `}`.
    TrailingData,
}

impl ParseError {
    /// Every message, verbatim.
    #[must_use]
    pub const fn message(self) -> &'static str {
        match self {
            Self::NotAnObject => "updated JSON must be an object",
            Self::ExpectedString => "expected JSON string",
            Self::ExpectedColon => "expected ':' after account id",
            Self::ExpectedNumeric => "expected numeric timestamp",
            Self::ExpectedCommaOrBrace => "expected ',' or '}' after timestamp",
            Self::Truncated => "truncated or invalid updated JSON",
            Self::TrailingData => "unexpected data after JSON object",
        }
    }

    /// All seven, in the order of the state machine that raises them.
    pub const ALL: [Self; 7] = [
        Self::NotAnObject,
        Self::ExpectedString,
        Self::ExpectedColon,
        Self::ExpectedNumeric,
        Self::ExpectedCommaOrBrace,
        Self::Truncated,
        Self::TrailingData,
    ];
}

impl fmt::Display for ParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.message())
    }
}

impl std::error::Error for ParseError {}

/// Everything that can go wrong while lexing: the seven parser messages, plus an
/// I/O failure raised by the record sink.
#[derive(Debug)]
pub enum LexError {
    /// The state machine threw.
    Parse(ParseError),
    /// The sink could not write a record it had already accepted.
    ///
    /// This is the port of "an exception thrown by `onEntry`": the record is
    /// dropped, the state is left exactly where it was, and the failure is not
    /// one of the seven owned messages.
    Io(io::Error),
}

impl From<io::Error> for LexError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<ParseError> for LexError {
    fn from(error: ParseError) -> Self {
        Self::Parse(error)
    }
}

impl fmt::Display for LexError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Parse(error) => f.write_str(error.message()),
            Self::Io(error) => write!(f, "{error}"),
        }
    }
}

impl std::error::Error for LexError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Parse(error) => Some(error),
            Self::Io(error) => Some(error),
        }
    }
}

impl LexError {
    /// The owned parser message, when this is a parse failure.
    #[must_use]
    pub const fn parse_error(&self) -> Option<ParseError> {
        match self {
            Self::Parse(error) => Some(*error),
            Self::Io(_) => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn messages_are_verbatim() {
        assert_eq!(
            ParseError::NotAnObject.message(),
            "updated JSON must be an object"
        );
        assert_eq!(ParseError::ExpectedString.message(), "expected JSON string");
        assert_eq!(
            ParseError::ExpectedColon.message(),
            "expected ':' after account id"
        );
        assert_eq!(
            ParseError::ExpectedNumeric.message(),
            "expected numeric timestamp"
        );
        assert_eq!(
            ParseError::ExpectedCommaOrBrace.message(),
            "expected ',' or '}' after timestamp"
        );
        assert_eq!(
            ParseError::Truncated.message(),
            "truncated or invalid updated JSON"
        );
        assert_eq!(
            ParseError::TrailingData.message(),
            "unexpected data after JSON object"
        );
    }

    #[test]
    fn every_message_is_distinct_and_the_set_is_complete() {
        let mut seen = Vec::new();
        for error in ParseError::ALL {
            assert!(!seen.contains(&error.message()), "duplicate: {}", error.message());
            seen.push(error.message());
        }
        assert_eq!(seen.len(), 7);
    }

    #[test]
    fn display_matches_message() {
        for error in ParseError::ALL {
            assert_eq!(error.to_string(), error.message());
        }
    }
}
