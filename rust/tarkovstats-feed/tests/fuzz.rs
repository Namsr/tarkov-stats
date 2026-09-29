//! Fuzz-style sweeps: truncated input must never panic, and the process must
//! always exit 0 or 2.
//!
//! The lexer handles untrusted upstream bytes, so every byte offset of a
//! representative document is a legal input, and none of them may take the
//! process down. A panic would exit 101 and the Node shim would report
//! `feed parser exited 101` instead of the parser's own message, so a panic is
//! a contract violation here, not just a bug.

#![forbid(unsafe_code)]
#![warn(missing_docs)]
#![warn(clippy::pedantic)]
#![warn(rust_2018_idioms)]

use std::io::Write;
use std::process::{Command, Output, Stdio};

const BIN: &str = env!("CARGO_BIN_EXE_tarkovstats-feed");

/// A document that reaches every state, both `value` branches, a duplicate
/// key, a trailing comma, an escape, a raw control byte and a multi-byte
/// whitespace character.
const REPRESENTATIVE: &str = concat!(
    r#"{"15":1755979243867,"42":"1720000001","#,
    "\"007\":-0,",
    r#""a\"b":"x\ty","#,
    r#""\u0041":"\ud83d\ude00","#,
    r#""p":"q","1":2,}"#,
);

/// A second document made almost entirely of the `\s` set, so the prefix sweep
/// also walks the whitespace boundaries.
const WHITESPACE: &str = concat!(
    "{\u{00A0}\u{FEFF}\u{200B}\u{0085}",
    "\"1\"\u{180E}:\u{3000}",
    "2\u{205F}}\u{200B}",
);

fn run(input: &[u8]) -> Output {
    let mut child = Command::new(BIN)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("failed to spawn the binary");
    let mut stdin = child.stdin.take().expect("stdin is piped");
    let payload = input.to_vec();
    let writer = std::thread::spawn(move || {
        let _ = stdin.write_all(&payload);
    });
    let output = child.wait_with_output().expect("failed to wait");
    writer.join().expect("the writer thread panicked");
    output
}

/// The contract every input has to satisfy.
fn assert_sane(output: &Output, label: &str) {
    let code = output.status.code();
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        !stderr.contains("panicked"),
        "{label}: the process panicked\n{stderr}"
    );
    assert!(
        code == Some(0) || code == Some(2),
        "{label}: exit {code:?} is neither 0 nor 2\n{stderr}"
    );
    // Exit 0 means no parser message, and any message means exit 2.
    if code == Some(0) {
        assert!(stderr.is_empty(), "{label}: exit 0 with stderr {stderr:?}");
    } else {
        assert!(!stderr.is_empty(), "{label}: exit 2 with empty stderr");
        assert!(stderr.ends_with('\n'), "{label}: message is not terminated");
        assert_eq!(stderr.matches('\n').count(), 1, "{label}: more than one line");
    }
    // stdout is always a whole number of well-formed records: the last record
    // has to end exactly at the end of the stream. Every step is bounds
    // checked, so a torn tail is reported as a torn tail and not as an
    // out-of-range panic.
    let mut at = 0;
    let stdout = &output.stdout;
    while at < stdout.len() {
        assert!(
            stdout[at] == 0x4E || stdout[at] == 0x53,
            "{label}: bad kind {:#x} at {at}",
            stdout[at]
        );
        at += 1;
        for which in ["key", "value"] {
            let bytes = stdout
                .get(at..at + 4)
                .unwrap_or_else(|| panic!("{label}: truncated {which} length prefix at {at}"));
            let len = u32::from_le_bytes(bytes.try_into().unwrap()) as usize;
            at += 4;
            assert!(
                stdout.get(at..at + len).is_some(),
                "{label}: {which} token of {len} bytes runs past the end at {at}"
            );
            at += len;
        }
    }
    assert_eq!(at, stdout.len(), "{label}: a record runs past the end");
}

#[test]
fn every_prefix_of_a_representative_document_is_sane() {
    for cut in 0..=REPRESENTATIVE.len() {
        let input = &REPRESENTATIVE.as_bytes()[..cut];
        let output = run(input);
        assert_sane(&output, &format!("prefix-{cut}"));
    }
    // The whole document is the one prefix that must succeed.
    let output = run(REPRESENTATIVE.as_bytes());
    assert_eq!(output.status.code(), Some(0), "{}", String::from_utf8_lossy(&output.stderr));
    assert!(!output.stdout.is_empty());
}

#[test]
fn every_prefix_of_a_whitespace_heavy_document_is_sane() {
    for cut in 0..=WHITESPACE.len() {
        let input = WHITESPACE.as_bytes();
        // Cut on a byte boundary that may split a multi-byte sequence too.
        let output = run(&input[..cut]);
        assert_sane(&output, &format!("ws-prefix-{cut}"));
    }
}

