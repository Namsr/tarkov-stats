//! The ECMAScript `\s` set, one code unit at a time, hard-coded as UTF-8 bytes.
//!
//! The original tests whitespace with `/\s/.test(buffer[position] ?? "")`, which
//! is the full ECMAScript set and not the six ASCII bytes most ports reach for.
//! A byte-oriented `skip_whitespace` that only skips `09 0A 0B 0C 0D 20`
//! **rejects documents the original accepts**, and the existing Node test suite
//! does not notice, because no fixture contains a non-ASCII space.
//!
//! Included:
//!
//! | codepoint        | bytes         |
//! |------------------|---------------|
//! | U+0009 U+000A U+000B U+000C U+000D | one byte each |
//! | U+0020           | `20`          |
//! | U+00A0           | `C2 A0`       |
//! | U+1680           | `E1 9A 80`    |
//! | U+2000–U+200A    | `E2 80 80`–`E2 80 8A` |
//! | U+2028 U+2029    | `E2 80 A8` `E2 80 A9` |
//! | U+202F           | `E2 80 AF`    |
//! | U+205F           | `E2 81 9F`    |
//! | U+3000           | `E3 80 80`    |
//! | U+FEFF           | `EF BB BF`    |
//!
//! Excluded, all three verified against the original in every state:
//!
//! | codepoint        | bytes         |
//! |------------------|---------------|
//! | U+200B           | `E2 80 8B`    |
//! | U+0085           | `C2 85`       |
//! | U+180E           | `E1 A0 8E`    |
//!
//! ## Why bytes are safe here
//!
//! The original tests a single UTF-16 code unit. A byte scan can only disagree
//! if an ASCII byte could appear inside a multi-byte sequence, and it cannot:
//! UTF-8 continuation bytes are all `0x80..=0xBF`, so the ASCII bytes this
//! module matches are never continuation bytes.
//!
//! ## Why a partial sequence is a third answer, not "not whitespace"
//!
//! The original is fed decoded text, so its buffer never contains half a
//! character: `TextDecoder({ stream: true })` **holds** a partial sequence
//! across a chunk boundary and emits nothing for it until the rest arrives. A
//! byte-oriented port has no decoder in front of it, so its buffer can end in
//! the middle of a sequence — at a 64 KiB read boundary, or anywhere a caller
//! chooses to split.
//!
//! Reporting that as "not whitespace" would make the port reject documents the
//! original accepts: `{` + 65 534 spaces + `C2 A0` + `"1":2}` has its `U+00A0`
//! split by the first read, and the port would see `C2` in the `key` state and
//! fail with `expected JSON string`. The original holds the `C2`, sees nothing,
//! waits for the next chunk, and parses the document.
//!
//! So the scanner distinguishes three outcomes. A proper prefix of a member
//! means *wait* on a non-final chunk, and means *not whitespace* on the final
//! one, which is what the original sees at EOF: `TextDecoder` flushes an
//! incomplete trailing sequence as `U+FFFD`, and `U+FFFD` is not whitespace.
//!
//! The distinction is only ever drawn for prefixes of **included** sequences, so
//! the three exclusions keep rejecting at every split: `U+200B` and `U+0085`
//! wait on their first one or two bytes, because those bytes really are
//! ambiguous with `U+2000`–`U+200A` and `U+00A0`, and then reject on the byte
//! that tells them apart. `U+180E` starts `E1 A0`, which no member starts, so
//! it rejects immediately without waiting.

/// What is at the front of a byte slice, as far as the `\s` set is concerned.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Whitespace {
    /// A complete member of the set, this many bytes long.
    Run(usize),
    /// A proper prefix of a member, running to the end of the slice, so more
    /// bytes could still complete it. Always followed by more bytes being
    /// available, never by a decision.
    Partial(usize),
    /// Not a member, and no continuation of these bytes could make it one. The
    /// whitespace run ends here.
    None,
}

