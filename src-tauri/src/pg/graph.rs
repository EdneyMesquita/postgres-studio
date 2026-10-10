//! Graph and vector features a database may carry: Apache AGE graphs, the
//! pgvector extension and, once a server ships it, SQL/PGQ property graphs.
//!
//! Nothing here is assumed. The catalogs of an extension don't exist
//! without it, and a statement naming a missing relation fails at parse
//! time, so the extension is probed first and its catalogs only read after.

use serde::{Deserialize, Serialize};

use super::catalog::json_query;
use super::PgClient;
use crate::error::AppResult;

/// What a database holds beyond plain SQL.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphCatalog {
    /// The `age` extension is installed in this database.
    pub age: bool,
    /// The `vector` extension (pgvector) is installed.
    pub vector: bool,
    pub graphs: Vec<GraphInfo>,
    /// SQL/PGQ property graphs: empty on every server that lacks them.
    pub property_graphs: Vec<PropertyGraphInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphInfo {
    pub name: String,
    /// The schema AGE keeps the graph's label tables in.
    pub namespace: String,
    pub labels: Vec<GraphLabel>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphLabel {
    pub name: String,
    /// `v` vertex label, `e` edge label.
    pub kind: String,
    /// From `reltuples` of the label's table: null until it was analyzed.
    pub row_estimate: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PropertyGraphInfo {
    pub name: String,
    pub schema: String,
    /// The vertex and edge tables' aliases, when the catalog could be read.
    pub elements: Vec<String>,
}

/// Whether the `age` extension is installed in the database `client` is on.
pub async fn age_installed(client: &PgClient) -> AppResult<bool> {
    let sql = "SELECT to_json(EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'age'))";
    Ok(json_query(client, sql).await?.unwrap_or(false))
}

#[derive(Deserialize)]
struct Probe {
    age: bool,
    vector: bool,
    pgq: bool,
}

/// The graphs of the database, and which of the features exist at all.
pub async fn graph_catalog(client: &PgClient) -> AppResult<GraphCatalog> {
    let probe: Probe = json_query(
        client,
        "SELECT json_build_object(
            'age', EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'age'),
            'vector', EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector'),
            -- SQL/PGQ was committed for PostgreSQL 19 and reverted before release;
            -- if it ever ships, its catalogs are the tell
            'pgq', to_regclass('pg_catalog.pg_propgraph_element') IS NOT NULL)",
    )
    .await?
    .unwrap_or(Probe {
        age: false,
        vector: false,
        pgq: false,
    });

    let graphs = if probe.age {
        // `_ag_label_vertex` and `_ag_label_edge` are the parents AGE makes
        // for every graph; nobody queries them by name.
        let sql = "SELECT coalesce(json_agg(json_build_object(
                'name', g.name,
                'namespace', (SELECT nspname FROM pg_namespace WHERE oid = g.namespace::oid),
                'labels', (SELECT coalesce(json_agg(json_build_object(
                        'name', l.name, 'kind', l.kind::text,
                        'rowEstimate', CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::bigint END)
                        ORDER BY l.kind DESC, l.name), '[]')
                    FROM ag_catalog.ag_label l
                    JOIN pg_class c ON c.oid = l.relation::oid
                    WHERE l.graph = g.graphid AND l.name NOT LIKE '\\_ag\\_label\\_%')
            ) ORDER BY g.name), '[]')
            FROM ag_catalog.ag_graph g";
        json_query(client, sql).await?.unwrap_or_default()
    } else {
        Vec::new()
    };

    let property_graphs = if probe.pgq {
        property_graphs(client).await?
    } else {
        Vec::new()
    };

    Ok(GraphCatalog {
        age: probe.age,
        vector: probe.vector,
        graphs,
        property_graphs,
    })
}

/// SQL/PGQ property graphs are relations of kind `g`. Their elements live in
/// `pg_propgraph_element`; that catalog has never been in a release, so
/// reading it is best effort and its absence only leaves the list bare.
async fn property_graphs(client: &PgClient) -> AppResult<Vec<PropertyGraphInfo>> {
    let sql = "SELECT coalesce(json_agg(json_build_object(
            'name', c.relname, 'schema', n.nspname, 'elements', '[]'::json)
            ORDER BY n.nspname, c.relname), '[]')
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind = 'g'";
    let mut found: Vec<PropertyGraphInfo> = json_query(client, sql).await?.unwrap_or_default();
    for graph in &mut found {
        let elements = format!(
            "SELECT coalesce(json_agg(e.pgealias::text ORDER BY e.pgealias::text), '[]')
             FROM pg_catalog.pg_propgraph_element e
             WHERE e.pgepgid = {}::regclass",
            super::literal(&super::qualified(&graph.schema, &graph.name))
        );
        if let Ok(Some(names)) = json_query::<Vec<String>>(client, &elements).await {
            graph.elements = names;
        }
    }
    Ok(found)
}

