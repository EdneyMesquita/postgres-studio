//! Splits SQL text into statements, the way the server would read it.
//!
//! The console runs the statement at the caret, the Assistant may run
//! exactly one statement, and each statement is prepared on its own to learn
//! its result columns - all of that needs the boundaries first. Semicolons
//! inside quotes, quoted identifiers, dollar-quoted bodies and comments
//! don't end a statement. Offsets are byte offsets into the original text,
//! so an error position from the server maps back to the editor.
//!
//! `split` reads a whole string. `Splitter` is the same reader fed in
//! pieces, for files too big to hold: it keeps its state between `feed`
//! calls, so a quote, a dollar tag or a comment may straddle two pieces. It
//! can also step around the data of a `COPY ... FROM stdin` block and the
//! psql meta-commands (`\connect`, `\set`) a dump holds.

/// One statement and where it sits in the text it came from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Statement {
    /// The statement without the trailing semicolon, trimmed.
    pub text: String,
    /// Byte offset of `text`'s first character in the original.
    pub start: usize,
    /// Byte offset just past the statement's last character (before the
    /// semicolon, if any).
    pub end: usize,
    /// 1-based line of the statement's first token, past any comments
    /// before it.
    pub line: u64,
}

/// What a `Splitter` found, in file order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    Statement(Statement),
    /// A psql meta-command line (`\connect shop`), without the newline.
    Meta {
        line: u64,
        text: String,
    },
    /// A `COPY ... FROM stdin` statement; its data follows as `CopyData`
    /// events, then `CopyEnd`.
    CopyStart(Statement),
    /// Raw data lines of the COPY, newlines included, without the `\.`.
    CopyData(Vec<u8>),
    /// The COPY data is over: `terminated` is false when the input ended
    /// before the `\.` line.
    CopyEnd {
        terminated: bool,
    },
}

/// What a splitter does beyond reading plain statements.
#[derive(Debug, Clone, Copy, Default)]
pub struct SplitterOptions {
    /// Lines starting with `\` where a statement could begin are meta-commands.
    pub meta_commands: bool,
    /// The data after `COPY ... FROM stdin;` is not SQL: pass it through.
    pub copy_data: bool,
}

/// The statements in `sql`, skipping empty ones and ones that hold only
/// comments.
pub fn split(sql: &str) -> Vec<Statement> {
    let mut splitter = Splitter::new(SplitterOptions::default());
    let mut events = Vec::new();
    splitter.feed(sql.as_bytes(), &mut events);
    splitter.finish(&mut events);
    events
        .into_iter()
        .filter_map(|e| match e {
            Event::Statement(s) => Some(s),
            _ => None,
        })
        .collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    Normal,
    /// Saw `-`; a second one starts a comment.
    Dash,
    /// Saw `/`; a `*` starts a block comment.
    Slash,
    LineComment,
    /// `prev` is the last byte, for spotting `/*` and `*/`.
    Block {
        depth: usize,
        prev: u8,
    },
    Quote {
        quote: u8,
        escapes: bool,
        escaped: bool,
        /// Saw the quote char: a second one means it was doubled.
        closing: bool,
    },
    /// After a `$`, reading what may be a dollar-quote tag.
    DollarOpen,
    DollarBody,
    Word,
    Meta,
    CopyData,
}

/// Longest dollar-quote tag looked for; longer is not a tag.
const MAX_TAG: usize = 64;
/// Words are only compared against short keywords.
const MAX_WORD: usize = 16;

