//! Process-level tests: the stdin/stdout contract, the exit codes and the
//! record framing, driven through the real binary.
//!
//! These cover the boundary the five Node callers will actually use, so they
//! assert on bytes, exit codes and stderr rather than on library types.

#![forbid(unsafe_code)]
#![warn(missing_docs)]
#![warn(clippy::pedantic)]
#![warn(rust_2018_idioms)]

use std::io::Write;
use std::process::{Command, Output, Stdio};

/// The binary's read size, which is the boundary the process tests aim at.
const READ_SIZE: usize = 64 * 1024;

/// The binary under test, as built by cargo for this integration test.
const BIN: &str = env!("CARGO_BIN_EXE_tarkovstats-feed");

/// Runs the binary with `input` on stdin.
///
/// The write happens on its own thread so a large input can never deadlock
/// against a full stdout pipe, which is the same hazard the Node shim has to
/// avoid. `stdin` is taken out of the child first and dropped by the writer
/// thread, so `wait_with_output` can never race it for the handle.
fn run_with(args: &[&str], input: &[u8]) -> Output {
    let mut child = Command::new(BIN)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("failed to spawn the binary");
    let mut stdin = child.stdin.take().expect("stdin is piped");
    let payload = input.to_vec();
    let writer = std::thread::spawn(move || {
        let _ = stdin.write_all(&payload);
        drop(stdin);
    });
    let output = child.wait_with_output().expect("failed to wait");
    writer.join().expect("the writer thread panicked");
    output
}

fn run(input: &str) -> Output {
    run_with(&[], input.as_bytes())
}

fn code(output: &Output) -> i32 {
    output.status.code().expect("the process was signalled")
}

fn stdout(output: &Output) -> String {
    String::from_utf8(output.stdout.clone()).expect("stdout is UTF-8")
}

fn stderr(output: &Output) -> String {
    String::from_utf8(output.stderr.clone()).expect("stderr is UTF-8")
}

/// One decoded record.
#[derive(Debug, PartialEq, Eq)]
struct Record {
    kind: u8,
    key: String,
    value: String,
}

/// Decodes the `--format=binary` framing exactly as the Node reader will, and
/// fails if the stream is not a whole number of well-formed records. Written
/// against the documented layout rather than against the crate, so a change to
/// the framing shows up here.
fn decode(frames: &[u8]) -> Vec<Record> {
    decode_bytes(frames)
        .into_iter()
        .map(|(kind, key, value)| Record {
            kind,
            key: String::from_utf8(key).expect("key is UTF-8"),
            value: String::from_utf8(value).expect("value is UTF-8"),
        })
        .collect()
}

/// The same, without assuming the tokens are valid UTF-8, which is the whole
/// point of carrying bytes.
fn decode_bytes(frames: &[u8]) -> Vec<(u8, Vec<u8>, Vec<u8>)> {
    let mut records = Vec::new();
    let mut at = 0;
    while at < frames.len() {
        let kind = frames[at];
        assert!(kind == 0x4E || kind == 0x53, "bad kind {kind:#x} at {at}");
        at += 1;
        let (key, next) = take_token(frames, at);
        let (value, next) = take_token(frames, next);
        records.push((kind, key, value));
        at = next;
    }
    records
}

fn take_token(frames: &[u8], at: usize) -> (Vec<u8>, usize) {
    assert!(at + 4 <= frames.len(), "truncated length prefix");
    let len = u32::from_le_bytes(frames[at..at + 4].try_into().unwrap()) as usize;
    let start = at + 4;
    assert!(start + len <= frames.len(), "token runs past the end of stdout");
    (frames[start..start + len].to_vec(), start + len)
}

// ------------------------------------------------------------ the happy path --

