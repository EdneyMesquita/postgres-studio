//! Reads and actions on the objects around a table: extensions, roles and
//! maintenance. Triggers and indexes come with the table's description, in
//! `catalog`.

use serde::{Deserialize, Serialize};

use super::catalog::json_query;
use super::{ident, PgClient};
use crate::error::{AppError, AppResult};

/// An extension installed in a database.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionInfo {
    pub name: String,
    pub version: String,
    pub schema: String,
    pub comment: Option<String>,
}

pub async fn list_extensions(client: &PgClient) -> AppResult<Vec<ExtensionInfo>> {
    let sql = "SELECT coalesce(json_agg(x ORDER BY x.name), '[]') FROM (
        SELECT e.extname AS name, e.extversion AS version, n.nspname AS schema,
               obj_description(e.oid, 'pg_extension') AS comment
        FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
    ) x";
    Ok(json_query(client, sql).await?.unwrap_or_default())
}

/// An extension the server has files for, installed in this database or not.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableExtension {
    pub name: String,
    pub default_version: Option<String>,
    /// Null when it is not installed here.
    pub installed_version: Option<String>,
    pub schema: Option<String>,
    pub comment: Option<String>,
}

pub async fn list_available_extensions(client: &PgClient) -> AppResult<Vec<AvailableExtension>> {
    let sql = "SELECT coalesce(json_agg(x ORDER BY x.name), '[]') FROM (
        SELECT a.name, a.default_version AS \"defaultVersion\",
               a.installed_version AS \"installedVersion\", n.nspname AS schema, a.comment
        FROM pg_available_extensions a
        LEFT JOIN pg_extension e ON e.extname = a.name
        LEFT JOIN pg_namespace n ON n.oid = e.extnamespace
    ) x";
    Ok(json_query(client, sql).await?.unwrap_or_default())
}

/// What the Extensions dialog can do to one extension.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ExtensionAction {
    /// `CREATE EXTENSION IF NOT EXISTS`, into `schema` when given.
    Install { schema: Option<String> },
    /// `ALTER EXTENSION ... UPDATE`, to the server's default version.
    Update,
    /// `DROP EXTENSION`; with `cascade`, also what depends on it.
    Drop { cascade: bool },
}

/// The statement for an action: names are quoted, so the extension and
/// schema can be whatever the catalog holds.
pub fn extension_sql(name: &str, action: &ExtensionAction) -> String {
    let name = ident(name);
    match action {
        ExtensionAction::Install { schema: None } => {
            format!("CREATE EXTENSION IF NOT EXISTS {name}")
        }
        ExtensionAction::Install { schema: Some(s) } => {
            format!("CREATE EXTENSION IF NOT EXISTS {name} SCHEMA {}", ident(s))
        }
        ExtensionAction::Update => format!("ALTER EXTENSION {name} UPDATE"),
        ExtensionAction::Drop { cascade: false } => format!("DROP EXTENSION {name}"),
        ExtensionAction::Drop { cascade: true } => format!("DROP EXTENSION {name} CASCADE"),
    }
}

pub async fn run_extension_action(
    client: &PgClient,
    name: &str,
    action: &ExtensionAction,
) -> AppResult<()> {
    if name.trim().is_empty() {
        return Err(AppError::InvalidInput("extension name missing".to_string()));
    }
    client
        .client
        .batch_execute(&extension_sql(name, action))
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extension_statements_quote_their_names() {
        assert_eq!(
            extension_sql("pg_trgm", &ExtensionAction::Install { schema: None }),
            "CREATE EXTENSION IF NOT EXISTS \"pg_trgm\""
        );
        assert_eq!(
            extension_sql(
                "uuid-ossp",
                &ExtensionAction::Install {
                    schema: Some("my\"s".to_string())
                }
            ),
            "CREATE EXTENSION IF NOT EXISTS \"uuid-ossp\" SCHEMA \"my\"\"s\""
        );
        assert_eq!(
            extension_sql("citext", &ExtensionAction::Update),
            "ALTER EXTENSION \"citext\" UPDATE"
        );
        assert_eq!(
            extension_sql("citext", &ExtensionAction::Drop { cascade: true }),
            "DROP EXTENSION \"citext\" CASCADE"
        );
        assert_eq!(
            extension_sql("citext", &ExtensionAction::Drop { cascade: false }),
            "DROP EXTENSION \"citext\""
        );
    }
}

