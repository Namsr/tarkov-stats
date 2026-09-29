//! Command line parsing.
//!
//! Two options exist, both documented in `--help`: the record format, and
//! `--help`. Anything else is a usage error, which exits 1 so the Node shim
//! fails hard instead of retrying a process that was never going to parse the
//! body.

use std::ffi::OsString;

pub const USAGE: &str = "usage: tarkovstats-feed [--format=<binary|text>]";

const HELP: &str = "\
tarkovstats-feed - byte-level lexer for the Tarkov \"updated\" feed

USAGE
    tarkovstats-feed [--format=<binary|text>]

DESCRIPTION
    Reads the raw response bytes of a Tarkov \"updated\" feed on stdin and
    writes one record per account/timestamp pair to stdout. EOF on stdin is
    the end of the body. Nothing is decoded: string tokens are passed through
    with their quotes and escapes intact, and number tokens are emitted
    exactly as written, so the caller keeps V8's JSON.parse and Number
    semantics and sees the same values, and the same SyntaxError positions,
    as the original Node parser.

    The grammar is the one createTimestampObjectParser accepts, deviations
    included: a trailing comma is allowed, leading zeros are allowed, there
    is no range or finiteness check, duplicate keys are emitted in full and
    in document order, and keys are never validated as numeric.

RECORDS (--format=binary, the default)
    kind       u8   0x4e 'N' numeric token, 0x53 'S' string token
    key_len    u32  little-endian
    key        key_len bytes, verbatim, quotes included, escapes unprocessed
    value_len  u32  little-endian
    value      value_len bytes, verbatim; includes its quotes when kind is 0x53

    The caller reads a record with JSON.parse on the key, and Number or
    JSON.parse on the value depending on the kind. EOF plus exit 0 is the
    terminator. Length prefixes keep the framing unambiguous when a token
    contains a raw TAB, LF or CR, which a malformed token can and must.

RECORDS (--format=text)
    One line per record, the two raw tokens as written, for example
    {\"15\":1755979243867}. The same records in the same order, and still
    undecoded; this is a debugging view of the lexer, not of the values.

EXIT CODES
    0   success
    1   usage error
    2   parse error; the parser message is on stderr, newline terminated
    3   I/O error; a short description is on stderr

    On exit 2 every record completed before the failure has already been
    flushed, and no partial record has been written.
";

/// How records are written to stdout.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Format {
    /// The length-prefixed framing described in `--help`.
    #[default]
    Binary,
    /// One line per record, tokens verbatim.
    Text,
}

impl Format {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "binary" => Some(Self::Binary),
            "text" => Some(Self::Text),
            _ => None,
        }
    }
}

/// A parsed command line.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Options {
    /// Record format.
    pub format: Format,
}

impl Options {
    /// Reads the process arguments.
    ///
    /// `Ok(None)` means `--help` was asked for and the caller should print
    /// [`HELP`] and exit 0.
    pub fn from_env() -> Result<Option<Self>, String> {
        Self::parse(std::env::args_os().skip(1))
    }

    /// Parses an argument list that excludes the program name.
    pub fn parse<I>(args: I) -> Result<Option<Self>, String>
    where
        I: IntoIterator<Item = OsString>,
    {
        let mut options = Self::default();
        let mut args = args.into_iter();

        while let Some(arg) = args.next() {
            let text = arg
                .to_str()
                .ok_or_else(|| format!("argument is not valid UTF-8: {arg:?}"))?;

            if text == "-h" || text == "--help" {
                return Ok(None);
            }
            if let Some(value) = text.strip_prefix("--format=") {
                options.format = format_from(value)?;
                continue;
            }
            if text == "--format" {
                let value = args
                    .next()
                    .ok_or_else(|| "--format needs a value: binary or text".to_string())?;
                let value = value.to_str().ok_or_else(|| {
                    format!("--format value is not valid UTF-8: {value:?}")
                })?;
                options.format = format_from(value)?;
                continue;
            }
            return Err(format!("unexpected argument '{text}'"));
        }

        Ok(Some(options))
    }

    /// The `--help` text.
    pub fn help() -> &'static str {
        HELP
    }
}

fn format_from(value: &str) -> Result<Format, String> {
    Format::parse(value).ok_or_else(|| {
        format!("unknown --format value '{value}': expected binary or text")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> Result<Option<Options>, String> {
        Options::parse(args.iter().map(OsString::from))
    }

    fn format_of(args: &[&str]) -> Format {
        parse(args)
            .expect("expected a valid command line")
            .expect("expected no --help")
            .format
    }

    #[test]
    fn no_arguments_is_the_default() {
        assert_eq!(parse(&[]).unwrap(), Some(Options::default()));
        assert_eq!(Options::default().format, Format::Binary);
    }

    #[test]
    fn both_format_spellings_are_accepted() {
        assert_eq!(format_of(&["--format=text"]), Format::Text);
        assert_eq!(format_of(&["--format", "text"]), Format::Text);
        assert_eq!(format_of(&["--format=binary"]), Format::Binary);
        assert_eq!(format_of(&["--format", "binary"]), Format::Binary);
    }

    #[test]
    fn a_repeated_flag_keeps_the_last_value() {
        assert_eq!(format_of(&["--format=text", "--format=binary"]), Format::Binary);
        assert_eq!(format_of(&["--format=binary", "--format=text"]), Format::Text);
    }

    #[test]
    fn help_is_reported_for_both_spellings() {
        assert_eq!(parse(&["--help"]).unwrap(), None);
        assert_eq!(parse(&["-h"]).unwrap(), None);
        assert_eq!(parse(&["--format=text", "--help"]).unwrap(), None);
    }

    #[test]
    fn unknown_arguments_are_rejected() {
        for args in [
            vec!["--json"],
            vec!["-x"],
            vec!["text"],
            vec!["--"],
            vec!["--format=text", "extra"],
        ] {
            let error = parse(&args).unwrap_err();
            assert!(error.contains("unexpected argument"), "{error}");
            // The reason only. `main` adds the usage line once, so a parser
            // that quoted it here would print it twice.
            assert!(!error.contains(USAGE), "{error}");
        }
    }

    #[test]
    fn an_unknown_format_value_is_rejected() {
        let error = parse(&["--format=json"]).unwrap_err();
        assert!(error.contains("unknown --format value 'json'"), "{error}");
        let error = parse(&["--format=TEXT"]).unwrap_err();
        assert!(error.contains("unknown --format value 'TEXT'"), "{error}");
    }

    #[test]
    fn a_missing_format_value_is_rejected() {
        let error = parse(&["--format"]).unwrap_err();
        assert!(error.contains("--format needs a value"), "{error}");
    }

    #[test]
    fn help_documents_the_framing_and_the_exit_codes() {
        let help = Options::help();
        for needle in [
            "--format=binary",
            "0x4e",
            "0x53",
            "key_len",
            "value_len",
            "little-endian",
            "EOF plus exit 0",
            "verbatim",
            "USAGE",
        ] {
            assert!(help.contains(needle), "help is missing {needle:?}");
        }
        for code in ["0   success", "1   usage error", "2   parse error", "3   I/O error"] {
            assert!(help.contains(code), "help is missing {code:?}");
        }
    }
}
