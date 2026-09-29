//! Record sinks: where completed entries go.
//!
//! Both output modes are reached through the single emission site in
//! [`crate::lexer::Lexer::parse`], which builds a [`Record`] and calls
//! [`Sink::record`]. Neither mode can therefore drift from the other, and
//! neither can drift from the state machine: a record is only ever constructed
//! after both tokens are complete and before the state advances past `value`.
//!
//! A record is written in one `write_all` from a fully assembled frame, so a
//! sink never hands a half-built record to the operating system. Records may
//! still be split across a pipe flush; the `u32` length prefixes are what make
//! the stream unambiguous when a token contains a raw `TAB`, `LF` or `CR`.

use std::io::{self, Write};

use crate::record::{Kind, Record};

/// Somewhere completed entries can go.
pub trait Sink {
    /// Writes one complete record.
    fn record(&mut self, record: &Record<'_>) -> io::Result<()>;

    /// Flushes and releases the sink. Called on both the success and the parse
    /// failure path, so the records written before a failure are never lost.
    fn finish(self) -> io::Result<()>;
}

/// Appends a `u32` little-endian length prefix, rejecting a token too long to
/// frame. A feed key or value past 4 GiB cannot be expressed in this framing,
/// and silently truncating the prefix would desynchronise the reader, so it is
/// reported as an I/O failure (exit 3) instead.
fn push_len(frame: &mut Vec<u8>, len: usize) -> io::Result<()> {
    let len = u32::try_from(len).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("token of {len} bytes does not fit the u32 length prefix"),
        )
    })?;
    frame.extend_from_slice(&len.to_le_bytes());
    Ok(())
}

/// The default `--format=binary` framing.
///
/// ```text
/// record := kind       : u8            'N' or 'S'
///        | key_len     : u32 little-endian
///        | key_bytes   : verbatim from stdin, quotes included
///        | value_len   : u32 little-endian
///        | value_bytes : verbatim from stdin
/// ```
pub struct BinarySink<W: Write> {
    out: W,
    frame: Vec<u8>,
}

impl<W: Write> BinarySink<W> {
    /// Wraps a writer, reusing one frame buffer across records.
    pub fn new(out: W) -> Self {
        Self {
            out,
            frame: Vec::with_capacity(64),
        }
    }
}

impl<W: Write> Sink for BinarySink<W> {
    fn record(&mut self, record: &Record<'_>) -> io::Result<()> {
        self.frame.clear();
        self.frame.push(record.kind.tag());
        push_len(&mut self.frame, record.key.len())?;
        self.frame.extend_from_slice(record.key);
        push_len(&mut self.frame, record.value.len())?;
        self.frame.extend_from_slice(record.value);
        self.out.write_all(&self.frame)
    }

    fn finish(mut self) -> io::Result<()> {
        self.out.flush()
    }
}

/// The `--format=text` debugging mode: one line per record, the two raw tokens
/// laid out as they appeared in the source, followed by `\n`.
///
/// Deliberately not a JSON document and deliberately not decoded: it shows the
/// lexer, not `JSON.parse` or `Number`.
pub struct TextSink<W: Write> {
    out: W,
    line: Vec<u8>,
}

impl<W: Write> TextSink<W> {
    /// Wraps a writer, reusing one line buffer across records.
    pub fn new(out: W) -> Self {
        Self {
            out,
            line: Vec::with_capacity(64),
        }
    }
}

impl<W: Write> Sink for TextSink<W> {
    fn record(&mut self, record: &Record<'_>) -> io::Result<()> {
        self.line.clear();
        self.line.push(b'{');
        self.line.extend_from_slice(record.key);
        self.line.push(b':');
        self.line.extend_from_slice(record.value);
        self.line.extend_from_slice(b"}\n");
        self.out.write_all(&self.line)
    }

    fn finish(mut self) -> io::Result<()> {
        self.out.flush()
    }
}

/// Keeps every record in memory. Used by the test suite, and by anyone who
/// wants to drive the state machine without a process boundary.
#[derive(Debug, Default)]
pub struct CollectSink {
    records: Vec<(Kind, Vec<u8>, Vec<u8>)>,
}

impl CollectSink {
    /// An empty collector.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Number of records emitted so far.
    #[must_use]
    pub fn len(&self) -> usize {
        self.records.len()
    }

    /// Whether nothing has been emitted yet.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.records.is_empty()
    }

    /// Every record as `(kind, key, value)`, in emission order.
    #[must_use]
    pub fn records(&self) -> &[(Kind, Vec<u8>, Vec<u8>)] {
        &self.records
    }

    /// The value tokens alone, in emission order, for compact assertions.
    #[must_use]
    pub fn values(&self) -> Vec<&[u8]> {
        self.records
            .iter()
            .map(|(_, _, value)| value.as_slice())
            .collect()
    }

    /// The key tokens alone, in emission order, for compact assertions.
    #[must_use]
    pub fn keys(&self) -> Vec<&[u8]> {
        self.records
            .iter()
            .map(|(_, key, _)| key.as_slice())
            .collect()
    }
}

