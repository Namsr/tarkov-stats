//! Behavioural tests for the ported state machine.
//!
//! The cases marked "not covered by any Node test" in the specification's test
//! contract are the reason this file exists. Everything here was also checked
//! against the original `createTimestampObjectParser` by driving both
//! implementations over the same bytes at several chunk sizes.

#![forbid(unsafe_code)]
#![warn(missing_docs)]
#![warn(clippy::pedantic)]
#![warn(rust_2018_idioms)]

use tarkovstats_feed::error::{LexError, ParseError};
use tarkovstats_feed::lexer::{Lexer, State};
use tarkovstats_feed::record::Kind;
use tarkovstats_feed::sink::CollectSink;

/// One entry as the sink saw it.
type Entry = (Kind, Vec<u8>, Vec<u8>);

/// Runs the whole body through `append` + `finish`, as the binary does.
fn parse(body: &str) -> Result<Vec<Entry>, ParseError> {
    parse_chunks(&[body])
}

/// The same, but with the body split into explicit chunks, which is how the
/// original's `append` is driven.
fn parse_chunks(chunks: &[&str]) -> Result<Vec<Entry>, ParseError> {
    let mut lexer = Lexer::new(CollectSink::new());
    let mut outcome = Ok(());
    for chunk in chunks {
        if let Err(error) = lexer.append(chunk.as_bytes()) {
            outcome = Err(error.parse_error().expect("append only fails on parse errors"));
            break;
        }
    }
    if outcome.is_ok() {
        if let Err(error) = lexer.finish() {
            outcome = Err(error.parse_error().expect("finish only fails on parse errors"));
        }
    }
    let sink = lexer.into_sink();
    match outcome {
        Ok(()) => Ok(sink.records().to_vec()),
        Err(error) => Err(error),
    }
}

/// The error message, as the shim would rethrow it.
fn message_of(body: &str) -> String {
    parse(body)
        .expect_err("expected a parse failure")
        .to_string()
}

fn entry(kind: Kind, key: &str, value: &str) -> Entry {
    (kind, key.as_bytes().to_vec(), value.as_bytes().to_vec())
}

// ---------------------------------------------------------------- messages --

#[test]
fn message_1_updated_json_must_be_an_object() {
    // `{` on its own is not this one: the `start` branch consumes it, and the
    // truncation check reports the missing close. See message 6. Likewise
    // `{\u200B`, which is message 2 once the brace is behind us.
    for body in ["x", "[1]", "1", "\"a\"", "null", "\u{200B}x", "\u{FEFF}x", " true"] {
        assert_eq!(message_of(body), "updated JSON must be an object", "{body:?}");
    }
}

#[test]
fn message_2_expected_json_string() {
    for body in ["{1:2}", r#"{"1":2,,"2":3}"#, "{,}", r#"{"1":2,[}"#] {
        assert_eq!(message_of(body), "expected JSON string", "{body:?}");
    }
}

#[test]
fn message_3_expected_colon_after_account_id() {
    // `{"1"::2}` is not this one: the first `:` is consumed and the second
    // lands in the `value` state. See message 4.
    for body in [r#"{"1" 2}"#, r#"{"1";2}"#, r#"{"1"}"#, r#"{"1",2}"#] {
        assert_eq!(message_of(body), "expected ':' after account id", "{body:?}");
    }
}

#[test]
fn message_4_expected_numeric_timestamp() {
    for body in [
        r#"{"1":+5}"#,
        r#"{"1":.5}"#,
        r#"{"1":NaN}"#,
        r#"{"1":true}"#,
        r#"{"1":null}"#,
        r#"{"1":[]}"#,
        r#"{"1":{}}"#,
        r#"{"1":-}"#,
        r#"{"1":e5}"#,
        r#"{"1":}"#,
    ] {
        assert_eq!(message_of(body), "expected numeric timestamp", "{body:?}");
    }
}