/// An incremental statement splitter.
pub struct Splitter {
    options: SplitterOptions,
    state: State,
    /// Bytes fed so far, before the one being read.
    pos: usize,
    /// 1-based line of the byte being read.
    line: u64,
    prev: u8,
    prev2: u8,
    /// Bytes of the statement being read, with its leading blanks and comments.
    cur: Vec<u8>,
    cur_start: usize,
    /// A statement counts once it has a token outside comments.
    has_code: bool,
    code_line: u64,
    /// Where the pending `-`, `/` or `$` began.
    tok_line: u64,
    /// `BEGIN ATOMIC ... END` bodies (SQL-standard function bodies) hold
    /// semicolons; track the nesting so they don't end the statement.
    atomic_depth: usize,
    words: [Vec<u8>; 2],
    word: Vec<u8>,
    /// The dollar tag being read or closed, `$` to `$`.
    tag: Vec<u8>,
    /// Bytes since the last `$` in a dollar body.
    since_dollar: Vec<u8>,
    meta: Vec<u8>,
    meta_line: u64,
    /// Inside COPY data: the rest of the COPY statement's own line is dropped.
    copy_skip_line: bool,
    /// The start of a line that may be the `\.` terminator.
    copy_head: Vec<u8>,
    /// Inside a COPY line that can't be the terminator.
    copy_plain: bool,
    copy_out: Vec<u8>,
}

impl Splitter {
    pub fn new(options: SplitterOptions) -> Self {
        Splitter {
            options,
            state: State::Normal,
            pos: 0,
            line: 1,
            prev: 0,
            prev2: 0,
            cur: Vec::new(),
            cur_start: 0,
            has_code: false,
            code_line: 1,
            tok_line: 1,
            atomic_depth: 0,
            words: [Vec::new(), Vec::new()],
            word: Vec::new(),
            tag: Vec::new(),
            since_dollar: Vec::new(),
            meta: Vec::new(),
            meta_line: 1,
            copy_skip_line: false,
            copy_head: Vec::new(),
            copy_plain: false,
            copy_out: Vec::new(),
        }
    }

    /// Reads the next piece of the input, appending what it completes.
    pub fn feed(&mut self, chunk: &[u8], out: &mut Vec<Event>) {
        for &b in chunk {
            self.byte(b, out);
        }
        if !self.copy_out.is_empty() {
            out.push(Event::CopyData(std::mem::take(&mut self.copy_out)));
        }
    }

    /// The input is over: completes the last statement, which needs no
    /// closing semicolon.
    pub fn finish(&mut self, out: &mut Vec<Event>) {
        match self.state {
            State::Dash | State::Slash => self.mark_code(self.tok_line),
            State::DollarOpen => {
                if self.tag.len() > 1 {
                    self.mark_code(self.tok_line);
                }
            }
            State::Word => self.end_word(),
            State::Meta => self.end_meta(out),
            State::CopyData => {
                // A `\.` with no newline after it still ends the data.
                let ended = matches!(self.copy_head.as_slice(), b"\\." | b"\\.\r");
                if !ended {
                    self.copy_out.append(&mut self.copy_head);
                }
                if !self.copy_out.is_empty() {
                    out.push(Event::CopyData(std::mem::take(&mut self.copy_out)));
                }
                out.push(Event::CopyEnd { terminated: ended });
                self.state = State::Normal;
                return;
            }
            _ => {}
        }
        if self.has_code {
            let end = self.pos;
            self.emit(end, false, out);
        }
    }

    fn mark_code(&mut self, line: u64) {
        if !self.has_code {
            self.has_code = true;
            self.code_line = line;
        }
    }

    fn end_word(&mut self) {
        let word = std::mem::take(&mut self.word);
        if word == b"atomic" && self.words[1] == b"begin" {
            self.atomic_depth += 1;
        } else if self.atomic_depth > 0 && (word == b"case" || word == b"begin") {
            // `CASE ... END` and nested blocks also close with END.
            self.atomic_depth += 1;
        } else if self.atomic_depth > 0 && word == b"end" {
            self.atomic_depth -= 1;
        }
        let older = std::mem::replace(&mut self.words[1], word);
        self.words[0] = older;
        self.state = State::Normal;
    }

    fn end_meta(&mut self, out: &mut Vec<Event>) {
        let text = String::from_utf8_lossy(&self.meta).trim_end().to_string();
        self.meta.clear();
        out.push(Event::Meta {
            line: self.meta_line,
            text,
        });
        self.state = State::Normal;
        self.cur.clear();
        // The newline ending the meta-command is the byte being read.
        self.cur_start = self.pos + 1;
    }