/// Classifies the bytes at the front of `bytes`.
///
/// `Partial` is only ever returned for a slice that is *exactly* a prefix of a
/// member, so "running to the end of the buffer" is structural rather than a
/// separate check.
#[must_use]
pub fn whitespace_at(bytes: &[u8]) -> Whitespace {
    // One arm per codepoint rather than one merged arm: the tables in the
    // module docs are the specification, and this is the same table in bytes.
    #[allow(clippy::match_same_arms)]
    match bytes {
        [b'\t'..=b'\r' | b' ', ..] => Whitespace::Run(1),
        [0xC2, 0xA0, ..] => Whitespace::Run(2),               // U+00A0
        [0xC2] => Whitespace::Partial(1),                     // ...or U+00A0
        [0xC2, ..] => Whitespace::None,                       // not U+0085
        [0xE1, 0x9A, 0x80, ..] => Whitespace::Run(3),         // U+1680
        [0xE1, 0x9A] => Whitespace::Partial(2),
        [0xE1] => Whitespace::Partial(1),
        // `E1 A0` is the start of the excluded U+180E and of nothing included.
        [0xE1, ..] => Whitespace::None,
        [0xE2, 0x80, 0x80..=0x8A, ..] => Whitespace::Run(3),  // U+2000..U+200A
        [0xE2, 0x80, 0xA8, ..] => Whitespace::Run(3),         // U+2028
        [0xE2, 0x80, 0xA9, ..] => Whitespace::Run(3),         // U+2029
        [0xE2, 0x80, 0xAF, ..] => Whitespace::Run(3),         // U+202F
        [0xE2, 0x80] => Whitespace::Partial(2),
        // `E2 80 8B` is the excluded U+200B, and so is `E2 80 8C`..`E2 80 AD`.
        [0xE2, 0x80, ..] => Whitespace::None,
        [0xE2, 0x81, 0x9F, ..] => Whitespace::Run(3),         // U+205F
        [0xE2, 0x81] => Whitespace::Partial(2),
        [0xE2, 0x81, ..] => Whitespace::None,
        [0xE2] => Whitespace::Partial(1),
        [0xE2, ..] => Whitespace::None,
        [0xE3, 0x80, 0x80, ..] => Whitespace::Run(3),         // U+3000
        [0xE3, 0x80] => Whitespace::Partial(2),
        [0xE3] => Whitespace::Partial(1),
        [0xE3, ..] => Whitespace::None,
        [0xEF, 0xBB, 0xBF, ..] => Whitespace::Run(3),         // U+FEFF
        [0xEF, 0xBB] => Whitespace::Partial(2),
        [0xEF] => Whitespace::Partial(1),
        [0xEF, ..] => Whitespace::None,
        // An empty slice, or any byte that starts nothing in the set.
        _ => Whitespace::None,
    }
}

