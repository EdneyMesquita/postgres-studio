//! Reads and actions on the objects around a table: extensions, roles and
//! maintenance. Triggers and indexes come with the table's description, in
//! `catalog`.

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
}