#[cfg(test)]
mod live_tests {
    //! Against the dev server. Run with:
    //!   POSTGRES_STUDIO_TEST_URI=postgres://postgres:postgres@localhost:5433/shop \
    //!     cargo test --lib -- --ignored pg::objects
    use crate::pg::catalog;
    use crate::pg::live_tests::session;

    const CLEANUP: &str = "DROP MATERIALIZED VIEW IF EXISTS agent_objects_mv;
        DROP VIEW IF EXISTS agent_objects_v;
        DROP TABLE IF EXISTS agent_objects_t CASCADE;
        DROP FUNCTION IF EXISTS agent_objects_fn();";

    const CLEANUP_B: &str = "DROP MATERIALIZED VIEW IF EXISTS agent_objects_b_mv;
        DROP VIEW IF EXISTS agent_objects_b_v;
        DROP TABLE IF EXISTS agent_objects_b_t CASCADE;";

    #[tokio::test]
    #[ignore]
    async fn live_triggers_and_indexes() {
        let s = session().await;
        let c = s.client("shop").await.unwrap();
        c.client.batch_execute(CLEANUP).await.unwrap();
        c.client
            .batch_execute(
                "CREATE TABLE agent_objects_t (id int PRIMARY KEY, name text, tag text, note text);
                 CREATE UNIQUE INDEX agent_objects_t_name_live ON agent_objects_t (lower(name)) WHERE tag IS NOT NULL;
                 CREATE INDEX agent_objects_t_inc ON agent_objects_t (tag) INCLUDE (note);
                 CREATE FUNCTION agent_objects_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
                 CREATE TRIGGER agent_objects_trg BEFORE INSERT OR UPDATE ON agent_objects_t
                     FOR EACH ROW EXECUTE FUNCTION agent_objects_fn();
                 CREATE TRIGGER agent_objects_stmt AFTER DELETE ON agent_objects_t
                     FOR EACH STATEMENT EXECUTE FUNCTION agent_objects_fn();
                 ALTER TABLE agent_objects_t DISABLE TRIGGER agent_objects_stmt;
                 CREATE VIEW agent_objects_v AS SELECT id FROM agent_objects_t;",
            )
            .await
            .unwrap();
        let info = catalog::describe_table(&c, "public", "agent_objects_t")
            .await
            .unwrap();

        let trg = info
            .triggers
            .iter()
            .find(|t| t.name == "agent_objects_trg")
            .unwrap();
        assert_eq!(trg.timing, "BEFORE");
        assert_eq!(trg.events, ["INSERT", "UPDATE"]);
        assert_eq!(trg.level, "row");
        assert_eq!(trg.enabled_state, "O");
        assert!(trg.enabled);
        assert!(
            trg.function.contains("agent_objects_fn"),
            "{}",
            trg.function
        );
        assert!(trg.definition.contains("BEFORE INSERT OR UPDATE"));
        let stmt = info
            .triggers
            .iter()
            .find(|t| t.name == "agent_objects_stmt")
            .unwrap();
        assert_eq!(stmt.timing, "AFTER");
        assert_eq!(stmt.events, ["DELETE"]);
        assert_eq!(stmt.level, "statement");
        assert_eq!(stmt.enabled_state, "D");
        assert!(!stmt.enabled);

        let pk = info.indexes.iter().find(|i| i.primary).unwrap();
        assert!(pk.unique && pk.valid && !pk.partial && !pk.expression);
        let partial = info
            .indexes
            .iter()
            .find(|i| i.name == "agent_objects_t_name_live")
            .unwrap();
        assert!(partial.unique && partial.partial && partial.expression);
        assert_eq!(partial.predicate.as_deref(), Some("tag IS NOT NULL"));
        let inc = info
            .indexes
            .iter()
            .find(|i| i.name == "agent_objects_t_inc")
            .unwrap();
        assert_eq!(inc.columns, ["tag"]);
        assert_eq!(inc.include, ["note"]);
        assert!(inc.definition.starts_with("CREATE INDEX"));

        // a view's trigger list is empty but the read still works
        let view = catalog::describe_table(&c, "public", "agent_objects_v")
            .await
            .unwrap();
        assert!(view.view_definition.unwrap().contains("agent_objects_t"));

        c.client.batch_execute(CLEANUP).await.unwrap();
        s.shutdown().await;
    }

