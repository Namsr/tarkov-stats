//! One completed entry, carried as raw source bytes.
//!
//! The port's single design decision lives here: a [`Record`] holds the token
//! bytes exactly as they appeared on stdin. Nothing is decoded, nothing is
//! converted, nothing is validated. The Node reader then applies
//! `JSON.parse` to a string token and `Number` to a numeric one, which are the
//! same two calls `createTimestampObjectParser` makes on the same bytes.

/// Which of the two `value`-producing branches produced the value bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum Kind {
    /// `value` state, `/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/` matched.
    ///
    /// The reader calls `Number(token)`, which is why `007`, `1E+5`, `1e400`,
    /// `1e-400`, `9007199254740993` and `-0` must survive intact: they are
    /// V8 rounding rules, not lexer rules.
    Number = 0x4E,
    /// `value` state, a string token including both double quotes.
    String = 0x53,
}

impl Kind {
    /// The wire byte, `'N'` or `'S'`.
    #[must_use]
    pub const fn tag(self) -> u8 {
        self as u8
    }
}

/// A complete key/value pair, ready to hand to the sink.
///
/// Both slices include whatever quoting and escaping the source used. That is
/// deliberate: a malformed string token must reach `JSON.parse` so the reader
/// gets a byte-identical V8 `SyntaxError` with a token-relative position,
/// instead of a Rust message with a document-relative one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Record<'a> {
    /// The key string token, including both double quotes, escapes unprocessed.
    pub key: &'a [u8],
    /// Which branch produced `value`.
    pub kind: Kind,
    /// The numeric token as written, or the string token including its quotes.
    pub value: &'a [u8],
}

impl<'a> Record<'a> {
    /// Builds a record from its two raw tokens.
    #[must_use]
    pub const fn new(key: &'a [u8], kind: Kind, value: &'a [u8]) -> Self {
        Self { key, kind, value }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kind_tags_match_the_record_framing() {
        assert_eq!(Kind::Number.tag(), 0x4E);
        assert_eq!(Kind::Number.tag(), b'N');
        assert_eq!(Kind::String.tag(), 0x53);
        assert_eq!(Kind::String.tag(), b'S');
    }
}
