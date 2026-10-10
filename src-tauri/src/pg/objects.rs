//! Reads and actions on the objects around a table: extensions, roles and
//! maintenance. Triggers and indexes come with the table's description, in
//! `catalog`.

use serde::{Deserialize, Serialize};

use super::catalog::json_query;
use super::{ident, PgClient, PgSession};
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

/// A role of the server, as `pg_roles` describes it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoleInfo {
    pub name: String,
    pub can_login: bool,
    pub superuser: bool,
    pub create_db: bool,
    pub create_role: bool,
    pub replication: bool,
    pub bypass_rls: bool,
    pub inherit: bool,
    /// -1 for no limit.
    pub connection_limit: i32,
    /// As the server writes it, `infinity` included; null when it never expires.
    pub valid_until: Option<String>,
    /// The roles this one is a member of.
    pub member_of: Vec<String>,
    pub comment: Option<String>,
    /// A predefined `pg_*` role.
    pub system: bool,
}

pub async fn list_roles(client: &PgClient) -> AppResult<Vec<RoleInfo>> {
    let sql = "SELECT coalesce(json_agg(x ORDER BY x.system, x.name), '[]') FROM (
        SELECT r.rolname AS name, r.rolcanlogin AS \"canLogin\", r.rolsuper AS superuser,
               r.rolcreatedb AS \"createDb\", r.rolcreaterole AS \"createRole\",
               r.rolreplication AS replication, r.rolbypassrls AS \"bypassRls\",
               r.rolinherit AS inherit, r.rolconnlimit AS \"connectionLimit\",
               r.rolvaliduntil::text AS \"validUntil\",
               coalesce((SELECT json_agg(g.rolname ORDER BY g.rolname)
                         FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid
                         WHERE m.member = r.oid), '[]') AS \"memberOf\",
               shobj_description(r.oid, 'pg_authid') AS comment,
               r.rolname LIKE 'pg\\_%' AS system
        FROM pg_roles r
    ) x";
    Ok(json_query(client, sql).await?.unwrap_or_default())
}

/// A maintenance statement the table menu runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MaintenanceAction {
    VacuumAnalyze,
    Analyze,
    Reindex,
    /// Empties the table; fails if another table's foreign key points at it.
    Truncate,
}

/// The statement for an action, with the table's name quoted.
pub fn maintenance_sql(schema: &str, table: &str, action: MaintenanceAction) -> String {
    let name = super::qualified(schema, table);
    match action {
        MaintenanceAction::VacuumAnalyze => format!("VACUUM (ANALYZE) {name}"),
        MaintenanceAction::Analyze => format!("ANALYZE {name}"),
        MaintenanceAction::Reindex => format!("REINDEX TABLE {name}"),
        MaintenanceAction::Truncate => format!("TRUNCATE TABLE {name}"),
    }
}