    /// Completes the statement in `cur` (which ends before `end`, a
    /// semicolon or the end of input) and starts the next one.
    fn emit(&mut self, end: usize, drop_semicolon: bool, out: &mut Vec<Event>) {
        if drop_semicolon {
            self.cur.pop();
        }
        let bytes = std::mem::take(&mut self.cur);
        let raw = String::from_utf8(bytes)
            .unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned());
        let lead = raw.len() - raw.trim_start().len();
        let text = raw.trim().to_string();
        let start = self.cur_start + lead;
        let statement = Statement {
            end: start + text.len(),
            start,
            text,
            line: self.code_line,
        };
        self.cur_start = end + 1;
        self.has_code = false;
        self.words = [Vec::new(), Vec::new()];
        if self.options.copy_data && copies_from_stdin(&statement.text) {
            out.push(Event::CopyStart(statement));
            self.state = State::CopyData;
            self.copy_skip_line = true;
            self.copy_head.clear();
            self.copy_plain = false;
        } else {
            out.push(Event::Statement(statement));
        }
    }

    fn byte(&mut self, b: u8, out: &mut Vec<Event>) {
        if self.state == State::CopyData {
            self.copy_byte(b, out);
        } else if self.state == State::Meta {
            if b == b'\n' {
                self.end_meta(out);
            } else {
                self.meta.push(b);
            }
        } else {
            self.cur.push(b);
            // A state may end on this byte and hand it to the next one.
            while !self.step(b, out) {}
        }
        self.pos += 1;
        if b == b'\n' {
            self.line += 1;
        }
        self.prev2 = self.prev;
        self.prev = b;
    }

    /// Reads `b` in the current state; false when the new state must read
    /// it again.
    fn step(&mut self, b: u8, out: &mut Vec<Event>) -> bool {
        match self.state {
            State::Normal => self.normal(b, out),
            State::Dash => {
                if b == b'-' {
                    self.state = State::LineComment;
                    true
                } else {
                    self.mark_code(self.tok_line);
                    self.state = State::Normal;
                    false
                }
            }
            State::Slash => {
                if b == b'*' {
                    self.state = State::Block { depth: 1, prev: 0 };
                    true
                } else {
                    self.mark_code(self.tok_line);
                    self.state = State::Normal;
                    false
                }
            }
            State::LineComment => {
                if b == b'\n' {
                    self.state = State::Normal;
                }
                true
            }
            State::Block { depth, prev } => {
                // Block comments nest in PostgreSQL.
                self.state = if prev == b'/' && b == b'*' {
                    State::Block {
                        depth: depth + 1,
                        prev: 0,
                    }
                } else if prev == b'*' && b == b'/' {
                    if depth == 1 {
                        State::Normal
                    } else {
                        State::Block {
                            depth: depth - 1,
                            prev: 0,
                        }
                    }
                } else {
                    State::Block { depth, prev: b }
                };
                true
            }
            State::Quote {
                quote,
                escapes,
                escaped,
                closing,
            } => {
                if closing {
                    // A doubled quote is an escaped one.
                    if b == quote {
                        self.state = State::Quote {
                            quote,
                            escapes,
                            escaped: false,
                            closing: false,
                        };
                        return true;
                    }
                    self.state = State::Normal;
                    return false;
                }
                self.state = if escaped {
                    State::Quote {
                        quote,
                        escapes,
                        escaped: false,
                        closing: false,
                    }
                } else if escapes && b == b'\\' {
                    State::Quote {
                        quote,
                        escapes,
                        escaped: true,
                        closing: false,
                    }
                } else if b == quote {
                    State::Quote {
                        quote,
                        escapes,
                        escaped: false,
                        closing: true,
                    }
                } else {
                    return true;
                };
                true
            }
            State::DollarOpen => self.dollar_open(b),
            State::DollarBody => {
                if b == b'$' {
                    if self.since_dollar.len() + 1 == self.tag.len()
                        && self.since_dollar == self.tag[..self.tag.len() - 1]
                    {
                        self.state = State::Normal;
                        self.since_dollar.clear();
                    } else {
                        self.since_dollar.clear();
                        self.since_dollar.push(b'$');
                    }
                } else if !self.since_dollar.is_empty() {
                    if self.since_dollar.len() < self.tag.len() {
                        self.since_dollar.push(b);
                    } else {
                        self.since_dollar.clear();
                    }
                }
                true
            }
            State::Word => {
                if is_ident_byte(b) {
                    if self.word.len() < MAX_WORD {
                        self.word.push(b.to_ascii_lowercase());
                    }
                    true
                } else {
                    self.end_word();
                    false
                }
            }
            State::Meta | State::CopyData => true,
        }
    }

    fn normal(&mut self, b: u8, out: &mut Vec<Event>) -> bool {
        match b {
            b'-' => {
                self.state = State::Dash;
                self.tok_line = self.line;
            }
            b'/' => {
                self.state = State::Slash;
                self.tok_line = self.line;
            }
            b'\'' => {
                self.mark_code(self.line);
                // E'...' strings take backslash escapes; others only ''.
                let escapes = matches!(self.prev, b'e' | b'E') && !is_ident_byte(self.prev2);
                self.state = State::Quote {
                    quote: b'\'',
                    escapes,
                    escaped: false,
                    closing: false,
                };
            }
            b'"' => {
                self.mark_code(self.line);
                self.state = State::Quote {
                    quote: b'"',
                    escapes: false,
                    escaped: false,
                    closing: false,
                };
            }
            b'$' => {
                if !is_ident_byte(self.prev) {
                    self.state = State::DollarOpen;
                    self.tok_line = self.line;
                    self.tag.clear();
                    self.tag.push(b'$');
                }
            }
            b';' if self.atomic_depth == 0 => {
                if self.has_code {
                    self.emit(self.pos, true, out);
                } else {
                    self.cur.clear();
                    self.cur_start = self.pos + 1;
                }
            }
            b'\\' if self.options.meta_commands && !self.has_code => {
                // The backslash went into `cur` with the blanks before it.
                self.cur.pop();
                self.state = State::Meta;
                self.meta.clear();
                self.meta.push(b'\\');
                self.meta_line = self.line;
            }
            _ if is_ident_start(b) && !is_ident_byte(self.prev) => {
                self.mark_code(self.line);
                self.state = State::Word;
                self.word.clear();
                self.word.push(b.to_ascii_lowercase());
            }
            _ => {
                if !b.is_ascii_whitespace() {
                    self.mark_code(self.line);
                }
            }
        }
        true
    }

    /// After `$`: `$$` or `$tag$` opens a dollar quote; `$1` (a parameter)
    /// and anything else is not one.
    fn dollar_open(&mut self, b: u8) -> bool {
        let first = self.tag.len() == 1;
        if b == b'$' {
            self.tag.push(b'$');
            self.mark_code(self.tok_line);
            self.state = State::DollarBody;
            self.since_dollar.clear();
            return true;
        }
        let fits = if first {
            is_ident_start(b)
        } else {
            is_ident_byte(b)
        };
        if fits && self.tag.len() < MAX_TAG {
            self.tag.push(b);
            return true;
        }
        if !first {
            self.mark_code(self.tok_line);
        }
        self.state = State::Normal;
        false
    }

    /// One byte of COPY data. Lines go through as they are; only a line
    /// that is exactly `\.` ends the data.
    fn copy_byte(&mut self, b: u8, out: &mut Vec<Event>) {
        if self.copy_skip_line {
            self.copy_skip_line = b != b'\n';
            return;
        }
        if self.copy_plain {
            self.copy_out.push(b);
            self.copy_plain = b != b'\n';
            return;
        }
        match (self.copy_head.len(), b) {
            (0, b'\\') | (1, b'.') | (2, b'\r') => self.copy_head.push(b),
            (2 | 3, b'\n') if matches!(self.copy_head.as_slice(), b"\\." | b"\\.\r") => {
                if !self.copy_out.is_empty() {
                    out.push(Event::CopyData(std::mem::take(&mut self.copy_out)));
                }
                out.push(Event::CopyEnd { terminated: true });
                self.copy_head.clear();
                self.state = State::Normal;
                self.cur.clear();
                self.cur_start = self.pos + 1;
            }
            _ => {
                self.copy_out.append(&mut self.copy_head);
                self.copy_out.push(b);
                self.copy_plain = b != b'\n';
            }
        }
    }
}

