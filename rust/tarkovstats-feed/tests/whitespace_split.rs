//! A multi-byte ECMAScript whitespace sequence split across a read boundary.
//!
//! The original is fed decoded text, so `TextDecoder({ stream: true })` holds a
//! partial sequence back and its buffer never contains half a character. A byte
//! port has no decoder in front of it, so its buffer can end mid-sequence, and
//! reporting that as "not whitespace" makes it reject documents the original
//! accepts. These tests drive every split offset of every member, in every
//! state the machine can be in, and pin the three excluded code points to
//! rejecting at every offset too.
//!
//! The expectations come from the original `createTimestampObjectParser`, driven
//! over the same documents: the include set is accepted and the exclude set is
//! rejected, in every state.

#![forbid(unsafe_code)]
#![warn(missing_docs)]
#![warn(clippy::pedantic)]
#![warn(rust_2018_idioms)]

use tarkovstats_feed::error::ParseError;
use tarkovstats_feed::lexer::Lexer;
use tarkovstats_feed::record::Kind;
use tarkovstats_feed::sink::CollectSink;

/// One entry as the sink saw it.
type Entry = (Kind, Vec<u8>, Vec<u8>);

/// Feeds `chunks` and reports the entries, or the parse error.
fn parse_chunks(chunks: &[&[u8]]) -> Result<Vec<Entry>, ParseError> {
    let mut lexer = Lexer::new(CollectSink::new());
    for chunk in chunks {
        if let Err(error) = lexer.append(chunk) {
            return Err(error.parse_error().expect("append only fails on parse errors"));
        }
    }
    lexer
        .finish()
        .map_err(|error| error.parse_error().expect("finish only fails on parse errors"))?;
    Ok(lexer.into_sink().records().to_vec())
}

fn entry(key: &str, value: &str) -> Entry {
    (Kind::Number, key.as_bytes().to_vec(), value.as_bytes().to_vec())
}

/// A code point as its UTF-8 bytes.
fn bytes(value: u32) -> Vec<u8> {
    char::from_u32(value).expect("a scalar value").to_string().into_bytes()
}

/// Every member of the set.
const INCLUDED: &[u32] = &[
    0x0009, 0x000a, 0x000b, 0x000c, 0x000d, 0x0020, 0x00a0, 0x1680, 0x2000, 0x2001, 0x2002,
    0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f,
    0x205f, 0x3000, 0xfeff,
];

/// The three exclusions.
const EXCLUDED: &[u32] = &[0x200b, 0x0085, 0x180e];

/// The state each document puts the member in, the message the original reports
/// there when the member is not whitespace, the message it reports when the
/// member is *cut short* by the end of the body, and whether the document has a
/// second entry whose key wraps the member.
///
/// The `key` document is the odd one out twice over: it needs a comma before the
/// member, so it carries a second entry keyed by the member, and a cut inside
/// the member leaves that key unterminated, so the body is simply truncated
/// rather than reaching the state machine.
/// The state each document puts the member in, and the message the original
/// reports there when the member is not whitespace.
///
/// Every document puts the member in a genuine whitespace position, which is the
/// only place the set applies: a member inside a string token is key or value
/// *content* and is never validated, so a document keyed by a zero-width space
/// is perfectly good. The `key` document needs a comma before the member, so it
/// carries a second entry.
const STATES: &[(&str, &str, &str)] = &[
    ("start", "{member}{\"1\":2}", "updated JSON must be an object"),
    ("key", "{\"1\":2,{member}\"2\":3}", "expected JSON string"),
    ("keyEmpty", "{\"1\":2,{member}}", "expected JSON string"),
    ("colon", "{\"1\"{member}:2}", "expected ':' after account id"),
    ("value", "{\"1\":{member}2}", "expected numeric timestamp"),
    ("comma", "{\"1\":2{member}}", "expected ',' or '}' after timestamp"),
    ("done", "{\"1\":2}{member}", "unexpected data after JSON object"),
];

/// Builds the document for `state` with `member` in it, and the byte offset the
/// member starts at.
fn document(state: &str, member: &[u8]) -> (Vec<u8>, usize) {
    let (_, template, _) = state_row(state);
    let (head, tail) = template.split_once("{member}").expect("every state is marked");
    let offset = head.len();
    let mut bytes = Vec::new();
    bytes.extend_from_slice(head.as_bytes());
    bytes.extend_from_slice(member);
    bytes.extend_from_slice(tail.as_bytes());
    (bytes, offset)
}

/// The row for `state`.
fn state_row(state: &str) -> (&'static str, &'static str, &'static str) {
    STATES
        .iter()
        .find(|(name, ..)| *name == state)
        .copied()
        .expect("every state is in the table")
}

/// The entries the original produces for `state`'s document.
fn expected_entries(state: &str) -> Vec<Entry> {
    if state == "key" {
        vec![entry("\"1\"", "2"), entry("\"2\"", "3")]
    } else {
        vec![entry("\"1\"", "2")]
    }
}

fn state_names() -> Vec<&'static str> {
    STATES.iter().map(|(name, ..)| *name).collect()
}

