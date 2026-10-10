# Postgres Studio

An open-source, cross-platform PostgreSQL client built with Tauri (Rust) and React: a dense, IDE-style desktop app for browsing schemas, editing rows inside transactions, running SQL and reading query plans.

Website: <https://pgstudio.nilpointer.tech>

> **Status: early release.** The core is in place and in daily use; expect rough edges. See [PRODUCT.md](PRODUCT.md) for the scope and the roadmap.

## Features

- **Connections** - any number of saved connections (a `postgres://` URI or host/port), TLS (`sslmode` up to `verify-full`, custom CA, client certificate), SSH tunnels (password or key, host keys pinned on first use), read-only connections, a pooler mode for PgBouncer/Supabase in transaction mode, folders and an identity color per connection. Import from pgAdmin's `servers.json`.
- **Secrets stored securely** - passwords and passphrases go to the OS keychain (macOS Keychain / Windows Credential Manager / Linux Secret Service), with an encrypted-file fallback on headless Linux.
- **Explorer** - connection > database > schema > tables, views, materialized views, functions, sequences and types, plus installed extensions and Apache AGE graphs, with a quick open (Ctrl+K) across every schema.
- **Table tabs** - Data (WHERE / ORDER BY / LIMIT / OFFSET, a typed virtualized grid, foreign keys you can follow, a row inspector with references both ways), Structure (columns, constraints, indexes with usage, triggers, view definitions, DDL; new index, enable/disable or drop a trigger) and SQL (a console scoped to the table), all in the same tab.
- **Edits inside a transaction** - edited, added and deleted rows wait as pending changes; review the generated SQL, then Commit (Ctrl+S) or discard.
- **SQL console** - runs the statement at the caret or the selection, one result tab per statement plus Messages, auto-commit or manual transactions, cancel, saved scripts. Large results read only the rows shown.
- **SQL files of any size** - run from disk, streamed statement by statement (`COPY ... FROM stdin` blocks included), stop or continue on errors, with progress and the failing lines.
- **Explain** - `EXPLAIN` and `EXPLAIN (ANALYZE, BUFFERS)` (rolled back) as a tree with time per node and estimated against actual rows.
- **Schema diagram** - a schema's tables and foreign keys, laid out automatically; trace a table's keys, open it, export the diagram as SVG.
- **Import and export** - query results and whole tables to CSV or JSON; CSV files into a table with a column mapping.
- **Backup and restore** - `pg_dump` (custom, directory, tar, plain) and `pg_restore` / `psql`, with the client tools already on the machine.
- **Server activity** - sessions and locks with cancel and terminate; roles; extensions to install, update or drop; VACUUM, ANALYZE, REINDEX and generated SQL for a table.
- **Graphs and vectors** - Cypher inside `cypher()` calls highlighted and completed for Apache AGE, vertices and edges shown readably; pgvector values shown compactly, with the distance operators and index opclasses in completion.
- **Tab groups and split view** - tabs grouped by connection, up to four panes side by side.
- **Assistant (opt-in)** - ask in plain words, answered by the Claude Code or Codex CLI you already have installed; the agent reads your server only through read-only tools the app serves.

## Logs

Postgres Studio keeps a log file, so a failed connection or a crash can be looked into after the fact. To find it, open the command palette (Ctrl/Cmd+K) and choose **Open logs folder**. The crash screen has the same button. The file is `postgres-studio.log` in:

| OS | Folder |
| --- | --- |
| Windows | `%LOCALAPPDATA%\com.edneymesquita.postgres-studio\logs` |
| macOS | `~/Library/Logs/com.edneymesquita.postgres-studio` |
| Linux | `$XDG_DATA_HOME/com.edneymesquita.postgres-studio/logs`, usually `~/.local/share/com.edneymesquita.postgres-studio/logs` |

When the file reaches 5 MB it is renamed with a timestamp and a new one is started. The five most recent old files are kept.

**What's never logged:** passwords, passphrases or other secrets; connection strings (only the hosts, with no user or options); SQL text or row values. When a query fails, only the kind of error and the server's SQLSTATE are written, because the server's message can quote your data.

## Development

Prerequisites:

- [Node.js](https://nodejs.org/) 20+
- [Rust](https://www.rust-lang.org/tools/install) (via `rustup`)
- Tauri's platform prerequisites: see [tauri.app/start/prerequisites](https://tauri.app/start/prerequisites/)
- Docker, for the local PostgreSQL used by the integration tests

```sh
npm install
npm run tauri dev
```

A local server with sample data (a `shop` database with foreign keys, an enum, `jsonb` and `citext` columns):

```sh
docker compose -f docker-compose.dev.yml up -d
```

Backend tests:

```sh
cd src-tauri
cargo test
```

Integration tests that talk to a real PostgreSQL are marked `#[ignore]`. With the dev server up, run them explicitly:

```sh
export POSTGRES_STUDIO_TEST_URI="postgres://postgres:postgres@localhost:5433/shop"
cargo test --lib -- --ignored
```

## Benchmarks

`scripts/bench.mjs` times the backend's commands through the dev bridge (the same commands and JSON as the app's IPC), so an optimization can be measured before and after. It needs a `bench` database with a large table on the dev server:

```sh
docker exec postgres-studio-dev psql -U postgres -c "create database bench"
docker exec postgres-studio-dev psql -U postgres -d bench -c "create table big as select g as id, md5(g::text) as hash, (random()*1e6)::int as qty, now() - (g || ' seconds')::interval as created_at, jsonb_build_object('k', g) as meta, (g % 7 = 0) as flag, repeat('x', 40) as filler, gen_random_uuid() as uid, (random()*1000)::numeric(12,2) as price, null::text as empty from generate_series(1, 1000000) g; alter table big add primary key (id); analyze big;"
(cd src-tauri && cargo build --release --features devbridge --bin devbridge) && src-tauri/target/release/devbridge &
node scripts/bench.mjs <connection id> --runs 5
```

Startup is marked in the page as `performance.mark("app-mounted")` (the first React commit), next to the navigation timings.

## Building

```sh
npm run tauri build
```

Produces a platform-native installer (`.dmg`/`.app` on macOS, `.msi`/`.exe` on Windows, `.deb`/`.rpm`/`.AppImage` on Linux) under `src-tauri/target/release/bundle/`.

### Regenerating the app icon

The source design is `src-tauri/icons/icon-source.svg`. After editing it, regenerate every platform variant with:

```sh
npx tauri icon src-tauri/icons/icon-source.svg
```

## Releasing

Pushing a tag matching `vX.Y.Z` triggers `.github/workflows/release.yml`, which builds installers for macOS (universal binary), Windows, and Linux and attaches them to a **draft** GitHub release for review before publishing. Builds are unsigned, so first launches will trip Gatekeeper (macOS) or SmartScreen (Windows) warnings until code signing is set up separately.

The Microsoft Store package (MSIX) is built by `.github/workflows/microsoft-store.yml`; see [docs/microsoft-store.md](docs/microsoft-store.md).

## License

MIT - see [LICENSE](LICENSE).

PostgreSQL is a trademark of the PostgreSQL Community Association; Postgres Studio is an independent project, not affiliated with or endorsed by it.