#[test]
fn message_5_expected_comma_or_brace_after_timestamp() {
    for body in [r#"{"1":5.}"#, r#"{"1":1e}"#, r#"{"1":1E}"#, r#"{"1":1e+}"#, r#"{"1":1 2}"#, r#"{"1":2x}"#] {
        assert_eq!(message_of(body), "expected ',' or '}' after timestamp", "{body:?}");
    }
}

#[test]
fn message_6_truncated_or_invalid_updated_json() {
    for body in [r#"{"1":17"#, r#"{"1""#, "{", "", r#"{"1":"a"#, r#"{"1":1,"2""#] {
        assert_eq!(message_of(body), "truncated or invalid updated JSON", "{body:?}");
    }
}

#[test]
fn message_7_unexpected_data_after_json_object() {
    for body in [r#"{"1":2} x"#, r#"{"1":2}{"2":3}"#, "{},", "{}]", "{}\u{200B}"] {
        assert_eq!(message_of(body), "unexpected data after JSON object", "{body:?}");
    }
}

#[test]
fn empty_and_whitespace_only_input_is_the_truncation_message() {
    // Not "must be an object": `skipWhitespace` runs before the state check,
    // so an all-whitespace body never reaches the `start` branch.
    assert_eq!(message_of(""), "truncated or invalid updated JSON");
    for body in [" ", "   ", "\t", "\n", "\r\n", "\u{000B}\u{000C}", "\u{00A0}", "\u{FEFF}"] {
        assert_eq!(message_of(body), "truncated or invalid updated JSON", "{body:?}");
    }
    // Every member of the set on its own.
    for ws in [
        "\u{1680}", "\u{2000}", "\u{200A}", "\u{2028}", "\u{2029}", "\u{202F}", "\u{205F}",
        "\u{3000}",
    ] {
        assert_eq!(message_of(ws), "truncated or invalid updated JSON", "{ws:?}");
    }
}

#[test]
fn the_three_excluded_codepoints_are_not_whitespace() {
    // U+200B, U+0085 and U+180E: the parser sees the character where it
    // expects `{`, so the object check fires.
    for ch in ["\u{200B}", "\u{0085}", "\u{180E}"] {
        assert_eq!(message_of(ch), "updated JSON must be an object", "{ch:?}");
        assert_eq!(message_of(&format!("{ch}{ch}")), "updated JSON must be an object");
    }
}

#[test]
fn the_included_multi_byte_codepoints_are_whitespace() {
    for ws in [
        "\u{00A0}", "\u{1680}", "\u{2000}", "\u{2001}", "\u{2002}", "\u{2003}", "\u{2004}",
        "\u{2005}", "\u{2006}", "\u{2007}", "\u{2008}", "\u{2009}", "\u{200A}", "\u{2028}",
        "\u{2029}", "\u{202F}", "\u{205F}", "\u{3000}", "\u{FEFF}",
    ] {
        let body = format!("{{{ws}\"1\"{ws}:{ws}2{ws}}}{ws}");
        assert_eq!(parse(&body).unwrap().len(), 1, "{ws:?}");
    }
}

#[test]
fn the_seven_messages_are_distinct() {
    // A guard against two states silently collapsing onto one string. It says
    // nothing about reachability: that is driven through the real binary in
    // `all_seven_messages_reach_stderr_with_exit_2` in tests/process.rs.
    let seen: Vec<String> = ParseError::ALL.iter().map(|e| e.message().to_string()).collect();
    for (index, message) in seen.iter().enumerate() {
        assert_eq!(
            seen.iter().filter(|other| *other == message).count(),
            1,
            "duplicate at {index}: {message}"
        );
    }
}

// ------------------------------------------------------------ the grammar --