#[test]
fn a_well_formed_feed_round_trips_through_the_framing() {
    let output = run(r#"{"15":1755979243867,"42":"1720000001"}"#);
    assert_eq!(code(&output), 0);
    assert_eq!(stderr(&output), "");
    assert_eq!(
        decode(&output.stdout),
        vec![
            Record { kind: 0x4E, key: "\"15\"".into(), value: "1755979243867".into() },
            Record { kind: 0x53, key: "\"42\"".into(), value: "\"1720000001\"".into() },
        ]
    );
}

#[test]
fn the_reader_can_apply_the_two_v8_calls_to_each_token() {
    let output = run(r#"{"1":007,"2":1E+5,"3":1e400,"4":1e-400,"5":9007199254740993,"6":-0}"#);
    assert_eq!(code(&output), 0);
    let records = decode(&output.stdout);
    let values: Vec<&str> = records.iter().map(|r| r.value.as_str()).collect();
    assert_eq!(values, ["007", "1E+5", "1e400", "1e-400", "9007199254740993", "-0"]);
    // The tokens are the reader's problem, and they arrive unchanged.
    assert!(records.iter().all(|r| r.kind == 0x4E));
}

#[test]
fn text_format_shows_the_same_records() {
    let output = run_with(&["--format=text"], br#"{"15":1,"42":"2","x":"a\"b"}"#);
    assert_eq!(code(&output), 0);
    assert_eq!(stderr(&output), "");
    assert_eq!(stdout(&output), "{\"15\":1}\n{\"42\":\"2\"}\n{\"x\":\"a\\\"b\"}\n");
}

#[test]
fn text_and_binary_agree_on_the_record_set() {
    let body = r#"{"15":1755979243867,"42":"1720000001","d":2,"d":9,}"#;
    let binary = decode(&run(body).stdout);
    let text = stdout(&run_with(&["--format=text"], body.as_bytes()));
    let lines: Vec<&str> = text.lines().collect();
    assert_eq!(lines.len(), binary.len());
    for (line, record) in lines.iter().zip(&binary) {
        assert_eq!(
            *line,
            format!("{{{}:{}}}", record.key, record.value),
            "text and binary drifted"
        );
    }
}

#[test]
fn the_body_is_never_decoded() {
    // A raw NUL and a raw DEL inside a string token both have to survive,
    // because a malformed token is V8's to reject, not the lexer's.
    let output = run("{\"k\":\"a\u{0}b\u{7F}c\"}");
    assert_eq!(code(&output), 0);
    let records = decode_bytes(&output.stdout);
    assert_eq!(records[0].2, b"\"a\0b\x7Fc\"");
    assert_eq!(records[0].2.len(), 7);
}

#[test]
fn an_invalid_utf8_sequence_is_copied_through_byte_for_byte() {
    // `String::from_utf8_lossy` would replace this with U+FFFD. The framing is
    // defined over bytes precisely so the WHATWG decoder in the reader stays
    // the only decoder in the path, and the raw bytes cross it untouched.
    let output = run_with(&[], b"{\"k\":\"\xff\xfe\"}");
    assert_eq!(code(&output), 0);
    let mut expected: Vec<u8> = vec![0x53, 3, 0, 0, 0, b'"', b'k', b'"', 4, 0, 0, 0];
    expected.extend_from_slice(b"\"\xff\xfe\"");
    assert_eq!(output.stdout, expected);

    // And the record still decodes to a well-formed frame.
    let records = decode_bytes(&output.stdout);
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].1, b"\"k\"");
    assert_eq!(records[0].2, b"\"\xff\xfe\"");
}

// ------------------------------------------------------------- the messages --

/// One row of the message table: the message, a body that triggers it, and the
/// `(kind, "key value")` pairs that must already have been flushed.
type MessageCase = (&'static str, &'static str, &'static [(&'static str, &'static str)]);

/// Every one of the seven messages, with a trigger and the records that must
/// already have been flushed when it fires.
const MESSAGES: &[MessageCase] = &[
    ("updated JSON must be an object", "x", &[]),
    ("expected JSON string", "{1:2}", &[]),
    ("expected ':' after account id", r#"{"1" 2}"#, &[]),
    ("expected numeric timestamp", r#"{"1":true}"#, &[]),
    (
        "expected ',' or '}' after timestamp",
        r#"{"1":1e"#,
        &[("N", r#""1" 1"#)],
    ),
    (
        "truncated or invalid updated JSON",
        r#"{"1":17"#,
        &[("N", r#""1" 17"#)],
    ),
    ("unexpected data after JSON object", r#"{"1":2} x"#, &[("N", r#""1" 2"#)]),
];

#[test]
fn all_seven_messages_reach_stderr_with_exit_2() {
    assert_eq!(MESSAGES.len(), 7);
    for (message, body, expected_records) in MESSAGES {
        let output = run(body);
        assert_eq!(code(&output), 2, "{body:?}");
        assert_eq!(stderr(&output), format!("{message}\n"), "{body:?}");
        let flushed: Vec<String> = decode(&output.stdout)
            .iter()
            .map(|r| format!("{} {} {}", r.kind as char, r.key, r.value))
            .collect();
        let want: Vec<String> = expected_records
            .iter()
            .map(|(kind, rest)| format!("{kind} {rest}"))
            .collect();
        assert_eq!(flushed, want, "{body:?}");
    }
}

#[test]
fn stderr_is_exactly_one_newline_terminated_line() {
    // The shim rethrows `stderr.replace(/\n$/, "")`, so anything else on
    // stderr would end up inside the error message.
    for (message, body, _) in MESSAGES {
        let text = stderr(&run(body));
        assert!(text.ends_with('\n'), "{body:?}");
        assert_eq!(text.matches('\n').count(), 1, "{body:?}");
        assert_eq!(text.trim_end_matches('\n'), *message, "{body:?}");
    }
}

#[test]
fn the_unsafe_splits_report_message_5_and_still_flush_the_value() {
    for body in [r#"{"1":1e"#, r#"{"1":1."#, r#"{"1":1E"#, r#"{"1":1e+"#] {
        let output = run(body);
        assert_eq!(code(&output), 2, "{body:?}");
        assert_eq!(
            stderr(&output),
            "expected ',' or '}' after timestamp\n",
            "{body:?}"
        );
        let records = decode(&output.stdout);
        assert_eq!(records.len(), 1, "{body:?}");
        assert_eq!(records[0].value, "1", "{body:?}");
    }
}

#[test]
fn a_truncated_number_is_flushed_before_the_truncation_message() {
    let output = run(r#"{"1":17"#);
    assert_eq!(code(&output), 2);
    assert_eq!(stderr(&output), "truncated or invalid updated JSON\n");
    assert_eq!(
        decode(&output.stdout),
        vec![Record { kind: 0x4E, key: "\"1\"".into(), value: "17".into() }]
    );
}

#[test]
fn an_empty_or_whitespace_only_body_is_the_truncation_message() {
    for body in ["", " ", "\t\n", "\u{00A0}", "\u{FEFF}"] {
        let output = run(body);
        assert_eq!(code(&output), 2, "{body:?}");
        assert_eq!(stderr(&output), "truncated or invalid updated JSON\n", "{body:?}");
        assert!(output.stdout.is_empty(), "{body:?}");
    }
}

#[test]
fn a_double_comma_is_expected_json_string() {
    let output = run(r#"{"1":2,,"2":3}"#);
    assert_eq!(code(&output), 2);
    assert_eq!(stderr(&output), "expected JSON string\n");
    // The first entry was already dispatched, exactly as `onEntry` would have.
    assert_eq!(decode(&output.stdout).len(), 1);
}

#[test]
fn duplicate_keys_arrive_in_full_and_in_order() {
    let output = run(r#"{"1":2,"1":9,"1":"3"}"#);
    assert_eq!(code(&output), 0);
    let records = decode(&output.stdout);
    let keys: Vec<&str> = records.iter().map(|r| r.key.as_str()).collect();
    assert_eq!(keys, ["\"1\"", "\"1\"", "\"1\""]);
    let values: Vec<&str> = records.iter().map(|r| r.value.as_str()).collect();
    assert_eq!(values, ["2", "9", "\"3\""]);
}

#[test]
fn a_trailing_comma_is_accepted_with_exit_0() {
    let output = run(r#"{"1":2,}"#);
    assert_eq!(code(&output), 0);
    assert_eq!(stderr(&output), "");
    assert_eq!(decode(&output.stdout).len(), 1);
}

#[test]
fn the_whole_whitespace_set_is_accepted() {
    let mut body = String::new();
    for ws in [
        "\t", "\n", "\u{000B}", "\u{000C}", "\r", " ", "\u{00A0}", "\u{1680}", "\u{2000}",
        "\u{2001}", "\u{2002}", "\u{2003}", "\u{2004}", "\u{2005}", "\u{2006}", "\u{2007}",
        "\u{2008}", "\u{2009}", "\u{200A}", "\u{2028}", "\u{2029}", "\u{202F}", "\u{205F}",
        "\u{3000}", "\u{FEFF}",
    ] {
        body.push_str(ws);
    }
    let output = run(&format!("{{{body}\"1\"{body}:{body}2{body}}}{body}"));
    assert_eq!(code(&output), 0, "{body:?}");
    assert_eq!(stderr(&output), "");
    assert_eq!(decode(&output.stdout).len(), 1);
}

#[test]
fn the_three_excluded_codepoints_are_rejected() {
    for ch in ["\u{200B}", "\u{0085}", "\u{180E}"] {
        let output = run(&format!("{{{ch}\"1\":2}}"));
        assert_eq!(code(&output), 2, "{ch:?}");
        assert_eq!(stderr(&output), "expected JSON string\n", "{ch:?}");
        assert!(output.stdout.is_empty(), "{ch:?}");

        // And where the object is already closed they are trailing data.
        let output = run(&format!("{{\"1\":2}}{ch}"));
        assert_eq!(stderr(&output), "unexpected data after JSON object\n", "{ch:?}");
    }
}

#[test]
fn a_malformed_string_token_is_emitted_for_v8() {
    // Not rejected here: `JSON.parse` in the reader raises
    // `Bad escaped character in JSON at position 2`, relative to the token.
    for value in [r#""\q""#, r#""\x41""#, "\"a\tb\"", "\"a\nb\"", r#""\ud800""#] {
        let output = run(&format!(r#"{{"k":{value}}}"#));
        assert_eq!(code(&output), 0, "{value}");
        let records = decode(&output.stdout);
        assert_eq!(records.len(), 1, "{value}");
        assert_eq!(records[0].kind, 0x53, "{value}");
        assert_eq!(records[0].value, value, "{value}");
    }
}

#[test]
fn a_token_containing_a_raw_newline_stays_framed() {
    let output = run("{\"k\":\"a\nb\"}");
    assert_eq!(code(&output), 0);
    let records = decode(&output.stdout);
    assert_eq!(records[0].value, "\"a\nb\"");
    assert_eq!(records[0].value.len(), 5);
}

// ------------------------------------------------------------------- the cli --

#[test]
fn help_exits_zero_and_documents_the_contract() {
    for flag in ["--help", "-h"] {
        let output = run_with(&[flag], b"");
        assert_eq!(code(&output), 0, "{flag}");
        let text = stdout(&output);
        for needle in [
            "tarkovstats-feed",
            "--format=binary",
            "kind",
            "key_len",
            "value_len",
            "little-endian",
            "0x4e",
            "0x53",
            "EOF plus exit 0",
            "verbatim",
        ] {
            assert!(text.contains(needle), "{flag} help is missing {needle:?}");
        }
        assert!(output.stderr.is_empty(), "{flag}");
    }
}

#[test]
fn an_unknown_flag_is_rejected_cleanly() {
    for args in [
        vec!["--json"],
        vec!["-x"],
        vec!["--format=json"],
        vec!["--format"],
        vec!["extra"],
        vec!["--format=text", "--nope"],
    ] {
        let output = run_with(&args, b"");
        assert_eq!(code(&output), 1, "{args:?}");
        let text = stderr(&output);
        assert!(!text.is_empty(), "{args:?}");
        assert!(output.stdout.is_empty(), "{args:?}");
        // The message is actionable, not a panic.
        assert!(!text.contains("panicked"), "{args:?}");
        // The usage line appears exactly once, however the reason was produced.
        assert_eq!(
            text.matches("usage: tarkovstats-feed").count(),
            1,
            "{args:?} printed the usage line more than once:\n{text}"
        );
        assert!(text.contains("tarkovstats-feed --help"), "{args:?}:\n{text}");
    }
}

#[test]
fn both_format_spellings_work() {
    for args in [vec!["--format=binary"], vec!["--format", "binary"]] {
        let output = run_with(&args, br#"{"1":2}"#);
        assert_eq!(code(&output), 0, "{args:?}");
        assert_eq!(decode(&output.stdout).len(), 1, "{args:?}");
    }
    for args in [vec!["--format=text"], vec!["--format", "text"]] {
        let output = run_with(&args, br#"{"1":2}"#);
        assert_eq!(code(&output), 0, "{args:?}");
        assert_eq!(stdout(&output), "{\"1\":2}\n", "{args:?}");
    }
}

// -------------------------------------------------------------- the streaming --

#[test]
fn a_u00a0_at_byte_65535_is_accepted() {
    // The blocking defect: `U+00A0` is `C2 A0`, and 65 534 spaces after the
    // opening brace put its `C2` at byte 65 535, so the first 64 KiB read ends
    // one byte into it. The original, whose `TextDecoder({ stream: true })`
    // holds a partial sequence back, accepts this document.
    let mut body = b"{\n".to_vec();
    body.resize(READ_SIZE - 1, b' ');
    body.extend_from_slice("\u{00A0}\"1\":2}".as_bytes());
    assert_eq!(body[READ_SIZE - 1..=READ_SIZE], [0xC2, 0xA0], "the read must end mid-sequence");

    let output = run_with(&[], &body);
    assert_eq!(code(&output), 0, "stderr: {}", stderr(&output));
    assert_eq!(stderr(&output), "");
    let records = decode(&output.stdout);
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].key, "\"1\"");
    assert_eq!(records[0].value, "2");
}

#[test]
fn a_member_at_byte_65535_is_accepted_in_text_mode_too() {
    // Same boundary, the debugging mode, and a three-byte member so the read
    // ends after one byte of it.
    let mut body = b"{\n".to_vec();
    body.resize(READ_SIZE - 1, b' ');
    body.extend_from_slice("\u{3000}\"1\":2}".as_bytes());
    assert_eq!(body[READ_SIZE - 1..=READ_SIZE], [0xE3, 0x80], "the read must end mid-sequence");

    let output = run_with(&["--format=text"], &body);
    assert_eq!(code(&output), 0, "stderr: {}", stderr(&output));
    assert_eq!(stdout(&output), "{\"1\":2}\n");
}

#[test]
fn an_excluded_codepoint_at_byte_65535_is_still_rejected() {
    // The other direction. `U+200B` is `E2 80 8B`, whose first two bytes are a
    // real prefix of `U+2000`..`U+200A`, so the port has to wait for the `8B`
    // and only then reject. `U+180E` is `E1 A0 8E`, and no member starts
    // `E1 A0`, so it rejects without waiting.
    for (ch, message) in [
        ("\u{200B}", "expected JSON string"),
        ("\u{0085}", "expected JSON string"),
        ("\u{180E}", "expected JSON string"),
    ] {
        let mut body = b"{\n".to_vec();
        body.resize(READ_SIZE - 1, b' ');
        body.extend_from_slice(ch.as_bytes());
        body.extend_from_slice(b"\"1\":2}");
        let output = run_with(&[], &body);
        assert_eq!(code(&output), 2, "{ch:?} exit");
        assert_eq!(stderr(&output), format!("{message}\n"), "{ch:?} stderr");
        assert!(output.stdout.is_empty(), "{ch:?} must not emit a record");
    }
}

#[test]
fn a_body_larger_than_one_read_buffer_is_fully_lexed() {
    // Comfortably past the 64 KiB read size, with an entry straddling the
    // first boundary, so the prefix-drop and wait logic is exercised.
    let mut body = String::from("{");
    for i in 0..30_000u32 {
        if i > 0 {
            body.push(',');
        }
        let entry = format!("\"{i}\":{}", 1_700_000_000_000u64 + u64::from(i));
        body.push_str(&entry);
    }
    body.push('}');
    assert!(body.len() > 200_000);
    let output = run(&body);
    assert_eq!(code(&output), 0);
    assert_eq!(stderr(&output), "");
    let records = decode(&output.stdout);
    assert_eq!(records.len(), 30_000);
    assert_eq!(records[0].key, "\"0\"");
    assert_eq!(records[0].value, "1700000000000");
    assert_eq!(records[29_999].key, "\"29999\"");
    assert_eq!(records[29_999].value, "1700000029999");
}

#[test]
fn a_body_truncated_mid_entry_still_flushes_what_came_before() {
    let mut body = String::from("{");
    for i in 0..20_000u32 {
        if i > 0 {
            body.push(',');
        }
        let entry = format!("\"{i}\":{}", 1_700_000_000_000u64 + u64::from(i));
        body.push_str(&entry);
    }
    body.push_str(",\"20000\":17");
    let output = run(&body);
    assert_eq!(code(&output), 2);
    assert_eq!(stderr(&output), "truncated or invalid updated JSON\n");
    let records = decode(&output.stdout);
    // Every completed entry, and the half-written one, are on stdout.
    assert_eq!(records.len(), 20_001);
    assert_eq!(records[20_000].value, "17");
}

#[test]
fn a_read_is_not_required_to_see_the_whole_body_at_once() {
    // Writing the same bytes in one piece and letting the process read them in
    // 64 KiB pieces must give the same records, the same order and the same
    // exit. The body spans three reads, and the write is split at offsets that
    // land inside a read, exactly on a read boundary, and just after one.
    let mut body = String::from("{");
    for i in 0..12_000u32 {
        if i > 0 {
            body.push(',');
        }
        let entry = format!("\"{i}\":{}", 1_700_000_000_000u64 + u64::from(i));
        body.push_str(&entry);
    }
    // A few awkward tokens at the end: an escape, a duplicate key, a leading
    // zero and a string value.
    body.push_str(r#","e":"a\"b","7":007,"7":"dup","neg":-0}"#);
    assert!(body.len() > 3 * READ_SIZE, "the body must span more than three reads");

    let whole = run(&body);
    assert_eq!(code(&whole), 0, "stderr: {}", stderr(&whole));

    let mut splits: Vec<usize> = (1..=200).collect();
    // Offsets either side of every read boundary. Computed with saturating
    // arithmetic rather than casts, so no signed/width conversion is involved.
    for boundary in (READ_SIZE..body.len()).step_by(READ_SIZE) {
        for delta in [2usize, 1, 0] {
            splits.push(boundary.saturating_sub(delta));
            if boundary + delta < body.len() {
                splits.push(boundary + delta);
            }
        }
    }
    splits.extend(body.len().saturating_sub(200)..body.len());
    splits.retain(|split| *split > 0 && *split < body.len());
    splits.sort_unstable();
    splits.dedup();

    let split_count = splits.len();
    for split in splits {
        let (head, tail) = body.split_at(split);
        let head = head.as_bytes().to_vec();
        let tail = tail.as_bytes().to_vec();
        let mut child = Command::new(BIN)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn");
        let mut stdin = child.stdin.take().expect("stdin");
        // The write goes on its own thread. A 200 KB body is far more than a
        // pipe buffer, so writing it inline would fill stdin while the child
        // filled stdout, and both sides would block for ever. This is the same
        // deadlock the Node shim has to avoid, and it is why the shim is told
        // not to await `stdin.write()`.
        let writer = std::thread::spawn(move || {
            // Two writes with a flush between them, so the child really can see
            // a chunk boundary at `split`.
            let _ = stdin.write_all(&head);
            let _ = stdin.flush();
            let _ = stdin.write_all(&tail);
        });
        let output = child.wait_with_output().expect("wait");
        writer.join().expect("the writer thread panicked");
        assert_eq!(output.status.code(), whole.status.code(), "split {split}");
        assert_eq!(output.stdout, whole.stdout, "split {split}");
        assert_eq!(output.stderr, whole.stderr, "split {split}");
    }
    assert!(split_count > 400, "expected a few hundred splits, got {split_count}");
}
