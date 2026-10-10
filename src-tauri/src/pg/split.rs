//! Splits SQL text into statements, the way the server would read it.
//!
//! The console runs the statement at the caret, the Assistant may run
//! exactly one statement, and each statement is prepared on its own to learn
//! its result columns - all of that needs the boundaries first. Semicolons
//! inside quotes, quoted identifiers, dollar-quoted bodies and comments
//! don't end a statement. Offsets are byte offsets into the original text,
//! so an error position from the server maps back to the editor.

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
}

/// The statements in `sql`, skipping empty ones and ones that hold only
/// comments.
pub fn split(sql: &str) -> Vec<Statement> {
    let bytes = sql.as_bytes();
    let mut out = Vec::new();
    let mut start = 0;
    let mut i = 0;
    // A statement counts once it has a token outside comments.
    let mut has_code = false;
    // `BEGIN ATOMIC ... END` bodies (SQL-standard function bodies) hold
    // semicolons; track the nesting so they don't end the statement.
    let mut atomic_depth = 0usize;
    let mut words: [String; 2] = [String::new(), String::new()];

    while i < bytes.len() {
        let c = bytes[i];
        match c {
            b'-' if bytes.get(i + 1) == Some(&b'-') => {
                while i < bytes.len() && bytes[i] != b'\n' {
                    i += 1;
                }
                continue;
            }
            b'/' if bytes.get(i + 1) == Some(&b'*') => {
                // Block comments nest in PostgreSQL.
                let mut depth = 0;
                while i < bytes.len() {
                    if bytes[i] == b'/' && bytes.get(i + 1) == Some(&b'*') {
                        depth += 1;
                        i += 2;
                    } else if bytes[i] == b'*' && bytes.get(i + 1) == Some(&b'/') {
                        depth -= 1;
                        i += 2;
                        if depth == 0 {
                            break;
                        }
                    } else {
                        i += 1;
                    }
                }
                continue;
            }
            b'\'' => {
                has_code = true;
                // E'...' strings take backslash escapes; others only ''.
                let escapes = i > 0
                    && matches!(bytes[i - 1], b'e' | b'E')
                    && !ident_byte_before(bytes, i - 1);
                i = skip_quoted(bytes, i, b'\'', escapes);
                continue;
            }
            b'"' => {
                has_code = true;
                i = skip_quoted(bytes, i, b'"', false);
                continue;
            }
            b'$' => {
                if let Some(tag_end) = dollar_tag(bytes, i) {
                    has_code = true;
                    let tag = &bytes[i..=tag_end];
                    let body = tag_end + 1;
                    i = find(bytes, body, tag).map_or(bytes.len(), |at| at + tag.len());
                    continue;
                }
                i += 1;
                continue;
            }
            b';' if atomic_depth == 0 => {
                if has_code {
                    out.push(statement(sql, start, i));
                }
                start = i + 1;
                has_code = false;
                words = [String::new(), String::new()];
                i += 1;
                continue;
            }
            _ if is_ident_start(c) && !ident_byte_before(bytes, i) => {
                has_code = true;
                let word_start = i;
                while i < bytes.len() && is_ident_byte(bytes[i]) {
                    i += 1;
                }
                let word = sql[word_start..i].to_ascii_lowercase();
                if word == "atomic" && words[1] == "begin" {
                    atomic_depth += 1;
                } else if atomic_depth > 0 && (word == "case" || word == "begin") {
                    // `CASE ... END` and nested blocks also close with END.
                    atomic_depth += 1;
                } else if atomic_depth > 0 && word == "end" {
                    atomic_depth -= 1;
                }
                words = [std::mem::take(&mut words[1]), word];
                continue;
            }
            _ => {
                if !c.is_ascii_whitespace() {
                    has_code = true;
                }
            }
        }
        i += 1;
    }
    if has_code {
        out.push(statement(sql, start, sql.len()));
    }
    out
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

fn statement(sql: &str, start: usize, end: usize) -> Statement {
    let raw = &sql[start..end];
    let lead = raw.len() - raw.trim_start().len();
    let text = raw.trim();
    // Leading comments stay with the statement (the server ignores them),
    // but its offsets begin at the first non-blank character.
    Statement {
        text: text.to_string(),
        start: start + lead,
        end: start + lead + text.len(),
    }
}

fn skip_quoted(bytes: &[u8], open: usize, quote: u8, backslash_escapes: bool) -> usize {
    let mut i = open + 1;
    while i < bytes.len() {
        let c = bytes[i];
        if backslash_escapes && c == b'\\' {
            i += 2;
            continue;
        }
        if c == quote {
            // A doubled quote is an escaped one.
            if bytes.get(i + 1) == Some(&quote) {
                i += 2;
                continue;
            }
            return i + 1;
        }
        i += 1;
    }
    bytes.len()
}

/// The index of the closing `$` when a dollar-quote tag (`$$` or `$tag$`)
/// opens at `at`. `$1` (a parameter) is not one.
fn dollar_tag(bytes: &[u8], at: usize) -> Option<usize> {
    if ident_byte_before(bytes, at) {
        return None;
    }
    let mut i = at + 1;
    if bytes.get(i) == Some(&b'$') {
        return Some(i);
    }
    if !bytes.get(i).is_some_and(|&b| is_ident_start(b)) {
        return None;
    }
    while i < bytes.len() && is_ident_byte(bytes[i]) && bytes[i] != b'$' {
        i += 1;
    }
    (bytes.get(i) == Some(&b'$')).then_some(i)
}

fn find(haystack: &[u8], from: usize, needle: &[u8]) -> Option<usize> {
    haystack
        .get(from..)?
        .windows(needle.len())
        .position(|w| w == needle)
        .map(|p| p + from)
}

fn is_ident_start(b: u8) -> bool {
    b.is_ascii_alphabetic() || b == b'_' || b >= 0x80
}

fn is_ident_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'$' || b >= 0x80
}

fn ident_byte_before(bytes: &[u8], at: usize) -> bool {
    at > 0 && is_ident_byte(bytes[at - 1])
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
}