#[test]
fn a_complete_document_yields_its_entries_in_order() {
    assert_eq!(
        parse(r#"{"13134885":1720000000000,"42":"1720000001"}"#).unwrap(),
        vec![
            entry(Kind::Number, r#""13134885""#, "1720000000000"),
            entry(Kind::String, r#""42""#, r#""1720000001""#),
        ]
    );
}

#[test]
fn an_empty_object_is_accepted() {
    assert_eq!(parse("{}").unwrap(), vec![]);
    assert_eq!(parse("{ }").unwrap(), vec![]);
    assert_eq!(parse("{\u{00A0}\u{FEFF}}").unwrap(), vec![]);
}

#[test]
fn a_trailing_comma_is_accepted() {
    assert_eq!(parse(r#"{"1":2,}"#).unwrap(), vec![entry(Kind::Number, r#""1""#, "2")]);
    assert_eq!(parse(r#"{"1":2,}"#).unwrap().len(), 1);
}

#[test]
fn a_double_comma_is_expected_json_string() {
    assert_eq!(message_of(r#"{"1":2,,"2":3}"#), "expected JSON string");
}

#[test]
fn duplicate_keys_are_emitted_in_full_and_in_order() {
    assert_eq!(
        parse(r#"{"1":2,"1":9,"1":"3"}"#).unwrap(),
        vec![
            entry(Kind::Number, r#""1""#, "2"),
            entry(Kind::Number, r#""1""#, "9"),
            entry(Kind::String, r#""1""#, r#""3""#),
        ]
    );
}

#[test]
fn keys_are_never_validated_as_numeric() {
    for key in [r#""""#, r#"" 12 ""#, r#""0x10""#, r#""007""#, r#""😀""#, r#""-1""#, r#""1e5""#] {
        let body = format!("{{{key}:1}}");
        assert_eq!(
            parse(&body).unwrap(),
            vec![entry(Kind::Number, key, "1")],
            "{key}"
        );
    }
}

#[test]
fn numeric_tokens_are_carried_verbatim() {
    for token in [
        "007", "1E+5", "1e400", "1e-400", "9007199254740993", "-0", "-0.0", "0", "0.0", "1.5",
        "12345678901234567890", "1e0", "1E0", "-1e-1", "00.00", "1e0000005",
    ] {
        let body = format!(r#"{{"1":{token}}}"#);
        assert_eq!(
            parse(&body).unwrap(),
            vec![entry(Kind::Number, r#""1""#, token)],
            "{token}"
        );
    }
}

#[test]
fn the_reader_still_gets_v8_semantics_for_those_tokens() {
    // The lexer must not pre-round, pre-clamp or pre-normalise. The only
    // assertion here that can fail is the one about the bytes crossing the
    // boundary; what `Number` then does with them is V8's job, and it is why
    // `007` has to arrive as `007` and not as `7`, and `1e400` as `1e400` and
    // not as `Infinity`.
    for token in ["007", "1E+5", "1e400", "1e-400", "9007199254740993", "-0"] {
        let body = format!(r#"{{"1":{token}}}"#);
        let records = parse(&body).unwrap();
        assert_eq!(records[0].0, Kind::Number);
        assert_eq!(String::from_utf8(records[0].2.clone()).unwrap(), token);
    }
}

#[test]
fn plus_five_and_dot_five_are_rejected() {
    assert_eq!(message_of(r#"{"1":+5}"#), "expected numeric timestamp");
    assert_eq!(message_of(r#"{"1":.5}"#), "expected numeric timestamp");
}

#[test]
fn a_bare_decimal_point_emits_its_value_then_fails() {
    // `5.` matches as `5`, the `.` is left over, and the `comma` state
    // rejects it. The entry is already emitted when that happens.
    let mut lexer = Lexer::new(CollectSink::new());
    let error = lexer.append(br#"{"1":1.}"#).unwrap_err();
    assert_eq!(error.parse_error(), Some(ParseError::ExpectedCommaOrBrace));
    assert_eq!(lexer.into_sink().records(), &[entry(Kind::Number, r#""1""#, "1")]);
}

#[test]
fn a_partial_exponent_emits_its_value_then_fails() {
    for (body, emitted) in [
        (r#"{"1":1e"#, "1"),
        (r#"{"1":1E"#, "1"),
        (r#"{"1":1e+"#, "1"),
        (r#"{"1":1e-"#, "1"),
        (r#"{"1":1.5e"#, "1.5"),
    ] {
        let mut lexer = Lexer::new(CollectSink::new());
        let error = lexer.append(body.as_bytes()).unwrap_err();
        assert_eq!(
            error.parse_error(),
            Some(ParseError::ExpectedCommaOrBrace),
            "{body}"
        );
        assert_eq!(lexer.into_sink().values(), vec![emitted.as_bytes()], "{body}");
    }
}

#[test]
fn literals_that_json_allows_are_rejected_here() {
    for body in [
        r#"{"1":true}"#,
        r#"{"1":false}"#,
        r#"{"1":null}"#,
        r#"{"1":[]}"#,
        r#"{"1":{}}"#,
        r#"{"1":NaN}"#,
        r#"{"1":Infinity}"#,
    ] {
        assert_eq!(message_of(body), "expected numeric timestamp", "{body}");
    }
}

// ------------------------------------------------------------ string tokens --

#[test]
fn string_tokens_pass_through_untouched() {
    for token in [
        r#""""#,
        r#""a""#,
        r#""a\"b""#,
        r#""a\\b""#,
        r#""a\/b""#,
        r#""\n\r\t\b\f""#,
        r#""\u0041""#,
        r#""\uD83D\uDE00""#,
        r#""\ud800""#,
        r#""\udfff\udbff""#,
        r#""\q""#,
        r#""\x41""#,
        r#""a\"b\\c""#,
        r#""\"""#,
    ] {
        let body = format!("{{\"k\":{token}}}");
        assert_eq!(
            parse(&body).unwrap(),
            vec![entry(Kind::String, r#""k""#, token)],
            "{token}"
        );
    }
}

#[test]
fn a_surrogate_pair_key_is_never_recombined() {
    // The binary must not decode: the four UTF-8 bytes of U+1F600 stay as
    // they were written, rather than becoming an escape or being normalised.
    let records = parse("{\"\u{1F600}\":1}").unwrap();
    assert_eq!(records[0].1, b"\"\xF0\x9F\x98\x80\"");
    assert_eq!(records[0].1.len(), 6);
}

#[test]
fn a_lone_surrogate_escape_is_emitted_for_v8_to_reject() {
    let records = parse(r#"{"\ud800":1}"#).unwrap();
    assert_eq!(records[0].1, br#""\ud800""#);
}

#[test]
fn a_raw_control_character_in_a_token_is_emitted_not_rejected() {
    // V8's `JSON.parse` has to be the one that complains, with a position
    // relative to the token, so the lexer must not pre-reject any of these.
    let cases: [(&str, &str, &str); 4] = [
        ("{\"\u{9}\":1}", "\"\u{9}\"", "1"),
        ("{\"k\":\"a\u{b}b\"}", "\"k\"", "\"a\u{b}b\""),
        ("{\"k\":\"a\nb\"}", "\"k\"", "\"a\nb\""),
        ("{\"k\":\"a\rb\"}", "\"k\"", "\"a\rb\""),
    ];
    for (body, key, value) in cases {
        let records = parse(body).unwrap_or_else(|e| panic!("{body:?} failed: {e}"));
        assert_eq!(records[0].1, key.as_bytes(), "{body:?}");
        assert_eq!(records[0].2, value.as_bytes(), "{body:?}");
    }
}

#[test]
fn an_unterminated_string_waits_rather_than_failing() {
    let mut lexer = Lexer::new(CollectSink::new());
    assert!(lexer.append(br#"{"abc"#).is_ok());
    assert_eq!(lexer.state(), State::Key);
    assert!(lexer.append(br#"def":"v"}"#).is_ok());
    assert!(lexer.finish().is_ok());
    assert_eq!(lexer.into_sink().keys(), vec![br#""abcdef""#.as_ref()]);
}

#[test]
fn a_trailing_backslash_waits_rather_than_failing() {
    let mut lexer = Lexer::new(CollectSink::new());
    assert!(lexer.append(br#"{"k":"a\"#).is_ok());
    assert_eq!(lexer.state(), State::Value);
    assert!(lexer.append(br#""b"}"#).is_ok());
    assert!(lexer.finish().is_ok());
    // The `\"` did not end the token, so the value is `a"b`.
    assert_eq!(lexer.into_sink().values(), vec![br#""a\"b""#.as_ref()]);
}

#[test]
fn a_key_may_straddle_a_chunk_boundary() {
    // `{"12` + `34":"5"` + `}`: the key is split mid-token across two chunks.
    let records = parse_chunks(&[r#"{"12"#, "34\":\"5\"", "}"]).unwrap();
    assert_eq!(records, vec![entry(Kind::String, r#""1234""#, r#""5""#)]);
}

// ------------------------------------------------------------- the `final` rule --

#[test]
fn a_number_token_at_the_buffer_end_waits_for_more_input() {
    let mut lexer = Lexer::new(CollectSink::new());
    assert!(lexer.append(br#"{"1":1"#).is_ok());
    assert_eq!(lexer.state(), State::Value);
    assert!(lexer.sink().is_empty());
}

#[test]
fn finish_emits_the_pending_entry_and_then_throws() {
    // The entry set on the error path is `final`-dependent: `finish` commits
    // the token it was holding before the whole-state check fails.
    let mut lexer = Lexer::new(CollectSink::new());
    assert!(lexer.append(br#"{"1":17"#).is_ok());
    assert!(lexer.sink().is_empty());
    let error = lexer.finish().unwrap_err();
    assert_eq!(error.parse_error(), Some(ParseError::Truncated));
    assert_eq!(
        lexer.into_sink().records(),
        &[entry(Kind::Number, r#""1""#, "17")]
    );
}

#[test]
fn a_boundary_after_a_digit_run_is_always_safe() {
    for split in [7, 8, 9, 10] {
        let body = r#"{"1":1234567890}"#;
        let (head, tail) = body.split_at(split);
        let records = parse_chunks(&[head, tail]).unwrap();
        assert_eq!(records, vec![entry(Kind::Number, r#""1""#, "1234567890")], "split {split}");
    }
}

#[test]
fn finish_with_a_partial_exponent_throws_message_5_not_message_6() {
    // The `final` check is never reached: the `comma` state sees the leftover
    // `e` first, on a final chunk exactly as on a non-final one.
    assert_eq!(message_of(r#"{"1":1e"#), "expected ',' or '}' after timestamp");
    assert_eq!(message_of(r#"{"1":1."#), "expected ',' or '}' after timestamp");
    assert_eq!(message_of(r#"{"1":1e+"#), "expected ',' or '}' after timestamp");
}

#[test]
fn finish_is_not_guarded() {
    let mut lexer = Lexer::new(CollectSink::new());
    assert!(lexer.append(br#"{"1":2}"#).is_ok());
    assert!(lexer.finish().is_ok());
    // A second and third finish after a complete document are silent no-ops.
    assert!(lexer.finish().is_ok());
    assert!(lexer.finish().is_ok());
    assert_eq!(lexer.into_sink().len(), 1);
}

#[test]
fn append_after_finish_follows_the_original() {
    let mut lexer = Lexer::new(CollectSink::new());
    assert!(lexer.append(br#"{"1":2}"#).is_ok());
    assert!(lexer.finish().is_ok());
    // An empty chunk is a no-op.
    assert!(lexer.append(b"").is_ok());
    // A non-empty one is message 7.
    assert_eq!(
        lexer.append(b"x").unwrap_err().parse_error(),
        Some(ParseError::TrailingData)
    );
}

#[test]
fn a_parser_broken_by_a_failed_finish_is_not_poisoned() {
    // "A parser left broken after a failed finish is resumable today. Do not
    // poison it." Nothing is latched: the machine keeps whatever state the
    // failure left it in and keeps answering from there, and the unconsumed
    // prefix is still in the buffer for the next call to look at.
    let mut lexer = Lexer::new(CollectSink::new());
    assert_eq!(
        lexer.append(br#"{"1":1e"#).unwrap_err().parse_error(),
        Some(ParseError::ExpectedCommaOrBrace)
    );
    assert_eq!(lexer.state(), State::Comma);
    // Still responsive, and still failing on the same leftover `e`.
    assert_eq!(
        lexer.append(b"x").unwrap_err().parse_error(),
        Some(ParseError::ExpectedCommaOrBrace)
    );
    assert_eq!(lexer.state(), State::Comma);
    assert_eq!(lexer.buffered(), 2);
    // The record that was emitted before the failure is still there.
    assert_eq!(lexer.sink().len(), 1);
}

// --------------------------------------------------------------- chunking --

#[test]
fn the_result_does_not_depend_on_where_the_chunks_fall() {
    // Plain integers and string values only: the original waits for a digit
    // run at a buffer end but not for a bare `-`, `.` or `e`, so a chunk
    // boundary inside a sign or an exponent is an unsafe split. See
    // `a_unsafe_splits_are_chunk_boundaries_too`.
    let body = r#"{"15":1755979243867,"42":"1720000001","x":"a\"b","1":2}"#;
    let expected = parse(body).unwrap();
    for split in 0..=body.len() {
        let (head, tail) = body.split_at(split);
        let records = parse_chunks(&[head, tail])
            .unwrap_or_else(|e| panic!("split {split}: {e}"));
        assert_eq!(records, expected, "split {split}");
    }
    for split in 0..=body.len() {
        let (head, tail) = body.split_at(split);
        let three: Vec<&str> = vec![&head[..split / 2], &head[split / 2..], tail];
        let records = parse_chunks(&three).unwrap_or_else(|e| panic!("split {split}: {e}"));
        assert_eq!(records, expected, "split {split} in three");
    }
}

#[test]
fn a_unsafe_splits_are_chunk_boundaries_too() {
    // The `final` wait only covers a number token that already matched. A bare
    // `-`, `.` or `e` does not match, so it is a hard error in the `value`
    // state the moment it is seen, whether or not more input follows. This is
    // the original's behaviour, and the port reproduces it rather than
    // smoothing it over.
    for (body, split, message) in [
        // A lone `-` does not match the number pattern at all.
        (r#"{"1":-0}"#, 6, "expected numeric timestamp"),
        // A lone `e` leaves a leftover the `comma` state cannot use.
        (r#"{"1":1e5}"#, 7, "expected ',' or '}' after timestamp"),
        // A lone `.` likewise.
        (r#"{"1":1.5}"#, 7, "expected ',' or '}' after timestamp"),
    ] {
        let (head, tail) = body.split_at(split);
        let error = parse_chunks(&[head, tail]).unwrap_err();
        assert_eq!(error.message(), message, "{body} split at {split}");
        // And the whole body in one piece still works.
        assert!(parse(body).is_ok(), "{body}");
    }
}

#[test]
fn one_byte_at_a_time_matches_one_chunk() {
    // `tests/regular-profile-sync.test.mjs:44-56` appends one character per
    // call; the value type tag is what matters, so the kind byte has to
    // survive the one-byte chunking.
    // `for (const character of json) parser.append(character)` appends one
    // code unit at a time; the value type tag is what matters, so the kind
    // byte has to survive that chunking.
    let body = r#"{"13134885":1720000000000,"42":"1720000001"}"#;
    let chunks: Vec<&str> = body
        .char_indices()
        .map(|(at, ch)| &body[at..at + ch.len_utf8()])
        .collect();
    let records = parse_chunks(&chunks).unwrap();
    assert_eq!(records[0].0, Kind::Number);
    assert_eq!(records[1].0, Kind::String);
    assert_eq!(records, parse(body).unwrap());
}

#[test]
fn a_chunk_boundary_inside_a_number_waits_and_then_commits() {
    // `tests/seasonal-profile-sync.test.mjs:36-45`: the first chunk ends
    // mid-number, which is exactly the `final` wait.
    let records = parse_chunks(&[r#"{"7":1700000000"#, r#","8":"1700000001000"}"#]).unwrap();
    assert_eq!(
        records,
        vec![
            entry(Kind::Number, r#""7""#, "1700000000"),
            entry(Kind::String, r#""8""#, r#""1700000001000""#),
        ]
    );
}

// ---------------------------------------------------------------- lifecycle --

#[test]
fn a_non_numeric_key_is_an_entry_not_a_failure() {
    // `tests/leaderboard-warmup.test.mjs:244-253`: the caller counts this as
    // an invalid entry, so the lexer must hand it over.
    let records = parse(r#"{"3":300,"bad":"nope"}"#).unwrap();
    assert_eq!(
        records,
        vec![
            entry(Kind::Number, r#""3""#, "300"),
            entry(Kind::String, r#""bad""#, r#""nope""#),
        ]
    );
}

#[test]
fn a_sink_failure_leaves_the_state_but_not_the_position() {
    // The port of "an exception thrown by `onEntry` propagates with the entry
    // not yet recorded". The original assigns `position = end` *before* calling
    // `onEntry` (scripts/regular-profile-sync-core.mjs:48-49) and advances the
    // state only after it, so both halves are asserted here: a sink failure
    // leaves the machine in `value`, having already consumed the value token.
    struct Failing {
        /// Records the sink actually took.
        taken: usize,
        /// Which call fails.
        fail_on: usize,
    }
    impl Failing {
        fn taken(&self) -> usize {
            self.taken
        }
    }
    impl tarkovstats_feed::sink::Sink for Failing {
        fn record(&mut self, _: &tarkovstats_feed::record::Record<'_>) -> std::io::Result<()> {
            if self.taken + 1 == self.fail_on {
                return Err(std::io::Error::other("no"));
            }
            self.taken += 1;
            Ok(())
        }
        fn finish(self) -> std::io::Result<()> {
            Ok(())
        }
    }

    let mut lexer = Lexer::new(Failing {
        taken: 0,
        fail_on: 2,
    });
    // The first entry waits on the buffer end, so nothing is dispatched yet.
    assert!(lexer.append(br#"{"1":1"#).is_ok());
    assert_eq!(lexer.state(), State::Value);
    assert_eq!(lexer.sink().taken(), 0);

    // The first entry goes through; the second fails in the sink, which is
    // where an exception thrown by `onEntry` would land.
    let error = lexer.append(br#","2":2}"#).unwrap_err();
    assert!(matches!(error, LexError::Io(_)), "{error:?}");
    assert_eq!(lexer.sink().taken(), 1);

    // The state never left `value`, so the entry was not recorded...
    assert_eq!(lexer.state(), State::Value);
    // ...but the position did move past the value token, as it does in the
    // original. The retained buffer is `1,"2":2}` and the value token ends at 7,
    // leaving only the closing brace unconsumed. Assigning the position after
    // the sink call instead would leave 2.
    assert_eq!(lexer.buffered(), 1, "position must advance before the sink call");
}

#[test]
fn a_document_may_be_long() {
    let body = format!(
        "{{{}}}",
        (0..20_000)
            .map(|i| format!("\"{i}\":{}", 1_700_000_000_000u64 + i))
            .collect::<Vec<_>>()
            .join(",")
    );
    let records = parse(&body).unwrap();
    assert_eq!(records.len(), 20_000);
    assert_eq!(records[0].1, b"\"0\"");
    assert_eq!(records[19_999].2, b"1700000019999");
}

#[test]
fn state_names_match_the_original() {
    assert_eq!(State::Start.name(), "start");
    assert_eq!(State::Key.name(), "key");
    assert_eq!(State::Colon.name(), "colon");
    assert_eq!(State::Value.name(), "value");
    assert_eq!(State::Comma.name(), "comma");
    assert_eq!(State::Done.name(), "done");
}

#[test]
fn buffered_reports_the_tail_kept_for_the_next_chunk() {
    let mut lexer = Lexer::new(CollectSink::new());
    lexer.append(br#"{"1":123"#).unwrap();
    assert_eq!(lexer.buffered(), 3);
    lexer.append(b"456}").unwrap();
    lexer.finish().unwrap();
    assert_eq!(lexer.buffered(), 0);
}
