# Contributing to Postgres Studio

Thanks for taking a look! This project is small and young, so the process is intentionally lightweight.

## Getting set up

See the [README](README.md#development) for prerequisites and how to run the app locally.

## Making a change

1. Fork the repo and create a branch off `main`.
2. Make your change. Keep pull requests focused - a bug fix and an unrelated refactor should be two PRs, not one.
3. Before opening a PR, run locally:

   ```sh
   cd src-tauri
   cargo fmt
   cargo clippy --all-targets -- -D warnings
   cargo test

   cd ..
   npm run build   # runs tsc, so this also type-checks the frontend
   ```

4. Open a pull request against `main`. CI runs the same checks above (`fmt`, `clippy`, `cargo test`, the frontend build) automatically, and at least one review is required before merging - both are enforced by branch protection, not just convention.

## Scope of tests in CI

Integration tests that talk to a live PostgreSQL server are marked `#[ignore]` and are **not** run in CI (there's no database available there). If your change touches connection/query/scripting/export logic, please also run the relevant ignored test(s) locally against a real database and mention that you did in the PR description - see [README](README.md#development) for how.

## Reporting bugs / requesting features

Open an issue using the appropriate template. For security-sensitive reports (e.g. a way to bypass the secret store or SSH host-key checks), please don't open a public issue - email the address in [SECURITY.md](SECURITY.md) instead.

## Code style

- Rust: formatted with `cargo fmt`, linted with `cargo clippy -D warnings`. No `unwrap()`/`expect()` outside tests unless the panic is genuinely a programmer error, not a runtime condition.
- TypeScript/React: no new component library without discussion first - the app intentionally has minimal dependencies for its UI.
- Comments explain *why*, not *what* - if a comment just restates the code, delete it.