/// `skipWhitespace` from the original, with the wait the decoder would have
/// given for free.
///
/// Skips the whitespace run at `buf[*position]` and reports whether the machine
/// must wait for more input: `true` means the buffer ends in a proper prefix of
/// a member and the rest of it has not arrived, which is what
/// `TextDecoder({ stream: true })` would do by not emitting the bytes at all.
///
/// `final_chunk` suppresses the wait, which is the EOF behaviour: the decoder
/// flushes an incomplete trailing sequence as `U+FFFD`, `U+FFFD` is not
/// whitespace, and the run ends there.
pub fn skip_whitespace(buf: &[u8], position: &mut usize, final_chunk: bool) -> bool {
    loop {
        match whitespace_at(&buf[*position..]) {
            Whitespace::Run(width) => *position += width,
            Whitespace::Partial(_) => return !final_chunk,
            Whitespace::None => return false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const INCLUDED: &[(&str, u32)] = &[
        ("U+0009 TAB", 0x0009),
        ("U+000A LF", 0x000a),
        ("U+000B VT", 0x000b),
        ("U+000C FF", 0x000c),
        ("U+000D CR", 0x000d),
        ("U+0020 SPACE", 0x0020),
        ("U+00A0 NO-BREAK SPACE", 0x00a0),
        ("U+1680 OGHAM SPACE MARK", 0x1680),
        ("U+2000 EN QUAD", 0x2000),
        ("U+2001 EM QUAD", 0x2001),
        ("U+2002 EN SPACE", 0x2002),
        ("U+2003 EM SPACE", 0x2003),
        ("U+2004 THREE-PER-EM SPACE", 0x2004),
        ("U+2005 FOUR-PER-EM SPACE", 0x2005),
        ("U+2006 SIX-PER-EM SPACE", 0x2006),
        ("U+2007 FIGURE SPACE", 0x2007),
        ("U+2008 PUNCTUATION SPACE", 0x2008),
        ("U+2009 THIN SPACE", 0x2009),
        ("U+200A HAIR SPACE", 0x200a),
        ("U+2028 LINE SEPARATOR", 0x2028),
        ("U+2029 PARAGRAPH SEPARATOR", 0x2029),
        ("U+202F NARROW NO-BREAK SPACE", 0x202f),
        ("U+205F MEDIUM MATHEMATICAL SPACE", 0x205f),
        ("U+3000 IDEOGRAPHIC SPACE", 0x3000),
        ("U+FEFF ZERO WIDTH NO-BREAK SPACE", 0xfeff),
    ];

    const EXCLUDED: &[(&str, u32)] = &[
        ("U+200B ZERO WIDTH SPACE", 0x200b),
        ("U+0085 NEXT LINE", 0x0085),
        ("U+180E MONGOLIAN VOWEL SEPARATOR", 0x180e),
    ];

    fn bytes_of(value: u32) -> Vec<u8> {
        char::from_u32(value).unwrap().to_string().into_bytes()
    }

    #[test]
    fn every_included_codepoint_is_a_complete_run() {
        for (name, value) in INCLUDED {
            let bytes = bytes_of(*value);
            assert_eq!(
                whitespace_at(&bytes),
                Whitespace::Run(bytes.len()),
                "{name}"
            );
        }
    }

    #[test]
    fn the_three_exclusions_are_not_whitespace() {
        for (name, value) in EXCLUDED {
            let bytes = bytes_of(*value);
            assert_eq!(whitespace_at(&bytes), Whitespace::None, "{name}");
            let mut position = 0;
            assert!(!skip_whitespace(&bytes, &mut position, false), "{name}");
            assert_eq!(position, 0, "{name}");
        }
    }

    #[test]
    fn an_exclusion_waited_on_only_while_it_was_ambiguous() {
        // U+200B is `E2 80 8B`. Its first two bytes are a real prefix of
        // U+2000..U+200A, so the scanner has to wait for the byte that settles
        // it; once the `8B` arrives it rejects.
        let mut position = 0;
        assert!(skip_whitespace(&[0xE2], &mut position, false));
        assert_eq!(position, 0);
        assert!(skip_whitespace(&[0xE2, 0x80], &mut position, false));
        assert_eq!(position, 0);
        assert!(!skip_whitespace(b"\xE2\x80\x8B", &mut position, false));
        assert_eq!(position, 0);

        // U+0085 is `C2 85`, and `C2` alone is ambiguous with U+00A0.
        assert!(skip_whitespace(&[0xC2], &mut position, false));
        assert!(!skip_whitespace(b"\xC2\x85", &mut position, false));
        assert_eq!(position, 0);

        // U+180E is `E1 A0 8E`. A lone `E1` is a real prefix of U+1680, so it
        // waits; `E1 A0` is the prefix of nothing in the set, so the decision
        // is already final and there is nothing to wait for.
        assert!(skip_whitespace(b"\xE1", &mut position, false));
        assert_eq!(position, 0);
        for prefix in [b"\xE1\xA0".as_slice(), b"\xE1\xA0\x8E"] {
            assert!(!skip_whitespace(prefix, &mut position, false), "{prefix:02X?}");
            assert_eq!(position, 0, "{prefix:02X?}");
        }
    }

    #[test]
    fn every_proper_prefix_of_a_member_is_partial() {
        for (name, value) in INCLUDED {
            let bytes = bytes_of(*value);
            if bytes.len() < 2 {
                continue;
            }
            for cut in 1..bytes.len() {
                assert_eq!(
                    whitespace_at(&bytes[..cut]),
                    Whitespace::Partial(cut),
                    "{name} cut at {cut}"
                );
                let mut position = 0;
                assert!(skip_whitespace(&bytes[..cut], &mut position, false), "{name} cut at {cut}");
                assert_eq!(position, 0, "{name} cut at {cut}");
            }
        }
    }

    #[test]
    fn a_partial_prefix_is_not_a_wait_at_the_end_of_input() {
        // The decoder flushes an incomplete trailing sequence as U+FFFD, which
        // is not whitespace, so the run ends and the state machine sees the
        // bytes. This is the EOF behaviour and it must not change.
        let prefixes: [&[u8]; 10] = [
            b"\xC2", b"\xE1", b"\xE1\x9A", b"\xE2", b"\xE2\x80", b"\xE2\x81", b"\xE3", b"\xE3\x80",
            b"\xEF", b"\xEF\xBB",
        ];
        for prefix in prefixes {
            assert_eq!(
                whitespace_at(prefix),
                Whitespace::Partial(prefix.len()),
                "{prefix:02X?}"
            );
            let mut position = 0;
            assert!(!skip_whitespace(prefix, &mut position, true), "{prefix:02X?}");
            assert_eq!(position, 0, "{prefix:02X?}");
        }
    }

    #[test]
    fn a_prefix_followed_by_the_wrong_byte_is_not_whitespace() {
        // Only a prefix that runs to the end of the buffer is ambiguous.
        let cases: [(&[u8], &[u8]); 6] = [
            (b"\xC2", b"\xC2A"),
            (b"\xE1\x9A", b"\xE1\x9Ax"),
            (b"\xE2\x80", b"\xE2\x80 "),
            (b"\xE2\x80", b"\xE2\x80#"),
            (b"\xE3\x80", b"\xE3\x80A"),
            (b"\xEF\xBB", b"\xEF\xBBA"),
        ];
        for (lead, wrong) in cases {
            assert_eq!(whitespace_at(lead), Whitespace::Partial(lead.len()), "{lead:02X?}");
            assert_eq!(whitespace_at(wrong), Whitespace::None, "{wrong:02X?}");
            let mut position = 0;
            assert!(!skip_whitespace(wrong, &mut position, false), "{wrong:02X?}");
            assert_eq!(position, 0, "{wrong:02X?}");
        }
    }

    #[test]
    fn neighbours_of_u200a_are_not_whitespace() {
        assert_eq!(whitespace_at("\u{2000}".as_bytes()), Whitespace::Run(3));
        assert_eq!(whitespace_at("\u{200A}".as_bytes()), Whitespace::Run(3));
        assert_eq!(whitespace_at("\u{200B}".as_bytes()), Whitespace::None);
        assert_eq!(whitespace_at("\u{1FFF}".as_bytes()), Whitespace::None);
        assert_eq!(whitespace_at("\u{9F}".as_bytes()), Whitespace::None);
        assert_eq!(whitespace_at("\u{A1}".as_bytes()), Whitespace::None);
    }

    #[test]
    fn neighbours_of_the_other_multi_byte_members_are_not_whitespace() {
        for wrong in [
            "\u{167F}", "\u{1681}", "\u{180D}", "\u{180F}", "\u{2027}", "\u{202A}", "\u{202E}",
            "\u{2030}", "\u{205E}", "\u{2060}", "\u{2FFF}", "\u{3001}", "\u{FEFE}", "\u{FF00}",
        ] {
            assert_eq!(whitespace_at(wrong.as_bytes()), Whitespace::None, "{wrong:?}");
        }
    }

    #[test]
    fn runs_of_every_member_are_consumed_in_order() {
        let mut mixed = Vec::new();
        for (_, value) in INCLUDED {
            mixed.extend_from_slice(&bytes_of(*value));
        }
        let mut position = 0;
        assert!(!skip_whitespace(&mixed, &mut position, false));
        assert_eq!(position, mixed.len());

        mixed.extend_from_slice(b"x");
        position = 0;
        assert!(!skip_whitespace(&mixed, &mut position, false));
        assert_eq!(position, mixed.len() - 1);
    }

    #[test]
    fn an_exclusion_in_the_middle_stops_the_run() {
        let mut mixed = b" \xC2\xA0".to_vec();
        mixed.extend_from_slice("\u{200B}\u{00A0} ".as_bytes());
        let mut position = 0;
        assert!(!skip_whitespace(&mixed, &mut position, false));
        assert_eq!(position, 3);
        assert_eq!(&mixed[3..], "\u{200B}\u{00A0} ".as_bytes());
    }

    #[test]
    fn an_empty_slice_is_never_whitespace() {
        assert_eq!(whitespace_at(&[]), Whitespace::None);
        let mut position = 0;
        assert!(!skip_whitespace(&[], &mut position, false));
        assert_eq!(position, 0);
    }
}
