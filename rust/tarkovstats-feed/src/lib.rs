//! `tarkovstats-feed` — a byte-level streaming lexer for the Tarkov "updated"
//! feed, ported from `createTimestampObjectParser` in
//! `scripts/regular-profile-sync-core.mjs`.
//!
//! The crate exists to move four things out of the Node process and leave
//! everything else where it already is:
//!
//! 1. the state machine ([`lexer`]),
//! 2. the seven error strings ([`error`]),
//! 3. the `final` wait/commit boundary logic ([`lexer`]),
//! 4. the ECMAScript whitespace set ([`whitespace`]).
//!
//! It deliberately does **not** decode string tokens, convert numbers, or
//! validate token contents. `JSON.parse` and `Number` stay in the Node reader,
//! where they are already written, already tested and already bit-exact,
//! including their sharp edges (`StringToNumber`'s `0x`/whitespace/`Infinity`/
//! rounding rules, `JSON.parse`'s WJSON and lone-surrogate rules). A token
//! that V8 would reject is still emitted, so the reader produces a
//! byte-identical `SyntaxError` with the same token-relative position instead
//! of a Rust message with a document-relative one.
//!
//! ```
//! use tarkovstats_feed::{Lexer, sink::CollectSink};
//!
//! let mut lexer = Lexer::new(CollectSink::new());
//! for chunk in [r#"{"7":1700000000"#, r#","8":"1700000001000"}"#] {
//!     lexer.append(chunk.as_bytes()).unwrap();
//! }
//! lexer.finish().unwrap();
//! let sink = lexer.into_sink();
//! assert_eq!(sink.keys(), vec![b"\"7\"".as_ref(), b"\"8\"".as_ref()]);
//! assert_eq!(sink.values(), vec![b"1700000000".as_ref(), b"\"1700000001000\"".as_ref()]);
//! ```

#![forbid(unsafe_code)]
#![warn(missing_docs)]
#![warn(clippy::pedantic)]
#![warn(rust_2018_idioms)]
#![allow(clippy::missing_errors_doc)]

pub mod error;
pub mod lexer;
pub mod record;
pub mod sink;
pub mod whitespace;

pub use error::{LexError, ParseError};
pub use lexer::{Lexer, State};
pub use record::{Kind, Record};
pub use sink::{BinarySink, CollectSink, Sink, TextSink};