/// Whether a statement is `COPY ... FROM stdin`, whose data comes right
/// after it in the same input.
pub fn copies_from_stdin(text: &str) -> bool {
    let mut rest = text.trim_start();
    // Leading comments stay with the statement.
    loop {
        if let Some(after) = rest.strip_prefix("--") {
            rest = after.split_once('\n').map_or("", |(_, r)| r).trim_start();
        } else if let Some(after) = rest.strip_prefix("/*") {
            rest = after.split_once("*/").map_or("", |(_, r)| r).trim_start();
        } else {
            break;
        }
    }
    let lower = rest.to_ascii_lowercase();
    if !lower.starts_with("copy") || lower.as_bytes().get(4).is_some_and(|&b| is_ident_byte(b)) {
        return false;
    }
    // Words outside quotes: the table and column names may hold anything.
    let mut words = Vec::new();
    let mut word = String::new();
    let mut quote = None;
    for c in lower.chars() {
        match quote {
            Some(q) => {
                if c == q {
                    quote = None;
                }
            }
            None if c == '\'' || c == '"' => {
                quote = Some(c);
                words.push(std::mem::take(&mut word));
            }
            None if c.is_alphanumeric() || c == '_' => word.push(c),
            None => words.push(std::mem::take(&mut word)),
        }
    }
    words.push(word);
    let words: Vec<&str> = words
        .iter()
        .map(String::as_str)
        .filter(|w| !w.is_empty())
        .collect();
    words.windows(2).any(|w| w == ["from", "stdin"])
}

