//! Byte-level port of `createTimestampObjectParser`.
//!
//! The state machine, the seven error strings, the `final` wait rule and the
//! whitespace set are reproduced exactly. Everything else is left to V8: no
//! string is decoded, no number is converted, no token is validated.
//!
//! ```text
//! document    := ws '{' ws entry-list ws trailing-comma? ws '}' ws*
//! entry       := string ws ':' ws value
//! entry-list  := empty | entry ( ws ',' ws entry )*
//! value       := number-token | string
//! number-token:= '-'? [0-9]+ ( '.' [0-9]+ )? ( [eE] [+-]? [0-9]+ )?
//! ```
//!
//! ## Deliberate deviations from JSON, all preserved
//!
//! - A trailing comma is accepted: `{"1":2,}` is one entry, no error.
//! - Leading zeros are accepted: `007` reaches the reader as `007`.
//! - There is no range or finiteness check. `1e400`, `1e-400` and
//!   `9007199254740993` are handed over as written and become `Infinity`, `0`
//!   and `9007199254740992` in the reader, where the callers already apply
//!   `Number.isSafeInteger` and count the rest as `invalidEntries`.
//! - Duplicate keys are emitted in full and in document order, because
//!   `versions.set(aid, updatedAt)` is last-write-wins on the Node side.
//! - Keys are never validated as numeric. `" 12 "`, `"0x10"`, `""` and an
//!   emoji are all entries.
//! - `+5` and `.5` are rejected. `5.` and `1e` emit their value and then fail
//!   in the `comma` state, on a final chunk as much as on a non-final one.
//!
//! ## Bytes instead of code units
//!
//! The original indexes a UTF-16 string. A byte scan is equivalent here because
//! the only bytes the machine ever *tests* are ASCII (`"`, `\`, `{`, `}`, `:`,
//! `,`, digits, `.`, `e`, `+`, `-`) and UTF-8 never encodes an ASCII byte
//! inside a multi-byte sequence, so no ASCII byte is ever mistaken for a
//! continuation. Whitespace is the one place where multi-byte sequences matter,
//! and [`crate::whitespace`] hard-codes the whole ECMAScript set.
//!
//! ## Waiting for a partial sequence
//!
//! The original is fed decoded text, so its buffer never holds half a character:
//! `TextDecoder({ stream: true })` keeps a partial sequence back until the rest
//! arrives, and only flushes an incomplete one as `U+FFFD` at the end of the
//! body. A byte port has no decoder in front of it, so [`crate::whitespace`]
//! reports a proper prefix of a member as a third outcome, and
//! [`Lexer::parse`] waits for it on a non-final chunk. Without that, a member
//! split by a read boundary would be read as "not whitespace" and the port would
//! reject documents the original accepts.

use crate::error::{LexError, ParseError};
use crate::record::{Kind, Record};
use crate::sink::Sink;
use crate::whitespace::skip_whitespace;

/// A half-open byte range inside the lexer buffer, as `(start, end)`.
type Span = (usize, usize);

/// The state variable of the original, one variant per `state` string.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum State {
    /// Before the opening brace.
    Start,
    /// Expecting a key string or the closing brace.
    Key,
    /// Expecting `:`.
    Colon,
    /// Expecting a number token or a string token.
    Value,
    /// Expecting `,` or `}`.
    Comma,
    /// After the closing brace.
    Done,
}

impl State {
    /// The `state` string held by the original, for debugging and assertions.
    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Self::Start => "start",
            Self::Key => "key",
            Self::Colon => "colon",
            Self::Value => "value",
            Self::Comma => "comma",
            Self::Done => "done",
        }
    }
}

/// The streaming lexer.
///
/// Drive it exactly the way the original is driven: [`Lexer::append`] per
/// chunk, then [`Lexer::finish`] once at the end of the body. `finish` is not
/// guarded, so a second call after a complete document is a silent no-op, an
/// empty `append` after `finish` is a no-op, and a non-empty one raises
/// `unexpected data after JSON object`; none of those are blocked here.
pub struct Lexer<S> {
    /// Unconsumed input. Everything before `position` is dropped at the end of
    /// each `parse`, exactly like `buffer = buffer.slice(position)`.
    buf: Vec<u8>,
    position: usize,
    state: State,
    /// The current key token, copied out when the closing quote is found so it
    /// can survive the prefix drop and a key that straddles a chunk boundary.
    key: Vec<u8>,
    /// Where the open string token's scan stopped, as `(opening quote, cursor)`.
    ///
    /// `readString` in the original starts over from the opening quote every
    /// time it is called, which stays linear only because its buffer is short
    /// between `append` calls. With 64 KiB reads and one long token, restarting
    /// would rescan the whole retained tail on every chunk and the port would
    /// go quadratic where the original does not, so the cursor is carried
    /// across chunks instead. `None` whenever no string token is open.
    open_string: Option<Span>,
    sink: S,
}