    #[tokio::test]
    #[ignore]
    async fn live_view_definitions_and_matview_indexes() {
        let s = session().await;
        let c = s.client("shop").await.unwrap();
        c.client.batch_execute(CLEANUP_B).await.unwrap();
        c.client
            .batch_execute(
                "CREATE TABLE agent_objects_b_t (id int PRIMARY KEY, name text);
                 CREATE VIEW agent_objects_b_v AS SELECT id, upper(name) AS shout FROM agent_objects_b_t;
                 CREATE MATERIALIZED VIEW agent_objects_b_mv AS SELECT id, name FROM agent_objects_b_t;
                 CREATE UNIQUE INDEX agent_objects_b_mv_id ON agent_objects_b_mv (id);",
            )
            .await
            .unwrap();
        let view = catalog::describe_table(&c, "public", "agent_objects_b_v")
            .await
            .unwrap();
        assert_eq!(view.kind, "v");
        let def = view.view_definition.unwrap();
        assert!(
            def.contains("upper(name)") && def.contains("agent_objects_b_t"),
            "{def}"
        );
        let mv = catalog::describe_table(&c, "public", "agent_objects_b_mv")
            .await
            .unwrap();
        assert_eq!(mv.kind, "m");
        assert!(mv.view_definition.is_some());
        let idx = &mv.indexes[0];
        assert!(idx.unique && idx.valid && !idx.partial && !idx.expression);
        c.client.batch_execute(CLEANUP_B).await.unwrap();
        s.shutdown().await;
    }

    #[tokio::test]
    #[ignore]
    async fn live_extensions() {
        use crate::pg::objects::{
            list_available_extensions, list_extensions, run_extension_action, ExtensionAction,
        };
        let s = session().await;
        let c = s.client("shop").await.unwrap();
        // CASCADE takes whatever uses an extension with it, so this test
        // refuses to run where pg_trgm is in use already.
        let available = list_available_extensions(&c).await.unwrap();
        let ext = available.iter().find(|e| e.name == "pg_trgm").unwrap();
        assert!(ext.default_version.is_some());
        assert!(
            ext.installed_version.is_none(),
            "pg_trgm is installed here already; the test would drop it"
        );

        c.client
            .batch_execute("CREATE SCHEMA IF NOT EXISTS agent_objects_ext")
            .await
            .unwrap();
        let install = ExtensionAction::Install {
            schema: Some("agent_objects_ext".to_string()),
        };
        run_extension_action(&c, "pg_trgm", &install).await.unwrap();
        // idempotent
        run_extension_action(&c, "pg_trgm", &install).await.unwrap();
        let installed = list_extensions(&c).await.unwrap();
        let e = installed.iter().find(|e| e.name == "pg_trgm").unwrap();
        assert_eq!(e.schema, "agent_objects_ext");
        assert!(e.comment.is_some());
        let available = list_available_extensions(&c).await.unwrap();
        let ext = available.iter().find(|e| e.name == "pg_trgm").unwrap();
        assert_eq!(ext.installed_version.as_deref(), Some(e.version.as_str()));
        assert_eq!(ext.schema.as_deref(), Some("agent_objects_ext"));

        // already at the default version: a no-op, not an error
        run_extension_action(&c, "pg_trgm", &ExtensionAction::Update)
            .await
            .unwrap();
        // an object using the extension blocks a plain drop; CASCADE takes it
        c.client
            .batch_execute(
                "CREATE TABLE agent_objects_ext.t (c text);
                 CREATE INDEX ON agent_objects_ext.t USING gin (c agent_objects_ext.gin_trgm_ops)",
            )
            .await
            .unwrap();
        let err = run_extension_action(&c, "pg_trgm", &ExtensionAction::Drop { cascade: false })
            .await
            .unwrap_err();
        assert!(err.to_string().contains("depend"), "{err}");
        run_extension_action(&c, "pg_trgm", &ExtensionAction::Drop { cascade: true })
            .await
            .unwrap();
        assert!(!list_extensions(&c)
            .await
            .unwrap()
            .iter()
            .any(|e| e.name == "pg_trgm"));
        c.client
            .batch_execute("DROP SCHEMA agent_objects_ext CASCADE")
            .await
            .unwrap();
        s.shutdown().await;
    }
}