#[cfg(test)]
mod live_tests {
    //! Against a throwaway server with the extension, never the shared dev
    //! one; each test returns early when its variable isn't set, so the
    //! plain `--ignored` run still passes:
    //!   docker run -d -p 127.0.0.1:5455:5432 -e POSTGRES_PASSWORD=age apache/age:release_PG17_1.7.0
    //!   POSTGRES_STUDIO_AGE_URI=postgres://postgres:age@localhost:5455/postgres \
    //!     cargo test --lib -- --ignored graph::live_tests
    //!   docker run -d -p 127.0.0.1:5456:5432 -e POSTGRES_PASSWORD=vec pgvector/pgvector:pg17
    //!   POSTGRES_STUDIO_VECTOR_URI=postgres://postgres:vec@localhost:5456/postgres \
    //!     cargo test --lib -- --ignored graph::live_tests
    use super::*;
    use crate::models::{
        ConnectionAdvancedOptions, ConnectionProfile, ConnectionSource, SslMode, TlsOptions,
    };
    use crate::pg::{catalog, edit, run, PgSession};
    use crate::secrets::InMemoryStore;
    use std::sync::Arc;

    async fn session(var: &str) -> Option<PgSession> {
        match std::env::var(var) {
            Ok(uri) => Some(connect(uri).await),
            Err(_) => {
                eprintln!("skipped: {var} is not set");
                None
            }
        }
    }