/// The statement around byte offset `at`: the one it falls in, or the one
/// that ends just before it (a caret after `...;` or on the blank line
/// after a statement still means that statement).
pub fn statement_at(sql: &str, at: usize) -> Option<Statement> {
    let all = split(sql);
    all.iter()
        .find(|s| at >= s.start && at <= s.end)
        .or_else(|| all.iter().rev().find(|s| s.end <= at))
        .or_else(|| all.first())
        .cloned()
}

fn is_ident_start(b: u8) -> bool {
    b.is_ascii_alphabetic() || b == b'_' || b >= 0x80
}

fn is_ident_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'$' || b >= 0x80
}

#[cfg(test)]
mod tests {
    use super::*;

    fn texts(sql: &str) -> Vec<String> {
        split(sql).into_iter().map(|s| s.text).collect()
    }

    #[test]
    fn splits_on_semicolons() {
        assert_eq!(texts("select 1; select 2;"), ["select 1", "select 2"]);
        assert_eq!(texts("select 1;\n\nselect 2"), ["select 1", "select 2"]);
    }

    #[test]
    fn skips_empty_and_comment_only_statements() {
        assert_eq!(
            texts(";; -- nothing\n; /* nor this */ ;"),
            Vec::<String>::new()
        );
        assert_eq!(texts("-- head\nselect 1; -- tail"), ["-- head\nselect 1"]);
    }

    #[test]
    fn semicolons_in_strings_identifiers_and_comments_do_not_split() {
        assert_eq!(
            texts(
                r#"select 'a;b', "c;d" from t -- e;f
            where x = 1; select 2"#
            ),
            [
                "select 'a;b', \"c;d\" from t -- e;f\n            where x = 1",
                "select 2"
            ]
        );
        assert_eq!(
            texts("select 'it''s; fine'; select 3"),
            ["select 'it''s; fine'", "select 3"]
        );
        assert_eq!(
            texts("select /* a /* nested; */ b; */ 1; select 2"),
            ["select /* a /* nested; */ b; */ 1", "select 2"]
        );
    }

    #[test]
    fn escape_strings_take_backslashes() {
        assert_eq!(
            texts(r"select E'a\';b'; select 2"),
            [r"select E'a\';b'", "select 2"]
        );
        // a plain string ends at the quote after the backslash
        assert_eq!(
            texts(r"select 'a\'; select 2"),
            [r"select 'a\'", "select 2"]
        );
    }