impl<S: Sink> Lexer<S> {
    /// Wraps a sink in a fresh lexer.
    pub fn new(sink: S) -> Self {
        Self {
            buf: Vec::new(),
            position: 0,
            state: State::Start,
            key: Vec::new(),
            open_string: None,
            sink,
        }
    }

    /// Feeds the next chunk of stdin. Corresponds to `append`.
    pub fn append(&mut self, chunk: &[u8]) -> Result<(), LexError> {
        self.buf.extend_from_slice(chunk);
        self.parse(false)
    }

    /// Signals the end of the body. Corresponds to `finish("")`.
    ///
    /// Records that were emitted before a failure stay emitted: the caller
    /// flushes the sink on this path too, so a parse error loses nothing that
    /// the original's `onEntry` would already have dispatched.
    pub fn finish(&mut self) -> Result<(), LexError> {
        self.parse(true)
    }

    /// The current state variable.
    #[must_use]
    pub fn state(&self) -> State {
        self.state
    }

    /// Bytes retained for a later chunk: the tail from `position`.
    #[must_use]
    pub fn buffered(&self) -> usize {
        self.buf.len() - self.position
    }

    /// Gives the sink back, so the caller can flush it.
    pub fn into_sink(self) -> S {
        self.sink
    }

    /// Borrows the sink, to inspect what has been emitted so far without
    /// giving up ownership of it.
    pub fn sink(&self) -> &S {
        &self.sink
    }

    /// The state machine, `parse(final)` from the original.
    fn parse(&mut self, final_chunk: bool) -> Result<(), LexError> {
        // Destructured so the buffer can be handed to the sink while it is
        // still being advanced.
        let Self {
            buf,
            position,
            state,
            key,
            open_string,
            sink,
        } = self;

        loop {
            // `skipWhitespace`, plus the wait for a partial multi-byte member
            // that `TextDecoder({ stream: true })` would have held back.
            if skip_whitespace(buf, position, final_chunk) {
                break;
            }
            if *position >= buf.len() {
                break;
            }
            let unit = buf[*position];
            match *state {
                State::Done => return Err(LexError::Parse(ParseError::TrailingData)),
                State::Start => {
                    if unit != b'{' {
                        return Err(LexError::Parse(ParseError::NotAnObject));
                    }
                    *position += 1;
                    *state = State::Key;
                }
                State::Key => {
                    if unit == b'}' {
                        *position += 1;
                        *state = State::Done;
                    } else {
                        // `readString`, returning `None` to mean "wait".
                        let Some(end) = scan_string(buf, *position, open_string)? else {
                            break;
                        };
                        key.clear();
                        key.extend_from_slice(&buf[*position..end]);
                        *position = end;
                        *state = State::Colon;
                    }
                }
                State::Colon => {
                    if unit != b':' {
                        return Err(LexError::Parse(ParseError::ExpectedColon));
                    }
                    *position += 1;
                    *state = State::Value;
                }
                State::Value => {
                    // `readValue`, returning `None` to mean "wait".
                    let Some((kind, end)) = scan_value(buf, *position, final_chunk, open_string)?
                    else {
                        break;
                    };
                    // `position` moves before the record is dispatched, the way
                    // the original assigns `position = end` before calling
                    // `onEntry`. The state still does not: a sink failure
                    // leaves the machine in `value`, with the entry not taken.
                    *position = end.1;
                    // The single emission site. Both output modes go through
                    // it, so neither can drift from the other or from the state
                    // machine.
                    sink.record(&Record::new(key, kind, &buf[end.0..end.1]))?;
                    *state = State::Comma;
                }
                State::Comma => {
                    if unit == b',' {
                        *position += 1;
                        *state = State::Key;
                    } else if unit == b'}' {
                        *position += 1;
                        *state = State::Done;
                    } else {
                        return Err(LexError::Parse(ParseError::ExpectedCommaOrBrace));
                    }
                }
            }
        }

        if *position > 0 {
            // The open-token cursor moves with the bytes it indexes.
            if let Some((open, cursor)) = *open_string {
                *open_string = Some((open - *position, cursor - *position));
            }
            buf.drain(..*position);
            *position = 0;
        }

        if final_chunk {
            // No wait at the end of the body: an incomplete trailing sequence
            // is not whitespace, which is the `U+FFFD` the decoder would have
            // flushed.
            skip_whitespace(buf, position, true);
            if *state != State::Done || *position != buf.len() {
                return Err(LexError::Parse(ParseError::Truncated));
            }
        }
        Ok(())
    }
}