#[test]
fn a_split_u00a0_at_a_read_boundary_is_accepted() {
    // The reviewer's reproduction, driven through the lexer: 65 534 spaces put
    // the `U+00A0` at byte 65 535, so a 64 KiB read ends between its `C2` and
    // its `A0`. The original accepts the document.
    let mut body = b"{\n".to_vec();
    body.extend_from_slice(&bytes(0x00a0));
    body.extend_from_slice(b"\"1\":2}");
    let records = parse_chunks(&[&body[..1], &body[1..]]).expect("split U+00A0 must be accepted");
    assert_eq!(records, vec![entry("\"1\"", "2")]);

    // And at every internal offset of the member, in every state.
    let member = bytes(0x00a0);
    for state in state_names() {
        for cut in 1..member.len() {
            let (document, offset) = document(state, &member);
            let records = parse_chunks(&[&document[..offset + cut], &document[offset + cut..]])
                .unwrap_or_else(|e| panic!("U+00A0 {state} cut {cut}: {e}"));
            assert_eq!(records, expected_entries(state), "U+00A0 {state} cut {cut}");
        }
    }
}

#[test]
fn a_split_member_of_the_set_is_accepted_in_every_state_at_every_split_offset() {
    for value in INCLUDED {
        let member = bytes(*value);
        if member.len() < 2 {
            continue; // A one-byte member cannot be split.
        }
        for state in state_names() {
            for cut in 1..member.len() {
                let (document, offset) = document(state, &member);
                let records = parse_chunks(&[&document[..offset + cut], &document[offset + cut..]])
                    .unwrap_or_else(|e| panic!("U+{value:04X} {state} cut {cut}: {e}"));
                assert_eq!(records, expected_entries(state), "U+{value:04X} {state} cut {cut}");
            }
        }
    }
}

#[test]
fn a_split_exclusion_is_still_rejected_in_every_state_at_every_split_offset() {
    for value in EXCLUDED {
        let member = bytes(*value);
        for state in state_names() {
            for cut in 1..=member.len() {
                let (document, offset) = document(state, &member);
                let error = parse_chunks(&[&document[..offset + cut], &document[offset + cut..]])
                    .expect_err("an excluded code point must never be whitespace");
                let want = state_row(state).2;
                assert_eq!(error.message(), want, "U+{value:04X} {state} cut {cut}");
            }
        }
    }
}

#[test]
fn a_split_member_at_the_end_of_the_body_keeps_the_final_path() {
    // The wait is suppressed on the last chunk, so an incomplete trailing
    // sequence is not whitespace, which is the `U+FFFD` the decoder would have
    // flushed at EOF. The state machine then sees those bytes, and since no
    // lead byte of a member is one of the units it accepts, it reports the
    // message for the state it is in — exactly what the original reports for the
    // `U+FFFD` it decodes from the same bytes.
    let member = bytes(0x00a0);
    for state in state_names() {
        for cut in 1..member.len() {
            let (document, offset) = document(state, &member);
            let error = parse_chunks(&[&document[..offset + cut]])
                .expect_err("a body that ends mid-member cannot be a complete document");
            assert_eq!(
                error.message(),
                state_row(state).2,
                "U+00A0 {state} cut {cut}: the final path must not wait"
            );
        }
    }
}

#[test]
fn a_member_that_is_never_completed_reports_the_truncation_message() {
    // The other side of the final path: a body that is complete up to a partial
    // member in a state that tolerates anything, which is `key` before the
    // closing brace, still reports the truncation message rather than waiting.
    let member = bytes(0x00a0);
    for cut in 1..member.len() {
        let mut body = b"{\"1\":2,".to_vec();
        body.extend_from_slice(&member[..cut]);
        let error = parse_chunks(&[&body]).expect_err("the body ends mid-member");
        assert_eq!(
            error.message(),
            "expected JSON string",
            "cut {cut}: a partial member is not a key"
        );
    }
    // And with the member complete but the body still open, the whole-state
    // check is what fires.
    let mut body = b"{\"1\":2,".to_vec();
    body.extend_from_slice(&member);
    body.extend_from_slice(b"\"2\"");
    let error = parse_chunks(&[&body]).expect_err("the body ends after a key");
    assert_eq!(error.message(), "truncated or invalid updated JSON");
}

#[test]
fn the_wait_is_not_sticky_once_the_rest_of_the_member_arrives() {
    // The wait must be released as soon as the rest of the sequence lands.
    for value in INCLUDED {
        let member = bytes(*value);
        if member.len() < 2 {
            continue;
        }
        for state in state_names() {
            for cut in 1..member.len() {
                let (document, offset) = document(state, &member);
                let (head, tail) = document.split_at(offset + cut);
                let mut lexer = Lexer::new(CollectSink::new());
                assert!(lexer.append(head).is_ok(), "U+{value:04X} {state} cut {cut}");
                assert!(lexer.append(tail).is_ok(), "U+{value:04X} {state} cut {cut}");
                assert!(lexer.finish().is_ok(), "U+{value:04X} {state} cut {cut}");
                assert_eq!(
                    lexer.into_sink().records(),
                    expected_entries(state),
                    "U+{value:04X} {state} cut {cut}"
                );
            }
        }
    }
}

#[test]
fn a_partial_member_waits_rather_than_reaching_the_state_machine() {
    // The machine must not act on the bytes of a partial member. After the
    // split, the state is whatever the document reached, and the retained buffer
    // still holds the partial member.
    let member = bytes(0x202f);
    let (document, offset) = document("value", &member);
    for cut in 1..member.len() {
        let mut lexer = Lexer::new(CollectSink::new());
        assert!(lexer.append(&document[..offset + cut]).is_ok(), "cut {cut}");
        assert_eq!(lexer.state(), tarkovstats_feed::lexer::State::Value, "cut {cut}");
        assert_eq!(lexer.buffered(), cut, "cut {cut}: only the partial member is retained");
        assert!(lexer.sink().is_empty(), "cut {cut}: nothing is dispatched");
    }
}