    #[test]
    fn dollar_quoted_bodies_hold_semicolons() {
        let sql = "create function f() returns int language plpgsql as $$\nbegin\n  return 1;\nend;\n$$;\nselect f();";
        assert_eq!(split(sql).len(), 2);
        let tagged = "do $body$ begin perform 1; end $body$; select 2";
        assert_eq!(
            texts(tagged),
            ["do $body$ begin perform 1; end $body$", "select 2"]
        );
        // a parameter is not a dollar quote
        assert_eq!(texts("select $1; select $2"), ["select $1", "select $2"]);
    }

    #[test]
    fn begin_atomic_bodies_hold_semicolons() {
        let sql = "create function g() returns int language sql begin atomic select 1; select case when true then 2 end; end; select 3";
        assert_eq!(
            texts(sql),
            [
                "create function g() returns int language sql begin atomic select 1; select case when true then 2 end; end",
                "select 3"
            ]
        );
    }

    #[test]
    fn offsets_point_into_the_original_text() {
        let sql = "  select 1;\n\n  select 'two' ;";
        let all = split(sql);
        for s in &all {
            assert_eq!(&sql[s.start..s.end], s.text);
        }
        assert_eq!(all[1].start, sql.find("select 'two'").unwrap());
    }

    #[test]
    fn finds_the_statement_at_the_caret() {
        let sql = "select 1;\nselect 2;\n\n";
        assert_eq!(statement_at(sql, 3).unwrap().text, "select 1");
        assert_eq!(statement_at(sql, 13).unwrap().text, "select 2");
        // after the last semicolon, on the blank lines
        assert_eq!(statement_at(sql, sql.len()).unwrap().text, "select 2");
        assert!(statement_at("", 0).is_none());
    }

    #[test]
    fn handles_non_ascii_text() {
        assert_eq!(
            texts("select 'ção;'; select 'ü'"),
            ["select 'ção;'", "select 'ü'"]
        );
    }

    /// Feeds `input` in pieces of `size` bytes.
    fn events(input: &[u8], size: usize, options: SplitterOptions) -> Vec<Event> {
        let mut splitter = Splitter::new(options);
        let mut out = Vec::new();
        for piece in input.chunks(size) {
            splitter.feed(piece, &mut out);
        }
        splitter.finish(&mut out);
        // pieces of COPY data are an artifact of the chunking
        let mut merged: Vec<Event> = Vec::new();
        for e in out {
            match (merged.last_mut(), e) {
                (Some(Event::CopyData(a)), Event::CopyData(b)) => a.extend(b),
                (_, e) => merged.push(e),
            }
        }
        merged
    }

    #[test]
    fn pieces_of_any_size_give_the_same_statements() {
        let sql = "-- head; here\ncreate function f() returns int language plpgsql as $fn$\nbegin\n  return 1; -- a;\nend;\n$fn$;\n\
                   select E'a\\';b', 'it''s; ok', \"q;\"\"x\" /* a /* nested; */ b; */;\n\
                   do $$ begin perform 'x$$y'; end $$; select $1, 1$$; select 'ção;'; create function g() returns int language sql begin atomic select 1; select case when true then 2 end; end; select 3";
        let whole = events(sql.as_bytes(), sql.len(), SplitterOptions::default());
        assert_eq!(whole.len(), split(sql).len());
        for size in 1..=24 {
            assert_eq!(
                events(sql.as_bytes(), size, SplitterOptions::default()),
                whole,
                "pieces of {size} bytes"
            );
        }
    }

    #[test]
    fn a_dollar_tag_or_comment_may_straddle_two_pieces() {
        let sql = "select $tag$ a; b $tag$; select 2 -- c; d\n; select 3";
        let want = ["select $tag$ a; b $tag$", "select 2 -- c; d", "select 3"];
        // cut inside the opening tag, inside the closing tag and inside `--`
        for cut in [
            sql.find("tag$ a").unwrap() + 2,
            sql.find("$tag$;").unwrap() + 3,
            sql.find("--").unwrap() + 1,
            sql.find("c;").unwrap() + 1,
        ] {
            let mut splitter = Splitter::new(SplitterOptions::default());
            let mut out = Vec::new();
            splitter.feed(&sql.as_bytes()[..cut], &mut out);
            splitter.feed(&sql.as_bytes()[cut..], &mut out);
            splitter.finish(&mut out);
            let texts: Vec<String> = out
                .into_iter()
                .filter_map(|e| match e {
                    Event::Statement(s) => Some(s.text),
                    _ => None,
                })
                .collect();
            assert_eq!(texts, want, "cut at {cut}");
        }
    }

