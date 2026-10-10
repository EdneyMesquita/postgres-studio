//! The system prompt both agents get, appended to their own (Claude's
//! `--append-system-prompt`, Codex's `developer_instructions`). It tells the
//! agent where it is, that the tools are its only (read-only) access, and
//! the answer format the app's UI turns into runnable proposals.

use super::{AgentSession, Purpose};

pub(crate) fn system_prompt(session: &AgentSession) -> String {
    build(
        session.purpose,
        &session.database,
        &session.connection_name,
        session.server_version.as_deref(),
        session.table.as_deref(),
    )
}

pub(crate) fn build(
    purpose: Purpose,
    database: &str,
    connection_name: &str,
    server_version: Option<&str>,
    table: Option<&str>,
) -> String {
    let version = match server_version {
        Some(v) if !v.is_empty() => format!("PostgreSQL {v}"),
        _ => "PostgreSQL, unknown version".to_string(),
    };
    let looking_at = match table {
        Some(t) => format!(" The user is looking at the table \"{t}\"."),
        None => String::new(),
    };
    let where_target = table.unwrap_or("public.orders");
    let mut prompt = format!(
        "You are the Assistant inside Postgres Studio, a desktop PostgreSQL client. You write SQL for the user.
This session reads the database \"{database}\" on the connection \"{connection_name}\" ({version}).{looking_at}
Tools: the postgres_studio tools are your only access to the data, and they are read-only. Learn the schema with list_tables and describe_table before writing SQL; never guess table, column or type names. Check plans with explain when performance matters. Dry-run queries with dry_run before proposing them. Reading row values may ask the user first; ask only when names and types are not enough.
You cannot change data. When a request needs a write, propose the SQL; it runs only when the user presses Run.
Answer format: short prose (two to four sentences, no headings, no tables), then each proposal in its own fenced block:
```where {where_target}   -> a condition for the table's WHERE field (no WHERE keyword), for that table
```sql                    -> statements for the SQL console of the \"{database}\" database
Write PostgreSQL SQL: quote identifiers that need it, use explicit casts for literals of special types, and prefer one statement per proposal unless the task needs several."
    );
    if purpose == Purpose::Inline {
        prompt.push_str(
            "\nReply with exactly one fenced block (the condition or the complete SQL asked for) and at most one short sentence before it.",
        );
    }
    prompt
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fills_in_the_session() {
        let prompt = build(
            Purpose::Chat,
            "shop",
            "Local",
            Some("17.11"),
            Some("public.orders"),
        );
        assert!(prompt.contains(
            "This session reads the database \"shop\" on the connection \"Local\" (PostgreSQL 17.11). The user is looking at the table \"public.orders\".\nTools:"
        ));
        assert!(prompt.contains("```where public.orders"));
        assert!(prompt.contains("statements for the SQL console of the \"shop\" database"));
        assert!(!prompt.contains("exactly one fenced block"));
    }

    #[test]
    fn inline_asks_for_one_block_and_version_may_be_unknown() {
        let prompt = build(Purpose::Inline, "shop", "Local", None, None);
        assert!(prompt.contains("(PostgreSQL, unknown version).\nTools:"));
        assert!(prompt.ends_with("at most one short sentence before it."));
    }
}