    async fn connect(uri: String) -> PgSession {
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

    fn opts() -> run::RunOptions {
        run::RunOptions {
            row_limit: 100,
            pooler_mode: false,
            wrap_read_only: false,
        }
    }

    #[tokio::test]
    #[ignore]
    async fn live_age_graphs() {
        let Some(s) = session("POSTGRES_STUDIO_AGE_URI").await else {
            return;
        };
        let db = s.target.default_db.clone();
        let c = s.pinned("age", &db).await.unwrap();
        let setup = "CREATE EXTENSION IF NOT EXISTS age; LOAD 'age'; \
            SET search_path = ag_catalog, \"$user\", public; \
            SELECT drop_graph('studio_test', true) WHERE EXISTS (SELECT 1 FROM ag_graph WHERE name = 'studio_test'); \
            SELECT create_graph('studio_test'); \
            SELECT * FROM cypher('studio_test', $$ CREATE (a:Person {name: 'Ann', age: 31})-[:KNOWS {since: 2020}]->(b:Person {name: 'Bo'}) RETURN a $$) AS (a agtype); \
            ANALYZE studio_test.\"Person\"";
        let run = run::run_sql(&c, setup, opts(), None).await;
        for r in &run.results {
            assert!(r.error.is_none(), "{:?}", r.error);
        }

        // the driver names agtype, and the value arrives as its text form
        let run = run::run_sql(
            &c,
            "SELECT * FROM cypher('studio_test', $$ MATCH p = (a:Person)-[e:KNOWS]->(b) RETURN a, e, p $$) AS (a agtype, e agtype, p agtype)",
            opts(),
            None,
        )
        .await;
        let r = &run.results[0];
        assert!(r.error.is_none(), "{:?}", r.error);
        assert_eq!(r.columns[0].type_name, "agtype");
        let vertex = r.rows[0][0].as_deref().unwrap();
        assert!(vertex.ends_with("::vertex"), "{vertex}");
        assert!(r.rows[0][1].as_deref().unwrap().ends_with("::edge"));
        assert!(r.rows[0][2].as_deref().unwrap().ends_with("::path"));

        // the explorer's view: the graph, its labels, and the schemas to hide
        let catalog_view = graph_catalog(&c).await.unwrap();
        assert!(catalog_view.age);
        let graph = catalog_view
            .graphs
            .iter()
            .find(|g| g.name == "studio_test")
            .expect("graph listed");
        assert_eq!(graph.namespace, "studio_test");
        let person = graph.labels.iter().find(|l| l.name == "Person").unwrap();
        assert_eq!(person.kind, "v");
        assert_eq!(person.row_estimate, Some(2));
        assert!(graph
            .labels
            .iter()
            .any(|l| l.name == "KNOWS" && l.kind == "e"));
        assert!(
            !graph
                .labels
                .iter()
                .any(|l| l.name.starts_with("_ag_label_")),
            "{:?}",
            graph.labels
        );
        assert!(age_installed(&c).await.unwrap());
        let schemas = catalog::list_schemas(&c).await.unwrap();
        for hidden in ["ag_catalog", "studio_test"] {
            let schema = schemas.iter().find(|s| s.name == hidden).unwrap();
            assert!(schema.system, "{hidden} should count as a system schema");
        }
        assert!(schemas.iter().any(|s| s.name == "public" && !s.system));

        run::run_sql(&c, "SELECT drop_graph('studio_test', true)", opts(), None).await;
        s.shutdown().await;
    }

    #[tokio::test]
    #[ignore]
    async fn live_catalog_without_the_extensions() {
        // the dev server has neither: nothing to list, and nothing may fail
        let Some(s) = session("POSTGRES_STUDIO_TEST_URI").await else {
            return;
        };
        let c = s.client("shop").await.unwrap();
        let found = graph_catalog(&c).await.unwrap();
        assert!(!found.age && !found.vector);
        assert!(found.graphs.is_empty() && found.property_graphs.is_empty());
        assert!(!age_installed(&c).await.unwrap());
        s.shutdown().await;
    }

    #[tokio::test]
    #[ignore]
    async fn live_vector_values_and_edits() {
        let Some(s) = session("POSTGRES_STUDIO_VECTOR_URI").await else {
            return;
        };
        let db = s.target.default_db.clone();
        let c = s.pinned("vec", &db).await.unwrap();
        let setup = "CREATE EXTENSION IF NOT EXISTS vector; \
            DROP TABLE IF EXISTS studio_items; \
            CREATE TABLE studio_items (id int PRIMARY KEY, embedding vector(3), half halfvec(3), sparse sparsevec(5)); \
            INSERT INTO studio_items VALUES (1, '[1,2,3]', '[0.5,0.25,1]', '{1:1,3:2}/5'), (2, '[4,5,6]', NULL, NULL); \
            CREATE INDEX studio_items_hnsw ON studio_items USING hnsw (embedding vector_cosine_ops)";
        let run = run::run_sql(&c, setup, opts(), None).await;
        for r in &run.results {
            assert!(r.error.is_none(), "{:?}", r.error);
        }

        let found = graph_catalog(&c).await.unwrap();
        assert!(found.vector && !found.age);

        // the types travel as text, and the table's own columns carry the dimension
        let run = run::run_sql(
            &c,
            "SELECT embedding, half, sparse, embedding <=> '[3,2,1]' AS dist FROM studio_items ORDER BY id",
            opts(),
            None,
        )
        .await;
        let r = &run.results[0];
        assert!(r.error.is_none(), "{:?}", r.error);
        assert_eq!(r.columns[0].type_name, "vector");
        assert_eq!(r.columns[1].type_name, "halfvec");
        assert_eq!(r.columns[2].type_name, "sparsevec");
        assert_eq!(r.rows[0][0].as_deref(), Some("[1,2,3]"));
        assert_eq!(r.rows[0][1].as_deref(), Some("[0.5,0.25,1]"));
        assert_eq!(r.rows[0][2].as_deref(), Some("{1:1,3:2}/5"));
        let columns = run::relation_columns(&c, "public", "studio_items")
            .await
            .unwrap();
        assert_eq!(columns[1].type_name, "vector(3)");
        assert_eq!(columns[3].type_name, "sparsevec(5)");

        // editing a vector cell casts the text to the column's own type
        let change = edit::RowEdit::Update {
            key: vec![edit::CellValue {
                column: "id".into(),
                value: Some("1".into()),
                use_default: false,
            }],
            values: vec![
                edit::CellValue {
                    column: "embedding".into(),
                    value: Some("[9, 8.5, -7]".into()),
                    use_default: false,
                },
                edit::CellValue {
                    column: "sparse".into(),
                    value: Some("{2:4}/5".into()),
                    use_default: false,
                },
            ],
        };
        let applied = edit::apply(&c, "public", "studio_items", &[change])
            .await
            .unwrap();
        let row = applied.rows[0].as_ref().unwrap();
        assert_eq!(row[1].as_deref(), Some("[9,8.5,-7]"));
        assert_eq!(row[3].as_deref(), Some("{2:4}/5"));

        // a vector of the wrong size is refused, and nothing is saved
        let wrong = edit::RowEdit::Update {
            key: vec![edit::CellValue {
                column: "id".into(),
                value: Some("2".into()),
                use_default: false,
            }],
            values: vec![edit::CellValue {
                column: "embedding".into(),
                value: Some("[1,2]".into()),
                use_default: false,
            }],
        };
        let err = edit::apply(&c, "public", "studio_items", &[wrong])
            .await
            .unwrap_err();
        assert!(err.to_string().contains("3 dimensions"), "{err}");

        run::run_sql(&c, "DROP TABLE studio_items", opts(), None).await;
        s.shutdown().await;
    }
}
