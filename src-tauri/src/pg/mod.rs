//! The PostgreSQL layer: connections, catalog reads, statements and edits.
//!
//! Everything the app reads comes back as text, the way `psql` shows it:
//! the simple query protocol returns values in their text form, which keeps
//! `numeric` exact, `timestamptz` with its offset and every type the driver
//! has no Rust mapping for (enums, ranges, PostGIS) readable. Column types
//! come from the catalog or from preparing the statement.

pub mod catalog;
pub mod connect;
pub mod edit;
pub mod graph;
pub mod objects;
pub mod run;
pub mod split;
mod tls;

pub use connect::{PgClient, PgSession};

use serde::Serialize;

use crate::error::AppError;

/// `"name"` with inner quotes doubled: safe to splice into SQL as an
/// identifier, whatever the name holds.
pub fn ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// `"schema"."name"`.
pub fn qualified(schema: &str, name: &str) -> String {
    format!("{}.{}", ident(schema), ident(name))
}

/// A string literal that means `value` whatever `standard_conforming_strings`
/// is: dollar-quoted, with a tag the value doesn't contain.
pub fn literal(value: &str) -> String {
    let mut tag = String::from("$q$");
    let mut n = 0;
    while value.contains(&tag) || value.ends_with(&tag[..tag.len() - 1]) {
        n += 1;
        tag = format!("$q{n}$");
    }
    format!("{tag}{value}{tag}")
}

/// A server-side error, with what the editor needs to point at it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbError {
    pub message: String,
    /// SQLSTATE, e.g. `42P01`.
    pub code: Option<String>,
    pub detail: Option<String>,
    pub hint: Option<String>,
    /// 1-based character position in the statement, when the server gave one.
    pub position: Option<u32>,
    pub severity: Option<String>,
}

impl std::fmt::Display for DbError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)?;
        if let Some(detail) = &self.detail {
            write!(f, "\n{detail}")?;
        }
        if let Some(hint) = &self.hint {
            write!(f, "\nHint: {hint}")?;
        }
        Ok(())
    }
}

impl DbError {
    pub fn from_pg(err: &tokio_postgres::Error) -> Self {
        match err.as_db_error() {
            Some(db) => DbError {
                message: db.message().to_string(),
                code: Some(db.code().code().to_string()),
                detail: db.detail().map(str::to_string),
                hint: db.hint().map(str::to_string),
                position: match db.position() {
                    Some(tokio_postgres::error::ErrorPosition::Original(p)) => Some(*p),
                    _ => None,
                },
                severity: Some(db.severity().to_string()),
            },
            None => DbError {
                message: describe_client_error(err),
                code: None,
                detail: None,
                hint: None,
                position: None,
                severity: None,
            },
        }
    }

    pub fn is_cancel(&self) -> bool {
        self.code.as_deref() == Some("57014")
    }
}

/// The driver's own errors read like "error communicating with the server:
/// Connection refused (os error 111)"; the source carries the useful part.
fn describe_client_error(err: &tokio_postgres::Error) -> String {
    let mut text = err.to_string();
    // The server asked for a password the connection doesn't have.
    if text == "invalid configuration: password missing" {
        return "The server asks for a password, and this connection has none. \
                Fill in the password, or add it to the connection string."
            .to_string();
    }
    let mut source = std::error::Error::source(err);
    while let Some(s) = source {
        let next = s.to_string();
        if !text.contains(&next) {
            text = format!("{text}: {next}");
        }
        source = s.source();
    }
    text
}

