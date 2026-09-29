//! Command line entry point.
//!
//! Reads the raw response bytes of a Tarkov "updated" feed from stdin, lexes
//! them, and writes one framed record per entry to stdout. The body is never
//! decoded: it is scanned for the ASCII bytes the state machine tests and
//! copied through otherwise.

#![forbid(unsafe_code)]
#![warn(missing_docs)]
#![warn(clippy::pedantic)]
#![warn(rust_2018_idioms)]

mod cli;

use std::io::{self, BufWriter, Read, Write};
use std::process::ExitCode;

use cli::{Format, Options};
use tarkovstats_feed::error::{LexError, ParseError};
use tarkovstats_feed::lexer::Lexer;
use tarkovstats_feed::sink::{BinarySink, Sink, TextSink};

/// Read size for the streaming loop. The parser never needs the whole body, and
/// the retained buffer only holds the tail of the last chunk.
const READ_SIZE: usize = 64 * 1024;

/// Capacity of the stdout buffer. Records are appended to it whole.
const WRITE_CAPACITY: usize = 64 * 1024;

const EXIT_OK: u8 = 0;
const EXIT_USAGE: u8 = 1;
const EXIT_PARSE: u8 = 2;
const EXIT_IO: u8 = 3;

fn main() -> ExitCode {
    let outcome = match Options::from_env() {
        Ok(Some(options)) => run(options),
        // `--help` is a success, not a usage error.
        Ok(None) => {
            print!("{}", Options::help());
            let _ = io::stdout().lock().flush();
            return ExitCode::from(EXIT_OK);
        }
        Err(error) => Err(Failure::Usage(error)),
    };

    match outcome {
        Ok(()) => ExitCode::from(EXIT_OK),
        Err(Failure::Usage(message)) => {
            let mut stderr = io::stderr().lock();
            let _ = writeln!(stderr, "{message}");
            // The parsers report the reason only; the usage line is added here,
            // once, so it is not repeated after the reason already quoted it.
            let _ = writeln!(stderr, "{}", cli::USAGE);
            let _ = writeln!(stderr, "try 'tarkovstats-feed --help'");
            ExitCode::from(EXIT_USAGE)
        }
        // The records written before the failure have already been flushed by
        // `run`; the message is the only thing left to write.
        Err(Failure::Parse(error)) => {
            let mut stderr = io::stderr().lock();
            let _ = writeln!(stderr, "{error}");
            ExitCode::from(EXIT_PARSE)
        }
        Err(Failure::Io(message)) => {
            let mut stderr = io::stderr().lock();
            let _ = writeln!(stderr, "{message}");
            ExitCode::from(EXIT_IO)
        }
    }
}

/// Everything that can end the process with a non-zero code.
enum Failure {
    /// A bad command line. The shim turns this into
    /// `feed parser exited 1`: fatal, never retried.
    Usage(String),
    /// One of the seven owned messages, exit 2.
    Parse(ParseError),
    /// A short I/O description, exit 3.
    Io(String),
}

fn run(options: Options) -> Result<(), Failure> {
    let stdout = io::stdout();
    match options.format {
        Format::Binary => {
            let sink = BinarySink::new(BufWriter::with_capacity(WRITE_CAPACITY, stdout.lock()));
            stream(sink)
        }
        Format::Text => {
            let sink = TextSink::new(BufWriter::with_capacity(WRITE_CAPACITY, stdout.lock()));
            stream(sink)
        }
    }
}

/// Reads stdin to EOF, handing each chunk to the lexer and finishing at EOF.
///
/// The body is never held whole: each chunk is appended and the consumed
/// prefix is dropped before the next read. EOF is the end of the body, so the
/// lexer's `finish` runs with `final` set, exactly the `parser.finish()` call
/// every Node caller makes.
fn stream<S: Sink>(sink: S) -> Result<(), Failure> {
    let mut lexer = Lexer::new(sink);
    let stdin = io::stdin();
    let mut reader = stdin.lock();
    let mut chunk = vec![0u8; READ_SIZE];

    let outcome = (|| -> Result<(), Failure> {
        loop {
            match reader.read(&mut chunk) {
                Ok(0) => return lexer.finish().map_err(failure_from),
                Ok(read) => lexer.append(&chunk[..read]).map_err(failure_from)?,
                // `Interrupted` is not a failure, it is a signal to try again.
                Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                Err(error) => {
                    return Err(Failure::Io(format!("stdin read failed: {error}")));
                }
            }
        }
    })();

    // Flush on every path, so the records written before a failure are never
    // lost: the Node side must see exactly the entries `onEntry` would have
    // received. The flush result is dropped on the failure paths on purpose,
    // because stderr carries exactly one line there, and the shim rethrows
    // `stderr.replace(/\n$/, "")` verbatim.
    let flushed = lexer.into_sink().finish();

    match outcome {
        Ok(()) => flushed.map_err(|error| Failure::Io(format!("stdout flush failed: {error}"))),
        Err(failure) => Err(failure),
    }
}

fn failure_from(error: LexError) -> Failure {
    match error {
        LexError::Parse(error) => Failure::Parse(error),
        LexError::Io(error) => Failure::Io(format!("stdout write failed: {error}")),
    }
}