/// `readString`. Returns the index just past the closing quote, or `None` when
/// the token is incomplete in the buffer and the parser must wait.
///
/// The token is never validated. Escapes are skipped only far enough to keep a
/// `\"` from ending the token, exactly as the original does, so a malformed
/// token is carried verbatim to the reader and produces a V8 `SyntaxError`
/// with a token-relative position.
///
/// `open` carries the resume cursor across chunks. Restarting at `position + 1`
/// would rescan the whole retained tail on every `append`, which is quadratic
/// in the length of one long token; resuming where the last scan stopped is the
/// same scan, done once. The buffer only ever grows at the end and its prefix is
/// only ever dropped along with the cursor, so the bytes the cursor has already
/// passed cannot change underneath it.
fn scan_string(
    buf: &[u8],
    position: usize,
    open: &mut Option<Span>,
) -> Result<Option<usize>, ParseError> {
    // A cursor recorded for a different opening quote cannot belong to this
    // token, so it is discarded rather than trusted.
    let start = match *open {
        Some((quote, cursor)) if quote == position => cursor,
        _ => {
            if buf[position] != b'"' {
                return Err(ParseError::ExpectedString);
            }
            position + 1
        }
    };

    let mut end = start;
    while end < buf.len() {
        match buf[end] {
            b'\\' => {
                // The escaped unit is skipped, and a backslash in the last
                // position means the token is not complete yet. The escaped
                // unit itself has not arrived, so the resume cursor goes *past*
                // it: whatever byte lands there cannot end the token, which is
                // what re-running the original's loop from the opening quote
                // would do by stepping over it again.
                end += 1;
                if end >= buf.len() {
                    *open = Some((position, buf.len() + 1));
                    return Ok(None);
                }
            }
            b'"' => {
                *open = None;
                return Ok(Some(end + 1));
            }
            _ => {}
        }
        end += 1;
    }
    *open = Some((position, buf.len()));
    Ok(None)
}

/// `readValue`. Returns the token kind and its half-open byte range, or `None`
/// when the machine must wait for more input.
///
/// The number branch is a hand-rolled `/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/`.
/// `\d` there is ASCII-only and so is `bytes[i].is_ascii_digit()`; the optional
/// groups do not participate when they are not fully matched, which is also
/// how the regular expression backtracks.
///
/// `open` is threaded through to the string branch, which can be as long and as
/// chunk-straddling as a key.
fn scan_value(
    buf: &[u8],
    position: usize,
    final_chunk: bool,
    open: &mut Option<Span>,
) -> Result<Option<(Kind, Span)>, ParseError> {
    if buf[position] == b'"' {
        return Ok(scan_string(buf, position, open)?.map(|end| (Kind::String, (position, end))));
    }

    let mut end = position;
    if buf.get(end) == Some(&b'-') {
        end += 1;
    }
    let digits = count_digits(buf, end);
    if digits == 0 {
        return Err(ParseError::ExpectedNumeric);
    }
    end += digits;

    if buf.get(end) == Some(&b'.') {
        let fraction = count_digits(buf, end + 1);
        if fraction > 0 {
            end += 1 + fraction;
        }
    }

    if matches!(buf.get(end), Some(b'e' | b'E')) {
        let mut exponent = end + 1;
        if matches!(buf.get(exponent), Some(b'+' | b'-')) {
            exponent += 1;
        }
        let digits = count_digits(buf, exponent);
        if digits > 0 {
            end = exponent + digits;
        }
    }

    // The one line the `final` flag exists for. A number token that ends
    // exactly at the end of the buffer may still grow, so the machine waits
    // unless this is the last chunk.
    if !final_chunk && end == buf.len() {
        return Ok(None);
    }
    Ok(Some((Kind::Number, (position, end))))
}

/// Length of the ASCII digit run at `at`.
fn count_digits(buf: &[u8], at: usize) -> usize {
    buf[at..]
        .iter()
        .position(|byte| !byte.is_ascii_digit())
        .unwrap_or(buf.len() - at)
}