impl From<tokio_postgres::Error> for AppError {
    fn from(err: tokio_postgres::Error) -> Self {
        let db = DbError::from_pg(&err);
        if db.is_cancel() {
            AppError::Cancelled
        } else {
            AppError::Database(Box::new(db))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identifiers_are_quoted_and_escaped() {
        assert_eq!(ident("orders"), "\"orders\"");
        assert_eq!(ident("we\"ird"), "\"we\"\"ird\"");
        assert_eq!(
            qualified("public", "Order Items"),
            "\"public\".\"Order Items\""
        );
    }

    #[test]
    fn literals_pick_a_tag_the_value_does_not_contain() {
        assert_eq!(literal("it's"), "$q$it's$q$");
        assert_eq!(literal("a $q$ b"), "$q1$a $q$ b$q1$");
        // a value ending in "$q" would otherwise merge with the closing tag
        assert_eq!(literal("x$q"), "$q1$x$q$q1$");
        assert_eq!(literal(""), "$q$$q$");
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    //! A session on the dev server, for the `--ignored` live tests.
    use super::*;
    use crate::models::{
        ConnectionAdvancedOptions, ConnectionProfile, ConnectionSource, SslMode, TlsOptions,
    };
    use crate::secrets::InMemoryStore;
    use std::sync::Arc;

    /// Needs `POSTGRES_STUDIO_TEST_URI`, e.g.
    /// `postgres://postgres:postgres@localhost:5433/shop`.
    pub(crate) async fn live_session() -> PgSession {
        let uri = std::env::var("POSTGRES_STUDIO_TEST_URI").expect("set POSTGRES_STUDIO_TEST_URI");
        let profile = ConnectionProfile {
            id: "live".into(),
            name: "live".into(),
            color: None,
            source: ConnectionSource::Uri { uri },
            database: None,
            username: None,
            has_password: false,
            tls: TlsOptions {
                ssl_mode: SslMode::Disable,
                ..Default::default()
            },
            ssh_tunnel: None,
            advanced: ConnectionAdvancedOptions::default(),
            created_at: String::new(),
            updated_at: String::new(),
        };
        let known = Arc::new(crate::ssh_tunnel::KnownHosts::load(&std::env::temp_dir()).unwrap());
        PgSession::connect(&profile, &InMemoryStore::new(), &known)
            .await
            .unwrap()
    }
}

#[cfg(test)]
mod live_tests {
    //! Against the dev server (docker-compose.dev.yml). Run with:
    //!   POSTGRES_STUDIO_TEST_URI=postgres://postgres:postgres@localhost:5433/shop \
    //!     cargo test --lib -- --ignored pg::live_tests
    use super::*;
    async fn session() -> PgSession {
        test_support::live_session().await
    }

    fn opts() -> run::RunOptions {
        run::RunOptions {
            row_limit: 100,
            pooler_mode: false,
            wrap_read_only: false,
        }
    }

    #[tokio::test]
    #[ignore]
    async fn live_catalog() {
        let s = session().await;
        assert!(s.server_version.is_some());
        let c = s.client("shop").await.unwrap();
        let dbs = catalog::list_databases(&c).await.unwrap();
        assert!(dbs.iter().any(|d| d.name == "analytics"));
        let schemas = catalog::list_schemas(&c).await.unwrap();
        assert!(schemas.iter().any(|s| s.name == "audit" && !s.system));
        let objects = catalog::list_schema_objects(&c, "public").await.unwrap();
        assert!(objects.tables.iter().any(|t| t.name == "orders"));
        assert!(objects.views.iter().any(|t| t.name == "order_totals"));
        assert!(objects
            .materialized_views
            .iter()
            .any(|t| t.name == "daily_revenue"));
        assert!(objects
            .types
            .iter()
            .any(|t| t.name == "order_status" && t.kind == "e"));
        assert!(objects.functions.iter().any(|f| f.name == "order_total"));
        let diagram = catalog::schema_diagram(&c, "public").await.unwrap();
        let items = diagram
            .tables
            .iter()
            .find(|t| t.name == "order_items")
            .unwrap();
        assert!(items.columns.iter().any(|c| c.name == "id" && c.pk));
        assert!(items.columns.iter().any(|c| c.name == "order_id" && c.fk));
        assert!(diagram.foreign_keys.iter().any(|f| f.table == "order_items"
            && f.ref_table == "orders"
            && f.columns == ["order_id"]
            && f.ref_columns == ["id"]));
        let orders = catalog::describe_table(&c, "public", "orders")
            .await
            .unwrap();
        assert_eq!(orders.row_key, ["id"]);
        let status = orders.columns.iter().find(|c| c.name == "status").unwrap();
        assert_eq!(status.enum_values.as_ref().unwrap()[0], "pending");
        assert!(orders
            .constraints
            .iter()
            .any(|c| c.kind == "f" && c.ref_table.as_deref() == Some("customers")));
        assert!(orders
            .referenced_by
            .iter()
            .any(|r| r.table == "order_items"));
        assert!(
            orders.ddl.contains("CREATE TABLE \"public\".\"orders\""),
            "{}",
            orders.ddl
        );
        let logins = catalog::describe_table(&c, "audit", "logins")
            .await
            .unwrap();
        assert!(logins.row_key.is_empty());
        // other database through the same session
        let a = s.client("analytics").await.unwrap();
        assert!(catalog::list_schema_objects(&a, "public")
            .await
            .unwrap()
            .tables
            .iter()
            .any(|t| t.name == "events"));
        let def = catalog::object_definition(&c, "public", "order_status", "type", None)
            .await
            .unwrap();
        assert!(def.contains("ENUM ('pending'"), "{def}");
        s.shutdown().await;
    }

    #[tokio::test]
    #[ignore]
    async fn live_statements_types_and_partial_results() {
        let s = session().await;
        let c = s.pinned("t1", "shop").await.unwrap();
        let run = run::run_sql(
            &c,
            "select id, status, total, metadata from orders order by id limit 2; selec 1; select 3",
            opts(),
            None,
        )
        .await;
        assert_eq!(run.results.len(), 2, "stops at the error");
        let first = &run.results[0];
        assert_eq!(first.rows.len(), 2);
        assert_eq!(first.columns[1].type_name, "order_status");
        assert_eq!(first.columns[2].type_name, "numeric");
        let err = run.results[1].error.as_ref().unwrap();
        assert_eq!(err.code.as_deref(), Some("42601"));
        assert!(err.position.is_some());
        assert_eq!(run.transaction, run::TxState::Idle);

        // statement at caret only
        let sql = "select 1 as a;\nselect 2 as b;";
        let run = run::run_sql(&c, sql, opts(), Some(17)).await;
        assert_eq!(run.results.len(), 1);
        assert_eq!(run.results[0].columns[0].name, "b");

        // transactions and notices
        let run = run::run_sql(
            &c,
            "begin; do $$ begin raise notice 'hello'; end $$; select 1",
            opts(),
            None,
        )
        .await;
        assert_eq!(run.transaction, run::TxState::Active);
        assert!(
            run.notices.iter().any(|n| n.message == "hello"),
            "{:?}",
            run.notices
        );
        let run = run::run_sql(&c, "select 1/0", opts(), None).await;
        assert_eq!(run.transaction, run::TxState::Failed);
        let run = run::run_sql(&c, "rollback", opts(), None).await;
        assert_eq!(run.transaction, run::TxState::Idle);

        // A capped query reads only what is kept, through a cursor: fast on
        // a million rows, and marked as having more.
        let started = std::time::Instant::now();
        let run = run::run_sql(
            &c,
            "select g from generate_series(1, 1000000) g",
            opts(),
            None,
        )
        .await;
        let r = &run.results[0];
        assert!(r.error.is_none(), "{:?}", r.error);
        assert_eq!(r.rows.len(), 100);
        assert!(r.truncated);
        assert_eq!(r.row_count, 100);
        assert!(
            started.elapsed().as_millis() < 500,
            "took {:?}",
            started.elapsed()
        );
        assert_eq!(run.transaction, run::TxState::Idle);
        // Not a plain query: runs without the cursor and keeps its rows.
        let run = run::run_sql(
            &c,
            "create temp table cursor_probe (n int); insert into cursor_probe values (1), (2) returning n",
            opts(),
            None,
        )
        .await;
        assert_eq!(run.results[1].rows.len(), 2, "{:?}", run.results[1].error);
        // Inside the user's transaction: a cursor query leaves it open and
        // usable; one that fails leaves it aborted, as without the cursor.
        let run = run::run_sql(
            &c,
            "begin; select * from cursor_probe; select 1",
            opts(),
            None,
        )
        .await;
        assert!(
            run.results.iter().all(|r| r.error.is_none()),
            "{:?}",
            run.results
        );
        assert_eq!(run.results[1].rows.len(), 2);
        assert_eq!(run.transaction, run::TxState::Active);
        let run = run::run_sql(&c, "select n / 0 from cursor_probe", opts(), None).await;
        assert_eq!(
            run.results[0].error.as_ref().unwrap().code.as_deref(),
            Some("22012")
        );
        assert_eq!(run.transaction, run::TxState::Failed);
        let run = run::run_sql(&c, "rollback", opts(), None).await;
        assert_eq!(run.transaction, run::TxState::Idle);
        // A syntax error still points at its place in the user's text.
        let run = run::run_sql(&c, "select nope from", opts(), None).await;
        let err = run.results[0].error.as_ref().unwrap();
        assert_eq!(err.code.as_deref(), Some("42601"));
        assert_eq!(err.position, Some(17));

        // types the grid shows, as text
        let run = run::run_sql(&c, "select * from type_samples order by id", opts(), None).await;
        let r = &run.results[0];
        assert!(r.error.is_none(), "{:?}", r.error);
        assert_eq!(r.rows[0][3].as_deref(), Some("[1,10)"));
        assert_eq!(r.rows[0][4].as_deref(), Some("{a,\"b c\",\"d\\\"e\"}"));
        assert_eq!(r.rows[0][6].as_deref(), Some("\\xdeadbeef"));
        s.shutdown().await;
    }

    #[tokio::test]
    #[ignore]
    async fn live_browse_edit_explain_cancel() {
        let s = session().await;
        let c = s.client("shop").await.unwrap();
        let page = run::browse(
            &c,
            "public",
            "orders",
            &run::BrowseInput {
                where_clause: Some("status = 'delivered'".into()),
                order_by: Some("id".into()),
                limit: 5,
                offset: 0,
            },
        )
        .await
        .unwrap();
        assert_eq!(page.rows.len(), 5);
        assert!(page.has_more);
        assert_eq!(page.columns[0].name, "id");
        let n = run::count(&c, "public", "orders", Some("status = 'delivered'"))
            .await
            .unwrap();
        assert!(n > 5);

        // edit in a transaction, then put it back
        let e = s.pinned("edit:t", "shop").await.unwrap();
        let id = page.rows[0][0].clone();
        let key = vec![edit::CellValue {
            column: "id".into(),
            value: id.clone(),
            use_default: false,
        }];
        let applied = edit::apply(
            &e,
            "public",
            "orders",
            &[edit::RowEdit::Update {
                key: key.clone(),
                values: vec![edit::CellValue {
                    column: "notes".into(),
                    value: Some("it's a test".into()),
                    use_default: false,
                }],
            }],
        )
        .await
        .unwrap();
        let row = applied.rows[0].as_ref().unwrap();
        assert!(row.contains(&Some("it's a test".to_string())));
        // a stale key rolls everything back
        let stale = edit::apply(
            &e,
            "public",
            "orders",
            &[
                edit::RowEdit::Update {
                    key: key.clone(),
                    values: vec![edit::CellValue {
                        column: "notes".into(),
                        value: None,
                        use_default: false,
                    }],
                },
                edit::RowEdit::Delete {
                    key: vec![edit::CellValue {
                        column: "id".into(),
                        value: Some("-1".into()),
                        use_default: false,
                    }],
                },
            ],
        )
        .await;
        assert!(stale.is_err());
        let still = run::run_sql(
            &e,
            &format!(
                "select notes from orders where id = {}",
                id.clone().unwrap()
            ),
            opts(),
            None,
        )
        .await;
        assert_eq!(still.results[0].rows[0][0].as_deref(), Some("it's a test"));
        edit::apply(
            &e,
            "public",
            "orders",
            &[edit::RowEdit::Update {
                key,
                values: vec![edit::CellValue {
                    column: "notes".into(),
                    value: None,
                    use_default: false,
                }],
            }],
        )
        .await
        .unwrap();
        // insert with defaults, then delete
        let inserted = edit::apply(
            &e,
            "public",
            "categories",
            &[edit::RowEdit::Insert {
                values: vec![
                    edit::CellValue {
                        column: "id".into(),
                        value: None,
                        use_default: true,
                    },
                    edit::CellValue {
                        column: "name".into(),
                        value: Some("Temp".into()),
                        use_default: false,
                    },
                ],
            }],
        )
        .await
        .unwrap();
        let new_id = inserted.rows[0].as_ref().unwrap()[0].clone();
        edit::apply(
            &e,
            "public",
            "categories",
            &[edit::RowEdit::Delete {
                key: vec![edit::CellValue {
                    column: "id".into(),
                    value: new_id,
                    use_default: false,
                }],
            }],
        )
        .await
        .unwrap();

        let plan = run::explain(&c, "update orders set notes = 'x' where id = 1", true)
            .await
            .unwrap();
        assert!(plan.plan[0]["Plan"].is_object());
        let still = run::run_sql(
            &e,
            "select count(*) from orders where notes = 'x'",
            opts(),
            None,
        )
        .await;
        assert_eq!(
            still.results[0].rows[0][0].as_deref(),
            Some("0"),
            "explain analyze rolled back"
        );

        // cancel a long statement
        let p = s.pinned("slow", "shop").await.unwrap();
        let canceller = p.canceller();
        let slow =
            tokio::spawn(
                async move { run::run_sql(&p, "select pg_sleep(10)", opts(), None).await },
            );
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        canceller.cancel().await;
        let run = tokio::time::timeout(std::time::Duration::from_secs(3), slow)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            run.results[0].error.as_ref().unwrap().code.as_deref(),
            Some("57014")
        );
        s.shutdown().await;
    }
}
