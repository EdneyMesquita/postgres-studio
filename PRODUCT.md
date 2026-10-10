# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

(Desktop app: a Tauri 2 shell around a React web view, shipped for macOS, Windows and Linux. The UI is web technology in a native window, with native file dialogs, OS keychain and menus from Tauri.)

## Users

Backend developers who spend much of their day inside PostgreSQL databases across several environments (local, staging, production, hosted services such as Supabase, Neon or RDS): finding a row, following it to the rows it references, checking why a query is slow, fixing a value inside a transaction, running ad-hoc SQL, comparing the same table on two servers.

## Product Purpose

An open-source, cross-platform PostgreSQL client focused on Postgres alone: browse schemas and tables, edit rows with pending changes that wait for Commit, follow foreign keys in both directions, run SQL, read `EXPLAIN ANALYZE` plans and see a schema's structure - without signing into anything. Success is a developer getting to the right row or answer faster than with pgAdmin, DBeaver or psql.

## Positioning

- **Postgres only, done deeply:** no lowest-common-denominator across databases; Postgres types, plans, catalogs and operational views get first-class screens.
- **Light and offline:** a small native app, MIT-licensed, that works fully offline with no account and no telemetry.
- **Several servers at once:** many live connections side by side, each tab bound to its own connection, database and schema.

## Operating Context

Used for long stretches next to an IDE and a terminal, often on a laptop screen. Typical loop: connect to one or more servers, open a database and schema, open tables as tabs, filter and sort, follow a foreign key, double-click to edit a value, review and commit, switch the same tab to SQL for an ad-hoc query, explain it, save scripts to disk.

## Capabilities and Constraints

- Connections: `postgres://` URI or host/port form with General/TLS/SSH/Advanced sections; `sslmode`; a pooler mode for PgBouncer or Supabase in transaction mode (no prepared statements, no session state); an optional identity color; secrets in the OS keychain; folders.
- A connection reaches one database at a time on the server side, so the app keeps one client per connection and database, opened when a database is expanded.
- Explorer: connection > database > schema > Tables / Views / Materialized views / Functions / Sequences / Types; a Ctrl+K quick open for tables, saved scripts and actions.
- Table tabs with three views in the same tab: Data, Structure and SQL (a console scoped to the table, prefilled with a query on it).
- Data: WHERE / ORDER BY / LIMIT / OFFSET; typed grid with primary and foreign key marks; a row inspector with References and Referenced by; edits held as pending changes until Commit or Rollback, allowed only on tables with a primary or unique key.
- Console tabs: a SQL editor bound to one database; runs the statement at the caret or the selection; one result tab per statement plus Messages; auto-commit or manual transactions; cancel.
- Explain: `EXPLAIN (ANALYZE, BUFFERS)` as a tree.
- Tab groups and a split editor of up to four panes.
- Assistant (opt-in): drives the Claude Code or Codex CLI already installed on the machine, through read-only tools served over a local MCP server, on a session with `default_transaction_read_only`.
- Terminology: connection, database, schema, table, view, row, column, key, query, console, transaction, saved script, tab, Assistant.

## Roadmap

- Phase 1 (done): connections, explorer, table Data/Structure/SQL, pending edits with Commit, SQL console, Explain, schema diagram, CSV/JSON export.
- Phase 2 (done, 0.1.0): dump and restore (`pg_dump` / `pg_restore`), SQL files run from disk, CSV import, triggers, extensions, server activity, roles, maintenance, graph queries (Apache AGE), pgvector, performance work.
- Next: SQL/PGQ property graphs once a PostgreSQL release ships them (only detected today), `pg_stat_statements`, bloat.

## Brand Commitments

- Name: Postgres Studio, an independent project (PostgreSQL is a trademark of the PostgreSQL Community Association; the elephant logo is not used). The app icon is `src-tauri/icons/icon-source.svg`.
- Appearance: one visual identity in a light and a dark version (DESIGN.md).
- UI copy is in English.
- The category standard, a dense IDE-style tool, executed at full craft - it should sit comfortably next to DataGrip / JetBrains New UI, VS Code and Linear.

## Evidence on Hand

Sample data lives only in the local dev database (docker-compose.dev.yml). No customers, testimonials or usage numbers exist; none may be invented.

## Product Principles

1. The data is the interface: rows, columns and types get the space and the clearest type; chrome recedes.
2. Always show where you are: which server, database, schema and table every tab, query and console runs against.
3. Nothing is written by surprise: edits wait as pending changes with their SQL visible until the user commits.
4. Fast by keyboard, fine by mouse: every frequent action has a shortcut and a visible control.
5. Nothing leaves the machine: no account, no network beyond the user's own servers. The one exception is the Assistant, off until the user sets it up.