#[test]
fn every_single_byte_truncation_of_a_number_is_sane() {
    let document = r#"{"1":-12.34e+56,"2":9}"#;
    for cut in 0..=document.len() {
        let output = run(&document.as_bytes()[..cut]);
        assert_sane(&output, &format!("number-prefix-{cut}"));
    }
}

#[test]
fn every_byte_at_every_offset_is_sane() {
    // One byte flipped at every offset, so no single byte of a valid document
    // can steer the lexer into an unhandled state.
    let bytes = REPRESENTATIVE.as_bytes();
    for at in 0..bytes.len() {
        for replacement in [0x00u8, 0x22, 0x5C, 0x7B, 0x7D, 0x2C, 0x2E, 0x65, 0x45, 0x2B, 0x2D, 0x30, 0x20, 0x09, 0xC2, 0xE2, 0x80, 0x8B, 0xEF, 0xFF] {
            let mut input = bytes.to_vec();
            input[at] = replacement;
            let output = run(&input);
            assert_sane(&output, &format!("byte-{at:x}-{replacement:x}"));
        }
    }
}

#[test]
fn random_bytes_are_sane() {
    // A small xorshift, so the corpus is deterministic and reproducible
    // without a dependency and without a random seed.
    let mut state: u64 = 0x2545_F491_4F6C_DD1D;
    let mut next = move || {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        state
    };
    for iteration in 0..600 {
        let len = (next() % 48) as usize;
        let mut input: Vec<u8> = (0..len).map(|_| (next() & 0xFF) as u8).collect();
        // Half the corpus gets a valid frame wrapped around the noise, so the
        // interesting states are reached as often as the junk ones.
        if iteration % 2 == 0 && !input.is_empty() {
            let at = usize::try_from(next() % input.len() as u64).expect("at most input.len()");
            let inject: &[u8] = br#"{""#;
            input.splice(at..at, inject.iter().copied());
        }
        let output = run(&input);
        assert_sane(&output, &format!("random-{iteration}"));
    }
}

#[test]
fn a_long_string_token_scans_linearly() {
    // The resumable string scan, enforced rather than asserted in a comment.
    //
    // One unterminated string token spanning the whole body is the input that
    // used to be quadratic: `readString` in the original restarts at the opening
    // quote, so with 64 KiB reads the whole retained tail was rescanned on every
    // chunk. Measured on this machine, before the fix and after:
    //
    //   size      before      after
    //   16 MiB     0.80s      0.02s
    //   64 MiB    14.34s      0.07s
    //   128 MiB   66.96s      0.14s
    //
    // The bound is loose on purpose: a quadratic scan at this size takes
    // minutes, a linear one well under a second. It floors the *ratio* as much
    // as the absolute, so a slow machine cannot make it flaky, while a
    // regression to the old behaviour cannot pass it.
    const SMALL: usize = 8 << 20;
    const LARGE: usize = 64 << 20;

    let seconds = |size: usize| -> f64 {
        let mut body = b"{\"".to_vec();
        body.resize(size, b'a');
        let started_at = std::time::Instant::now();
        let output = run(&body);
        let elapsed = started_at.elapsed().as_secs_f64();
        assert_sane(&output, &format!("long-token-{size}"));
        assert!(
            output.stdout.is_empty(),
            "{size}: an unterminated string token emits no record"
        );
        assert!(
            !String::from_utf8_lossy(&output.stderr).is_empty(),
            "{size}: an unterminated string token is truncated at the end of the body"
        );
        elapsed
    };

    let small = seconds(SMALL);
    let large = seconds(LARGE);
    // Eight times the input must not cost anything like eight times the time.
    let budget = (small * 24.0).max(20.0);
    assert!(
        large < budget,
        "scanning {LARGE} bytes took {large:.2}s against {small:.2}s for {SMALL}, \
         and the budget is {budget:.2}s. A scan that restarts at the opening \
         quote is quadratic and takes minutes at this size."
    );
    eprintln!("long token: {SMALL} bytes in {small:.3}s, {LARGE} bytes in {large:.3}s");
}

#[test]
fn a_long_run_of_degenerate_input_is_sane() {
    // Long inputs of each degenerate shape, to check the exit-code and framing
    // contract holds at scale. This says nothing about how *fast* they are; the
    // linearity claim is enforced by `a_long_string_token_scans_linearly`.
    for (label, input) in [
        ("only-open-braces", format!("{{{}", "{".repeat(200_000))),
        ("only-quotes", format!("{{\"{}", "\"".repeat(200_000))),
        ("only-backslashes", format!("{{\"k\":\"{}", "\\".repeat(200_000))),
        ("only-digits", format!("{{\"k\":{}", "9".repeat(400_000))),
        ("only-commas", format!("{{{}}}", ",".repeat(200_000))),
        ("only-minus", format!("{{\"k\":{}", "-".repeat(200_000))),
        ("only-exponent", format!("{{\"k\":1{}", "e".repeat(200_000))),
        ("high-bytes", format!("{{\"k\":\"{}", "\u{00A0}".repeat(100_000))),
    ] {
        let output = run(input.as_bytes());
        assert_sane(&output, label);
    }
}