impl Sink for CollectSink {
    fn record(&mut self, record: &Record<'_>) -> io::Result<()> {
        self.records.push((
            record.kind,
            record.key.to_vec(),
            record.value.to_vec(),
        ));
        Ok(())
    }

    fn finish(self) -> io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Size of a `u32` length prefix, asserted by the decoder below.
    const LENGTH_PREFIX: usize = 4;

    #[test]
    fn binary_sink_frames_records() {
        let mut out = Vec::new();
        let mut sink = BinarySink::new(&mut out);
        sink.record(&Record::new(b"\"1\"", Kind::Number, b"007")).unwrap();
        sink.record(&Record::new(b"\"2\"", Kind::String, b"\"x\""))
            .unwrap();
        sink.finish().unwrap();

        assert_eq!(
            out,
            vec![
                0x4E, 3, 0, 0, 0, b'"', b'1', b'"', 3, 0, 0, 0, b'0', b'0', b'7', 0x53, 3, 0, 0, 0, b'"', b'2',
                b'"', 3, 0, 0, 0, b'"', b'x', b'"',
            ]
        );
    }

    #[test]
    fn text_sink_writes_one_line_per_record() {
        let mut out = Vec::new();
        let mut sink = TextSink::new(&mut out);
        sink.record(&Record::new(b"\"1\"", Kind::Number, b"007"))
            .unwrap();
        sink.record(&Record::new(b"\"2\"", Kind::String, b"\"x\""))
            .unwrap();
        sink.finish().unwrap();
        assert_eq!(out, b"{\"1\":007}\n{\"2\":\"x\"}\n");
    }

    #[test]
    fn both_modes_agree_on_the_record_set() {
        let input: &[(&str, Kind, &str)] = &[
            ("\"1\"", Kind::Number, "0"),
            ("\"2\"", Kind::Number, "1E+5"),
            ("\"3\"", Kind::String, "\"a\tb\""),
        ];

        let mut binary = Vec::new();
        let mut sink = BinarySink::new(&mut binary);
        for (key, kind, value) in input {
            sink.record(&Record::new(key.as_bytes(), *kind, value.as_bytes()))
                .unwrap();
        }
        sink.finish().unwrap();

        let mut text = Vec::new();
        let mut sink = TextSink::new(&mut text);
        for (key, kind, value) in input {
            sink.record(&Record::new(key.as_bytes(), *kind, value.as_bytes()))
                .unwrap();
        }
        sink.finish().unwrap();

        // Both modes saw the same three records in the same order, and the text
        // mode is a lossless view of the binary one for printable tokens.
        let decoded = decode(&binary);
        assert_eq!(decoded, vec![
            (0x4E, b"\"1\"".to_vec(), b"0".to_vec()),
            (0x4E, b"\"2\"".to_vec(), b"1E+5".to_vec()),
            (0x53, b"\"3\"".to_vec(), b"\"a\tb\"".to_vec()),
        ]);
        assert_eq!(
            String::from_utf8(text).unwrap(),
            "{\"1\":0}\n{\"2\":1E+5}\n{\"3\":\"a\tb\"}\n"
        );
    }

    #[test]
    fn a_token_containing_raw_control_bytes_stays_framed() {
        // The reason the framing is length-prefixed: a malformed string token
        // can carry a raw LF, and it must reach JSON.parse rather than be
        // pre-rejected or re-framed.
        let mut binary = Vec::new();
        let mut sink = BinarySink::new(&mut binary);
        sink.record(&Record::new(b"\"k\"", Kind::String, b"\"a\nb\"c\""))
            .unwrap();
        sink.finish().unwrap();
        assert_eq!(decode(&binary), vec![(0x53, b"\"k\"".to_vec(), b"\"a\nb\"c\"".to_vec())]);
    }

    #[test]
    fn a_sink_failure_is_reported_not_swallowed() {
        struct Broken;
        impl Write for Broken {
            fn write(&mut self, _: &[u8]) -> io::Result<usize> {
                Err(io::Error::new(io::ErrorKind::BrokenPipe, "nope"))
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        let mut sink = BinarySink::new(Broken);
        let error = sink
            .record(&Record::new(b"\"1\"", Kind::Number, b"1"))
            .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::BrokenPipe);
    }

    fn decode(bytes: &[u8]) -> Vec<(u8, Vec<u8>, Vec<u8>)> {
        let mut out = Vec::new();
        let mut at = 0;
        while at < bytes.len() {
            let kind = bytes[at];
            at += 1;
            let key_len = read_len(bytes, &mut at);
            let key = bytes[at..at + key_len].to_vec();
            at += key_len;
            let value_len = read_len(bytes, &mut at);
            let value = bytes[at..at + value_len].to_vec();
            at += value_len;
            out.push((kind, key, value));
        }
        out
    }

    fn read_len(bytes: &[u8], at: &mut usize) -> usize {
        let len = u32::from_le_bytes(bytes[*at..*at + LENGTH_PREFIX].try_into().unwrap());
        *at += LENGTH_PREFIX;
        len as usize
    }
}