    #[test]
    fn statements_know_their_first_line() {
        let sql = "-- c\n\nselect 1;\n  /* x\n y */ select 2;\nselect 3";
        let lines: Vec<u64> = split(sql).iter().map(|s| s.line).collect();
        assert_eq!(lines, [3, 5, 6]);
    }

    fn dump_options() -> SplitterOptions {
        SplitterOptions {
            meta_commands: true,
            copy_data: true,
        }
    }

    #[test]
    fn meta_commands_are_set_apart_from_statements() {
        let sql = "\\restrict abc\n-- c\nselect 1;\n\\connect shop\nselect 2;\n";
        let found = events(sql.as_bytes(), 3, dump_options());
        assert_eq!(
            found,
            [
                Event::Meta {
                    line: 1,
                    text: "\\restrict abc".into()
                },
                Event::Statement(Statement {
                    text: "-- c\nselect 1".into(),
                    start: 14,
                    end: 27,
                    line: 3
                }),
                Event::Meta {
                    line: 4,
                    text: "\\connect shop".into()
                },
                Event::Statement(Statement {
                    text: "select 2".into(),
                    start: 43,
                    end: 51,
                    line: 5
                }),
            ]
        );
        // without the option a backslash is just a token
        assert_eq!(split("\\x\nselect 1").len(), 1);
    }

    #[test]
    fn copy_data_is_not_read_as_sql() {
        let sql = "copy t (a, b) from stdin;\n1\t'it\n$$\t--\n\\N\t\\\\.\n\\.\nselect 2;\n";
        for size in [1, 2, 3, 7, 64] {
            let found = events(sql.as_bytes(), size, dump_options());
            assert_eq!(found.len(), 4, "{found:?}");
            assert!(
                matches!(&found[0], Event::CopyStart(s) if s.text == "copy t (a, b) from stdin")
            );
            assert_eq!(
                found[1],
                Event::CopyData(b"1\t'it\n$$\t--\n\\N\t\\\\.\n".to_vec())
            );
            assert_eq!(found[2], Event::CopyEnd { terminated: true });
            assert!(
                matches!(&found[3], Event::Statement(s) if s.text == "select 2" && s.line == 6)
            );
        }
    }

    #[test]
    fn copy_data_with_windows_line_ends_and_no_terminator() {
        let sql = "COPY t FROM STDIN WITH (FORMAT text);\r\n1\r\n\\.\r\nselect 1";
        let found = events(sql.as_bytes(), 5, dump_options());
        assert_eq!(found[1], Event::CopyData(b"1\r\n".to_vec()));
        assert_eq!(found[2], Event::CopyEnd { terminated: true });
        let cut = "copy t from stdin;\n1\n2\n";
        let found = events(cut.as_bytes(), 4, dump_options());
        assert_eq!(found[1], Event::CopyData(b"1\n2\n".to_vec()));
        assert_eq!(found[2], Event::CopyEnd { terminated: false });
        // the terminator may be the last bytes of the input
        let end = "copy t from stdin;\n1\n\\.";
        let found = events(end.as_bytes(), 4, dump_options());
        assert_eq!(found[2], Event::CopyEnd { terminated: true });
    }

    #[test]
    fn only_copy_from_stdin_switches_to_data() {
        assert!(copies_from_stdin("COPY public.t (a) FROM stdin"));
        assert!(copies_from_stdin(
            "-- x\ncopy \"from stdin\" from\n stdin with (format csv)"
        ));
        assert!(!copies_from_stdin("copy t from '/tmp/x.csv'"));
        assert!(!copies_from_stdin("copy \"a from stdin\" to stdout"));
        assert!(!copies_from_stdin("copying from stdin"));
        assert!(!copies_from_stdin("select 'from stdin'"));
    }
}