/// Runs the statement on a connection of its own: a VACUUM of a large table
/// takes a while, and must not hold up the lists the shared one serves.
pub async fn run_maintenance(
    session: &PgSession,
    database: &str,
    schema: &str,
    table: &str,
    action: MaintenanceAction,
) -> AppResult<()> {
    let key = format!("maintenance:{}", uuid::Uuid::new_v4());
    let client = session.pinned(&key, database).await?;
    let result = client
        .client
        .batch_execute(&maintenance_sql(schema, table, action))
        .await;
    session.release(&key).await;
    Ok(result?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maintenance_statements_quote_the_table() {
        let sql = |a| maintenance_sql("My Schema", "order", a);
        assert_eq!(
            sql(MaintenanceAction::VacuumAnalyze),
            "VACUUM (ANALYZE) \"My Schema\".\"order\""
        );
        assert_eq!(
            sql(MaintenanceAction::Analyze),
            "ANALYZE \"My Schema\".\"order\""
        );
        assert_eq!(
            sql(MaintenanceAction::Reindex),
            "REINDEX TABLE \"My Schema\".\"order\""
        );
        assert_eq!(
            sql(MaintenanceAction::Truncate),
            "TRUNCATE TABLE \"My Schema\".\"order\""
        );
    }

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

    #[tokio::test]
    #[ignore]
    async fn live_roles() {
        use crate::pg::objects::list_roles;
        let s = session().await;
        let c = s.client("shop").await.unwrap();
        let drop =
            "DROP ROLE IF EXISTS agent_objects_member; DROP ROLE IF EXISTS agent_objects_group;";
        c.client.batch_execute(drop).await.unwrap();
        c.client
            .batch_execute(
                "CREATE ROLE agent_objects_group NOLOGIN CREATEDB;
                 CREATE ROLE agent_objects_member LOGIN CONNECTION LIMIT 5 VALID UNTIL '2099-01-01 00:00:00+00' IN ROLE agent_objects_group;
                 COMMENT ON ROLE agent_objects_member IS 'it''s a test';",
            )
            .await
            .unwrap();
        let roles = list_roles(&c).await.unwrap();
        let member = roles
            .iter()
            .find(|r| r.name == "agent_objects_member")
            .unwrap();
        assert!(member.can_login && !member.superuser && !member.system);
        assert_eq!(member.connection_limit, 5);
        assert_eq!(member.member_of, ["agent_objects_group"]);
        assert!(member
            .valid_until
            .as_deref()
            .unwrap()
            .starts_with("2099-01-01"));
        assert_eq!(member.comment.as_deref(), Some("it's a test"));
        let group = roles
            .iter()
            .find(|r| r.name == "agent_objects_group")
            .unwrap();
        assert!(!group.can_login && group.create_db && group.member_of.is_empty());
        assert_eq!(group.connection_limit, -1);
        assert!(group.valid_until.is_none());
        let postgres = roles.iter().find(|r| r.name == "postgres").unwrap();
        assert!(postgres.superuser);
        assert!(roles.iter().any(|r| r.system && r.name.starts_with("pg_")));
        // the predefined roles come last
        let first_system = roles.iter().position(|r| r.system).unwrap();
        assert!(roles[first_system..].iter().all(|r| r.system));
        c.client.batch_execute(drop).await.unwrap();
        s.shutdown().await;
    }

    #[tokio::test]
    #[ignore]
    async fn live_maintenance() {
        use crate::pg::objects::{run_maintenance, MaintenanceAction};
        let s = session().await;
        let c = s.client("shop").await.unwrap();
        c.client
            .batch_execute(
                "DROP TABLE IF EXISTS agent_objects_m;
                 CREATE TABLE agent_objects_m (id int PRIMARY KEY, v text);
                 INSERT INTO agent_objects_m SELECT g, 'x' FROM generate_series(1, 200) g;
                 DELETE FROM agent_objects_m WHERE id > 100;",
            )
            .await
            .unwrap();
        for action in [
            MaintenanceAction::VacuumAnalyze,
            MaintenanceAction::Analyze,
            MaintenanceAction::Reindex,
        ] {
            run_maintenance(&s, "shop", "public", "agent_objects_m", action)
                .await
                .unwrap_or_else(|e| panic!("{action:?}: {e}"));
        }
        // ANALYZE and VACUUM leave their mark in the statistics
        let stats: Option<bool> = crate::pg::catalog::json_query(
            &c,
            "SELECT to_json(last_analyze IS NOT NULL OR last_vacuum IS NOT NULL)
             FROM pg_stat_user_tables WHERE relname = 'agent_objects_m'",
        )
        .await
        .unwrap();
        assert_eq!(stats, Some(true));
        run_maintenance(
            &s,
            "shop",
            "public",
            "agent_objects_m",
            MaintenanceAction::Truncate,
        )
        .await
        .unwrap();
        let rows: Option<i64> =
            crate::pg::catalog::json_query(&c, "SELECT to_json(count(*)) FROM agent_objects_m")
                .await
                .unwrap();
        assert_eq!(rows, Some(0));
        // a missing table is an error, not a silent success
        assert!(run_maintenance(
            &s,
            "shop",
            "public",
            "agent_objects_missing",
            MaintenanceAction::Analyze
        )
        .await
        .is_err());
        c.client
            .batch_execute("DROP TABLE agent_objects_m")
            .await
            .unwrap();
        s.shutdown().await;
    }
}
