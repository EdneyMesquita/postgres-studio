//! Backup and restore with PostgreSQL's own client tools: `pg_dump`,
//! `pg_restore` and, for plain SQL files, `psql`.
//!
//! The tools make connections of their own, so a session's settings are
//! handed over as `PG*` environment variables - never as arguments, which
//! any user on the machine can read in the process list. Arguments are
//! always an array, never a shell string.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Runtime, State};
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;
use tokio_postgres::config::Host;

use crate::error::{AppError, AppResult};
use crate::logging::Op;
use crate::models::SslMode;
use crate::pg::connect::Target;
use crate::pg::{qualified, PgSession};
use crate::state::{AppState, CancelToken, RunningTask};

pub const DUMP_EVENT: &str = "dump-progress";
pub const RESTORE_EVENT: &str = "restore-progress";

/// Names a folder to look in first; for development and tests.
const BIN_OVERRIDE: &str = "POSTGRES_STUDIO_PG_BIN";
const VERSION_TIMEOUT: Duration = Duration::from_secs(5);
/// Progress events wait at least this long between two lines.
const PROGRESS_EVERY: Duration = Duration::from_millis(80);
const TAIL_LINES: usize = 12;
const MAX_LINE: usize = 400;
const MAX_NOTES: usize = 100;

// ---------------------------------------------------------------------------
// Finding the tools
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PgTool {
    pub path: String,
    /// As `--version` prints it, e.g. `17.6`.
    pub version: String,
    pub major: u32,
}

/// Every copy of each tool found, newest first, and where it looked.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PgToolsInfo {
    pub pg_dump: Vec<PgTool>,
    pub pg_restore: Vec<PgTool>,
    pub psql: Vec<PgTool>,
    pub searched: Vec<String>,
}

/// Where the tools usually live besides the PATH, with `*` for the
/// version folder.
fn install_patterns() -> Vec<&'static str> {
    let mut patterns = Vec::new();
    if cfg!(target_os = "linux") {
        patterns.extend(["/usr/lib/postgresql/*/bin", "/usr/pgsql-*/bin"]);
    }
    if cfg!(target_os = "macos") {
        patterns.extend([
            "/Applications/Postgres.app/Contents/Versions/*/bin",
            "/opt/homebrew/opt/postgresql@*/bin",
            "/usr/local/opt/postgresql@*/bin",
            // A GUI app's PATH leaves these out.
            "/opt/homebrew/bin",
            "/usr/local/bin",
        ]);
    }
    if cfg!(windows) {
        patterns.push(r"C:\Program Files\PostgreSQL\*\bin");
    }
    patterns
}

/// Whether `name` fits `pattern`, where `*` stands for any text.
fn wild_match(pattern: &str, name: &str) -> bool {
    let parts: Vec<&str> = pattern.split('*').collect();
    let (first, rest) = parts.split_first().expect("split yields one part");
    let Some(mut tail) = name.strip_prefix(first) else {
        return false;
    };
    let Some((last, middle)) = rest.split_last() else {
        return tail.is_empty();
    };
    for part in middle {
        match tail.find(part) {
            Some(at) => tail = &tail[at + part.len()..],
            None => return false,
        }
    }
    tail.ends_with(last)
}

/// The folders a pattern names; a component with `*` matches any entry.
fn expand(pattern: &str) -> Vec<PathBuf> {
    let mut paths = vec![PathBuf::new()];
    for component in Path::new(pattern).components() {
        let part = component.as_os_str().to_string_lossy().into_owned();
        let mut next = Vec::new();
        for base in &paths {
            if part.contains('*') {
                let Ok(entries) = std::fs::read_dir(base) else {
                    continue;
                };
                for entry in entries.flatten() {
                    if wild_match(&part, &entry.file_name().to_string_lossy()) {
                        next.push(entry.path());
                    }
                }
            } else {
                next.push(base.join(&part));
            }
        }
        paths = next;
    }
    paths
}

/// `pg_dump (PostgreSQL) 17.6`, or Debian's `... 16.4 (Ubuntu 16.4-1.pgdg22.04+1)`:
/// `("17.6", 17)`.
pub fn parse_version(output: &str) -> Option<(String, u32)> {
    let line = output.lines().find(|l| l.contains("(PostgreSQL)"))?;
    let version = line
        .split_once("(PostgreSQL)")?
        .1
        .split_whitespace()
        .next()?;
    Some((version.to_string(), major_of(version)?))
}

/// The major version of `17.11`, `9.6.24` or `18beta1`.
pub fn major_of(version: &str) -> Option<u32> {
    let digits: String = version
        .trim()
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    digits.parse().ok()
}

fn exe_name(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

fn hide_window(_command: &mut Command) {
    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW: no console window flashing up for each run.
        _command.creation_flags(0x0800_0000);
    }
}

async fn probe(path: PathBuf) -> Option<PgTool> {
    let mut command = Command::new(&path);
    command
        .arg("--version")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    hide_window(&mut command);
    let output = tokio::time::timeout(VERSION_TIMEOUT, command.output())
        .await
        .ok()?
        .ok()?;
    let (version, major) = parse_version(&String::from_utf8_lossy(&output.stdout))?;
    Some(PgTool {
        path: path.display().to_string(),
        version,
        major,
    })
}

/// The folders to look in: the override, the PATH, the usual installs.
fn search_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(dir) = std::env::var_os(BIN_OVERRIDE) {
        dirs.push(PathBuf::from(dir));
    }
    if let Some(path) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&path));
    }
    for pattern in install_patterns() {
        dirs.extend(expand(pattern));
    }
    let mut seen = Vec::new();
    dirs.retain(|d| {
        let key = std::fs::canonicalize(d).unwrap_or_else(|_| d.clone());
        let new = !seen.contains(&key);
        seen.push(key);
        new
    });
    dirs
}

pub async fn find_tools() -> PgToolsInfo {
    let dirs = search_dirs();
    let mut found = Vec::new();
    for name in ["pg_dump", "pg_restore", "psql"] {
        let mut candidates: Vec<PathBuf> = Vec::new();
        for dir in &dirs {
            let file = dir.join(exe_name(name));
            if file.is_file() {
                let key = std::fs::canonicalize(&file).unwrap_or_else(|_| file.clone());
                if !candidates
                    .iter()
                    .any(|c| std::fs::canonicalize(c).unwrap_or_else(|_| c.clone()) == key)
                {
                    candidates.push(file);
                }
            }
        }
        let mut tools: Vec<PgTool> =
            futures_util::future::join_all(candidates.into_iter().map(probe))
                .await
                .into_iter()
                .flatten()
                .collect();
        // Stable, so equal versions keep the order they were found in.
        tools.sort_by_key(|t| std::cmp::Reverse(t.major));
        found.push(tools);
    }
    let mut searched = Vec::new();
    if let Some(dir) = std::env::var_os(BIN_OVERRIDE) {
        searched.push(PathBuf::from(dir).display().to_string());
    }
    searched.push("PATH".to_string());
    searched.extend(install_patterns().into_iter().map(str::to_string));
    let mut found = found.into_iter();
    PgToolsInfo {
        pg_dump: found.next().unwrap_or_default(),
        pg_restore: found.next().unwrap_or_default(),
        psql: found.next().unwrap_or_default(),
        searched,
    }
}

// ---------------------------------------------------------------------------
// Connection settings, as the environment the tools read
// ---------------------------------------------------------------------------

/// What a tool needs to reach the server a session is connected to.
#[derive(Debug, Clone, Default)]
pub struct PgConn {
    pub host: Option<String>,
    pub hostaddr: Option<String>,
    pub port: Option<String>,
    pub user: Option<String>,
    pub password: Option<String>,
    pub ssl_mode: SslMode,
    pub ssl_root_cert: Option<String>,
    pub ssl_cert: Option<String>,
    pub ssl_key: Option<String>,
    pub app_name: Option<String>,
    pub connect_timeout_secs: Option<u64>,
}

impl PgConn {
    /// From the driver config the session connects with: through an SSH
    /// tunnel that is the real host name (for the certificate check), the
    /// tunnel's local address and its port.
    pub fn from_target(target: &Target) -> Self {
        let config = target.config();
        let join = |items: Vec<String>| (!items.is_empty()).then(|| items.join(","));
        let tls = &target.tls_options;
        Self {
            host: join(
                config
                    .get_hosts()
                    .iter()
                    .map(|h| match h {
                        Host::Tcp(h) => h.clone(),
                        #[cfg(unix)]
                        Host::Unix(p) => p.to_string_lossy().into_owned(),
                    })
                    .collect(),
            ),
            hostaddr: join(
                config
                    .get_hostaddrs()
                    .iter()
                    .map(|a| a.to_string())
                    .collect(),
            ),
            port: join(config.get_ports().iter().map(u16::to_string).collect()),
            user: config.get_user().map(str::to_string),
            password: config
                .get_password()
                .map(|p| String::from_utf8_lossy(p).into_owned()),
            ssl_mode: tls.ssl_mode,
            ssl_root_cert: tls.ca_file.clone(),
            ssl_cert: tls.cert_file.clone(),
            ssl_key: tls.key_file.clone(),
            app_name: config.get_application_name().map(str::to_string),
            connect_timeout_secs: config
                .get_connect_timeout()
                .map(|d| d.as_secs_f64().ceil() as u64),
        }
    }

    /// The `PG*` variables for a tool of version `tool_major`.
    pub fn env(&self, database: &str, tool_major: u32) -> Vec<(&'static str, String)> {
        let mut env = vec![("PGDATABASE", database.to_string())];
        let mut put = |key: &'static str, value: &Option<String>| {
            if let Some(v) = value.as_ref().filter(|v| !v.is_empty()) {
                env.push((key, v.clone()));
            }
        };
        put("PGHOST", &self.host);
        put("PGHOSTADDR", &self.hostaddr);
        put("PGPORT", &self.port);
        put("PGUSER", &self.user);
        put("PGPASSWORD", &self.password);
        put("PGSSLROOTCERT", &self.ssl_root_cert);
        put("PGSSLCERT", &self.ssl_cert);
        put("PGSSLKEY", &self.ssl_key);
        put("PGAPPNAME", &self.app_name);
        let mode = match self.ssl_mode {
            SslMode::Disable => "disable",
            SslMode::Prefer => "prefer",
            SslMode::Require => "require",
            SslMode::VerifyCa => "verify-ca",
            SslMode::VerifyFull => "verify-full",
        };
        env.push(("PGSSLMODE", mode.to_string()));
        // The app trusts the system's CAs when none is named; libpq 16+ can
        // be told to as well.
        let verifies = matches!(self.ssl_mode, SslMode::VerifyCa | SslMode::VerifyFull);
        if verifies && self.ssl_root_cert.is_none() && tool_major >= 16 {
            env.push(("PGSSLROOTCERT", "system".to_string()));
        }
        if let Some(secs) = self.connect_timeout_secs {
            env.push(("PGCONNECT_TIMEOUT", secs.max(1).to_string()));
        }
        env
    }
}

/// Variables that would steer a tool somewhere else than the session.
const STRAY_ENV: [&str; 8] = [
    "PGSERVICE",
    "PGSERVICEFILE",
    "PGPASSFILE",
    "PGOPTIONS",
    "PGSSLCRL",
    "PGTARGETSESSIONATTRS",
    "PGSSLSNI",
    "PGCLIENTENCODING",
];

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BackupFormat {
    /// `-Fc`: compressed, restored with `pg_restore`.
    Custom,
    /// `-Fp`: a SQL script, restored with `psql`.
    Plain,
    /// `-Fd`: a folder with one file per table; the only one `-j` dumps in parallel.
    Directory,
    /// `-Ft`
    Tar,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Content {
    #[default]
    All,
    SchemaOnly,
    DataOnly,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableRef {
    pub schema: String,
    pub name: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DumpOptions {
    pub format: BackupFormat,
    #[serde(default)]
    pub content: Content,
    /// Only these schemas, when not empty.
    #[serde(default)]
    pub schemas: Vec<String>,
    /// Only these tables, when not empty.
    #[serde(default)]
    pub tables: Vec<TableRef>,
    /// Tables kept in the backup without their rows.
    #[serde(default)]
    pub exclude_data: Vec<TableRef>,
    #[serde(default)]
    pub no_owner: bool,
    #[serde(default)]
    pub no_privileges: bool,
    /// Plain format: drop each object before creating it.
    #[serde(default)]
    pub clean: bool,
    /// 0-9, for the custom and directory formats; the tool's default when absent.
    pub compression: Option<u8>,
    /// Directory format only.
    pub jobs: Option<u32>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreOptions {
    #[serde(default)]
    pub content: Content,
    /// Drop each object before creating it (`--clean --if-exists`).
    #[serde(default)]
    pub clean: bool,
    /// Create the database the archive was taken from, connecting to the
    /// given one first.
    #[serde(default)]
    pub create: bool,
    #[serde(default)]
    pub no_owner: bool,
    #[serde(default)]
    pub no_privileges: bool,
    #[serde(default)]
    pub single_transaction: bool,
    #[serde(default)]
    pub exit_on_error: bool,
    pub jobs: Option<u32>,
}

fn invalid(message: &str) -> AppError {
    AppError::InvalidInput(message.to_string())
}

/// `-F` letter, for the dump.
fn format_letter(format: BackupFormat) -> &'static str {
    match format {
        BackupFormat::Custom => "c",
        BackupFormat::Plain => "p",
        BackupFormat::Directory => "d",
        BackupFormat::Tar => "t",
    }
}

/// `pg_dump`'s arguments. The database and the login come from the
/// environment.
pub fn dump_args(options: &DumpOptions, dest: &Path) -> AppResult<Vec<String>> {
    if options.compression.is_some_and(|level| level > 9) {
        return Err(invalid("compression level must be between 0 and 9"));
    }
    if options.jobs == Some(0) {
        return Err(invalid("jobs must be at least 1"));
    }
    let mut args = vec![
        "--verbose".to_string(),
        "--no-password".to_string(),
        format!("--format={}", format_letter(options.format)),
        // `=`, so a name starting with a dash is not taken for an option
        format!("--file={}", dest.display()),
    ];
    match options.content {
        Content::All => {}
        Content::SchemaOnly => args.push("--schema-only".to_string()),
        Content::DataOnly => args.push("--data-only".to_string()),
    }
    args.extend(
        options
            .schemas
            .iter()
            .map(|s| format!("--schema={}", crate::pg::ident(s))),
    );
    args.extend(
        options
            .tables
            .iter()
            .map(|t| format!("--table={}", qualified(&t.schema, &t.name))),
    );
    args.extend(
        options
            .exclude_data
            .iter()
            .map(|t| format!("--exclude-table-data={}", qualified(&t.schema, &t.name))),
    );
    if options.no_owner {
        args.push("--no-owner".to_string());
    }
    if options.no_privileges {
        args.push("--no-privileges".to_string());
    }
    if options.clean && options.format == BackupFormat::Plain {
        args.push("--clean".to_string());
        args.push("--if-exists".to_string());
    }
    if let Some(level) = options.compression {
        // The tar format can't compress, and a compressed plain file would
        // no longer be a SQL script.
        if matches!(
            options.format,
            BackupFormat::Custom | BackupFormat::Directory
        ) {
            args.push(format!("--compress={level}"));
        }
    }
    if let Some(jobs) = options.jobs.filter(|&j| j > 1) {
        if options.format == BackupFormat::Directory {
            args.push(format!("--jobs={jobs}"));
        }
    }
    Ok(args)
}

/// `dbname='shop'` as a connection string, which no database name can
/// turn into another option (or another connection).
fn dbname_param(database: &str) -> String {
    format!(
        "dbname='{}'",
        database.replace('\\', "\\\\").replace('\'', "\\'")
    )
}

/// `pg_restore`'s arguments for an archive.
pub fn restore_args(
    format: BackupFormat,
    options: &RestoreOptions,
    database: &str,
    source: &Path,
) -> AppResult<Vec<String>> {
    if options.create && options.single_transaction {
        return Err(invalid(
            "\"Create the database\" and \"Single transaction\" can't be combined",
        ));
    }
    if options.clean && options.content == Content::DataOnly {
        return Err(invalid(
            "\"Drop objects first\" can't be combined with data only",
        ));
    }
    if options.jobs == Some(0) {
        return Err(invalid("jobs must be at least 1"));
    }
    let mut args = vec![
        "--verbose".to_string(),
        "--no-password".to_string(),
        // Without a database pg_restore prints a script and restores nothing.
        format!("--dbname={}", dbname_param(database)),
    ];
    if options.clean {
        args.push("--clean".to_string());
        args.push("--if-exists".to_string());
    }
    if options.create {
        args.push("--create".to_string());
    }
    match options.content {
        Content::All => {}
        Content::SchemaOnly => args.push("--schema-only".to_string()),
        Content::DataOnly => args.push("--data-only".to_string()),
    }
    if options.no_owner {
        args.push("--no-owner".to_string());
    }
    if options.no_privileges {
        args.push("--no-privileges".to_string());
    }
    if options.single_transaction {
        args.push("--single-transaction".to_string());
    } else if let Some(jobs) = options.jobs.filter(|&j| j > 1) {
        if format != BackupFormat::Tar {
            args.push(format!("--jobs={jobs}"));
        }
    }
    if options.exit_on_error {
        args.push("--exit-on-error".to_string());
    }
    args.push("--".to_string());
    args.push(source.display().to_string());
    Ok(args)
}

/// `psql`'s arguments for a SQL script: it stops at the first error.
pub fn psql_args(options: &RestoreOptions, database: &str, source: &Path) -> Vec<String> {
    let mut args = vec![
        "--no-psqlrc".to_string(),
        "--no-password".to_string(),
        "--set=ON_ERROR_STOP=1".to_string(),
        format!("--dbname={}", dbname_param(database)),
    ];
    if options.single_transaction {
        args.push("--single-transaction".to_string());
    }
    args.push(format!("--file={}", source.display()));
    args
}

// ---------------------------------------------------------------------------
// Recognizing a backup
// ---------------------------------------------------------------------------

/// What kind of backup `path` is, from its content: a custom archive starts
/// with `PGDMP`, a directory backup holds `toc.dat`, a tar backup has
/// `toc.dat` as its first member; anything else is taken for SQL.
pub fn detect_format(path: &Path) -> AppResult<BackupFormat> {
    use std::io::Read;
    if path.is_dir() {
        return if path.join("toc.dat").is_file() {
            Ok(BackupFormat::Directory)
        } else {
            Err(AppError::Tool(
                "This folder isn't a pg_dump directory backup: it has no toc.dat.".to_string(),
            ))
        };
    }
    let mut head = Vec::with_capacity(512);
    std::fs::File::open(path)?
        .take(512)
        .read_to_end(&mut head)?;
    if head.starts_with(b"PGDMP") {
        Ok(BackupFormat::Custom)
    } else if head.starts_with(b"toc.dat\0") && head.get(257..262) == Some(b"ustar".as_slice()) {
        Ok(BackupFormat::Tar)
    } else if head.starts_with(&[0x1f, 0x8b]) {
        Err(AppError::Tool(
            "This file is gzip-compressed. Decompress it first, then restore the result."
                .to_string(),
        ))
    } else {
        Ok(BackupFormat::Plain)
    }
}

// ---------------------------------------------------------------------------
// TimescaleDB in a backup
// ---------------------------------------------------------------------------

/// Whether a `pg_restore -l` line is the TimescaleDB extension's entry. The
/// name is matched whole: `timescaledb_toolkit` is another extension.
pub fn toc_line_is_timescale(line: &str) -> bool {
    line.split_once("EXTENSION - ")
        .and_then(|(_, rest)| rest.split_whitespace().next())
        == Some("timescaledb")
}

/// Whether a line of a SQL script creates the TimescaleDB extension.
pub fn sql_line_creates_timescale(line: &str) -> bool {
    let lower = line.trim_start().to_ascii_lowercase();
    let Some(rest) = lower.strip_prefix("create extension ") else {
        return false;
    };
    let rest = rest.trim_start();
    let rest = rest
        .strip_prefix("if not exists ")
        .unwrap_or(rest)
        .trim_start();
    rest.split(|c: char| c.is_whitespace() || c == ';').next() == Some("timescaledb")
}

/// Whether a custom, tar or directory backup holds the extension, from its
/// table of contents. Only the file is read, not the server.
async fn archive_has_timescale(tool: &PgTool, source: &Path) -> AppResult<bool> {
    let mut command = Command::new(&tool.path);
    command
        .arg("-l")
        .arg("--")
        .arg(source)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    hide_window(&mut command);
    let output = command
        .output()
        .await
        .map_err(|e| AppError::Tool(format!("Couldn't start pg_restore: {e}")))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(AppError::Tool(if stderr.is_empty() {
            "pg_restore couldn't read this backup.".to_string()
        } else {
            clip(&stderr)
        }));
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .any(toc_line_is_timescale))
}

/// Whether a SQL script creates the extension. It is read a line at a time,
/// so a large dump is never held in memory, and reading stops at the first match.
async fn sql_has_timescale(source: &Path) -> AppResult<bool> {
    let mut reader = BufReader::new(tokio::fs::File::open(source).await?);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        if reader.read_until(b'\n', &mut buf).await? == 0 {
            return Ok(false);
        }
        if sql_line_creates_timescale(&String::from_utf8_lossy(&buf)) {
            return Ok(true);
        }
    }
}

/// Whether the backup holds TimescaleDB. `tool` is `pg_restore` for every
/// format but plain, where it is `psql` and unused.
async fn backup_has_timescale(
    tool: &PgTool,
    format: BackupFormat,
    source: &Path,
) -> AppResult<bool> {
    if format == BackupFormat::Plain {
        sql_has_timescale(source).await
    } else {
        archive_has_timescale(tool, source).await
    }
}

/// Bytes in a file, or in all the files of a folder.
fn size_of(path: &Path) -> u64 {
    match std::fs::metadata(path) {
        Ok(m) if m.is_dir() => std::fs::read_dir(path)
            .map(|entries| entries.flatten().map(|e| size_of(&e.path())).sum())
            .unwrap_or(0),
        Ok(m) => m.len(),
        Err(_) => 0,
    }
}

// ---------------------------------------------------------------------------
// Running a tool
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq)]
enum ToolKind {
    Dump,
    Restore,
    Psql,
}

/// Whether a progress line says one more object was handled.
fn counts_as_object(kind: ToolKind, line: &str) -> bool {
    match kind {
        ToolKind::Dump => line.contains("dumping contents of table"),
        ToolKind::Restore => line.contains(": creating ") || line.contains("processing data for"),
        ToolKind::Psql => line.starts_with("CREATE "),
    }
}

#[derive(Default)]
struct Finished {
    code: Option<i32>,
    /// The last lines either stream printed.
    tail: VecDeque<String>,
    warnings: Vec<String>,
    errors: Vec<String>,
    /// `pg_restore` finished, with errors it was told to go on past.
    errors_ignored: bool,
}

impl Finished {
    fn success(&self) -> bool {
        self.code == Some(0)
    }

    /// What went wrong, in the tool's words.
    fn failure(&self, name: &str) -> AppError {
        let text = self.tail.iter().cloned().collect::<Vec<_>>().join("\n");
        AppError::Tool(match (text.is_empty(), self.code) {
            (false, _) => text,
            (true, Some(code)) => format!("{name} failed with exit code {code}."),
            (true, None) => format!("{name} was stopped before it finished."),
        })
    }
}

fn clip(line: &str) -> String {
    match line.char_indices().nth(MAX_LINE) {
        Some((at, _)) => format!("{}...", &line[..at]),
        None => line.to_string(),
    }
}

/// Sends the lines of a stream, whole, until it closes.
async fn pump(stream: impl AsyncRead + Unpin, tx: mpsc::UnboundedSender<String>) {
    let mut reader = BufReader::new(stream);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        // Bytes, not `lines()`: a tool may quote data that isn't UTF-8.
        match reader.read_until(b'\n', &mut buf).await {
            Ok(0) | Err(_) => return,
            Ok(_) => {
                let line = String::from_utf8_lossy(&buf).trim_end().to_string();
                if !line.is_empty() && tx.send(line).is_err() {
                    return;
                }
            }
        }
    }
}

/// Runs `program` to its end, or kills it when `cancel` fires. `on_line`
/// gets the progress lines (not every one, when they come fast) with how
/// many objects were handled so far.
async fn run_tool(
    program: &str,
    args: &[String],
    env: &[(&'static str, String)],
    kind: ToolKind,
    cancel: &CancelToken,
    mut on_line: impl FnMut(&str, u64),
) -> AppResult<Finished> {
    let name = Path::new(program)
        .file_stem()
        .map_or(program.to_string(), |n| n.to_string_lossy().into_owned());
    let mut command = Command::new(program);
    command.args(args);
    for key in STRAY_ENV {
        command.env_remove(key);
    }
    for (key, value) in env {
        command.env(key, value);
    }
    command
        // pg_dump and friends color their messages when asked to; the
        // dialog shows plain text.
        .env("PG_COLOR", "never")
        .env("LC_MESSAGES", "C")
        .env("LANGUAGE", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    hide_window(&mut command);
    let mut child = command
        .spawn()
        .map_err(|e| AppError::Tool(format!("Couldn't start {name}: {e}")))?;
    let (tx, mut rx) = mpsc::unbounded_channel();
    if let Some(out) = child.stdout.take() {
        tokio::spawn(pump(out, tx.clone()));
    }
    if let Some(err) = child.stderr.take() {
        tokio::spawn(pump(err, tx.clone()));
    }
    drop(tx);

    let mut done = Finished::default();
    let mut objects = 0u64;
    let mut pending: Option<String> = None;
    let mut last_emit = Instant::now() - PROGRESS_EVERY;
    loop {
        tokio::select! {
            line = rx.recv() => {
                let Some(line) = line else { break };
                if counts_as_object(kind, &line) {
                    objects += 1;
                }
                let line = clip(&line);
                let lower = line.to_lowercase();
                if lower.contains("errors ignored on restore") {
                    done.errors_ignored = true;
                } else if lower.contains("warning:") && done.warnings.len() < MAX_NOTES {
                    done.warnings.push(line.clone());
                }
                if (lower.contains(": error:") || line.starts_with("ERROR:"))
                    && done.errors.len() < MAX_NOTES
                {
                    done.errors.push(line.clone());
                }
                if done.tail.len() == TAIL_LINES {
                    done.tail.pop_front();
                }
                done.tail.push_back(line.clone());
                if last_emit.elapsed() >= PROGRESS_EVERY {
                    on_line(&line, objects);
                    last_emit = Instant::now();
                    pending = None;
                } else {
                    pending = Some(line);
                }
            }
            () = cancel.cancelled() => {
                let _ = child.kill().await;
                return Err(AppError::Cancelled);
            }
        }
    }
    if let Some(line) = pending {
        on_line(&line, objects);
    }
    done.code = child
        .wait()
        .await
        .map_err(|e| AppError::Tool(format!("Couldn't wait for {name}: {e}")))?
        .code();
    Ok(done)
}

// ---------------------------------------------------------------------------
// Backing up
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DumpSummary {
    pub path: String,
    pub bytes: u64,
    pub elapsed_ms: u64,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreSummary {
    pub format: BackupFormat,
    pub elapsed_ms: u64,
    pub warnings: Vec<String>,
    /// Statements that failed, when the restore went on past them.
    pub errors: Vec<String>,
}

/// `pg_dump` refuses a server newer than itself.
fn check_dump_version(tool: &PgTool, server_version: Option<&str>) -> AppResult<()> {
    let Some((server, major)) = server_version.and_then(|v| Some((v, major_of(v)?))) else {
        return Ok(());
    };
    if tool.major < major {
        return Err(AppError::Tool(format!(
            "The newest pg_dump found is {}, older than this server ({server}), and pg_dump \
             won't back up a newer server. Install the PostgreSQL {major} client tools.",
            tool.version
        )));
    }
    Ok(())
}

/// Removes what a dump that didn't finish left: a file always, a folder
/// only when the dump created it.
fn discard_partial(dest: &Path, existed: bool) {
    if dest.is_dir() {
        if !existed {
            let _ = std::fs::remove_dir_all(dest);
        }
    } else {
        let _ = std::fs::remove_file(dest);
    }
}

pub async fn run_dump(
    tool: &PgTool,
    conn: &PgConn,
    database: &str,
    options: &DumpOptions,
    dest: &Path,
    cancel: &CancelToken,
    on_line: impl FnMut(&str, u64),
) -> AppResult<DumpSummary> {
    let args = dump_args(options, dest)?;
    let env = conn.env(database, tool.major);
    let existed = dest.exists();
    let started = Instant::now();
    let outcome = run_tool(&tool.path, &args, &env, ToolKind::Dump, cancel, on_line).await;
    let done = match outcome {
        Ok(done) if done.success() => done,
        Ok(done) => {
            discard_partial(dest, existed);
            return Err(done.failure("pg_dump"));
        }
        Err(e) => {
            discard_partial(dest, existed);
            return Err(e);
        }
    };
    Ok(DumpSummary {
        path: dest.display().to_string(),
        bytes: size_of(dest),
        elapsed_ms: started.elapsed().as_millis() as u64,
        warnings: done.warnings,
    })
}

/// Runs the restore of `source` into `database`. A backup that holds
/// TimescaleDB is restored between the extension's pre- and post-restore
/// calls: they stop its background workers, so they can't interfere with
/// the restore of hypertables and continuous aggregates.
#[allow(clippy::too_many_arguments)]
pub async fn run_restore(
    tool: &PgTool,
    format: BackupFormat,
    session: &PgSession,
    database: &str,
    source: &Path,
    options: &RestoreOptions,
    cancel: &CancelToken,
    mut on_line: impl FnMut(&str, u64),
) -> AppResult<RestoreSummary> {
    let plain = format == BackupFormat::Plain;
    let (args, kind, name) = if plain {
        (psql_args(options, database, source), ToolKind::Psql, "psql")
    } else {
        (
            restore_args(format, options, database, source)?,
            ToolKind::Restore,
            "pg_restore",
        )
    };
    let mut notes = Vec::new();
    if plain {
        let mut ignored = Vec::new();
        for (set, label) in [
            (options.clean, "drop objects first"),
            (options.create, "create the database"),
            (options.content != Content::All, "schema only / data only"),
            (options.no_owner, "skip owners"),
            (options.no_privileges, "skip privileges"),
            (options.jobs.is_some_and(|j| j > 1), "parallel jobs"),
        ] {
            if set {
                ignored.push(label);
            }
        }
        if !ignored.is_empty() {
            notes.push(format!(
                "A SQL file runs as it is: ignored {}.",
                ignored.join(", ")
            ));
        }
    }
    let timescale = backup_has_timescale(tool, format, source).await?;
    if timescale && options.create {
        // pg_restore makes the database during the restore, too late for the
        // extension to be prepared in it.
        let line = "TimescaleDB: this backup holds the extension, but \"Create the database\" \
                    makes the database during the restore. Create the database first and \
                    restore into it, so hypertables and continuous aggregates restore fully.";
        on_line(line, 0);
        notes.push(line.to_string());
    }
    // The same connection runs the post-restore call: pre-restore sets its
    // settings on the connection it runs on.
    let mut guard = None;
    if timescale && !options.create {
        let client = session.client(database).await?;
        client
            .client
            .batch_execute("CREATE EXTENSION IF NOT EXISTS timescaledb")
            .await
            .map_err(|e| {
                AppError::Tool(format!(
                    "Couldn't create the TimescaleDB extension in {database}, so the restore \
                     didn't start: {e}. The server must load TimescaleDB at start \
                     (shared_preload_libraries)."
                ))
            })?;
        client
            .client
            .batch_execute("SELECT timescaledb_pre_restore()")
            .await
            .map_err(|e| {
                AppError::Tool(format!(
                    "Couldn't prepare {database} for the TimescaleDB restore, so the restore \
                     didn't start: {e}"
                ))
            })?;
        on_line(
            "TimescaleDB: ran timescaledb_pre_restore(); background jobs are paused.",
            0,
        );
        guard = Some(client);
    }
    let env = PgConn::from_target(&session.target).env(database, tool.major);
    let started = Instant::now();
    let outcome = run_tool(&tool.path, &args, &env, kind, cancel, &mut on_line).await;
    if let Some(client) = guard {
        // However the restore ended, the database must leave restore mode. A
        // failure here is reported only when the restore itself succeeded.
        match client
            .client
            .batch_execute("SELECT timescaledb_post_restore()")
            .await
        {
            Ok(()) => on_line(
                "TimescaleDB: ran timescaledb_post_restore(); background jobs are back on.",
                0,
            ),
            Err(e) if outcome.is_ok() => {
                return Err(AppError::Tool(format!(
                    "The restore finished, but TimescaleDB couldn't leave restore mode in \
                     {database}: {e}"
                )))
            }
            Err(_) => {
                log::warn!("TimescaleDB post-restore failed after a restore that also failed")
            }
        }
    }
    let done = outcome?;
    if !done.success() && !done.errors_ignored {
        return Err(done.failure(name));
    }
    notes.extend(done.warnings);
    Ok(RestoreSummary {
        format,
        elapsed_ms: started.elapsed().as_millis() as u64,
        warnings: notes,
        errors: done.errors,
    })
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress<'a> {
    execution_id: &'a str,
    line: &'a str,
    objects: u64,
}

/// Registers `execution_id` so `cancel_query` stops the tool.
fn track(state: &AppState, execution_id: &str) -> CancelToken {
    let token = CancelToken::default();
    state.running_tasks.lock().unwrap().insert(
        execution_id.to_string(),
        RunningTask {
            token: token.clone(),
            canceller: None,
        },
    );
    token
}

fn untrack(state: &AppState, execution_id: &str) {
    state.running_tasks.lock().unwrap().remove(execution_id);
}

fn missing_tool(name: &str) -> AppError {
    AppError::Tool(format!(
        "{name} wasn't found. Install the PostgreSQL client tools and try again."
    ))
}

/// Every copy of `pg_dump`, `pg_restore` and `psql` on this machine.
#[tauri::command]
pub async fn pg_tools_info() -> PgToolsInfo {
    let info = find_tools().await;
    log::info!(
        "client tools: pg_dump {}, pg_restore {}, psql {}",
        info.pg_dump.len(),
        info.pg_restore.len(),
        info.psql.len()
    );
    info
}

/// What kind of backup a file or folder is.
#[tauri::command]
pub async fn backup_format(path: String) -> AppResult<BackupFormat> {
    detect_format(Path::new(&path))
}

#[tauri::command]
pub async fn dump_database<R: Runtime>(
    state: State<'_, AppState>,
    app: AppHandle<R>,
    session_id: String,
    database: String,
    options: DumpOptions,
    dest_path: String,
    execution_id: String,
) -> AppResult<DumpSummary> {
    let session = state
        .sessions
        .read()
        .await
        .get(&session_id)
        .cloned()
        .ok_or_else(|| AppError::SessionNotFound(session_id.clone()))?;
    let tools = find_tools().await;
    let tool = tools
        .pg_dump
        .first()
        .ok_or_else(|| missing_tool("pg_dump"))?;
    check_dump_version(tool, session.server_version.as_deref())?;
    let conn = PgConn::from_target(&session.target);

    let token = track(&state, &execution_id);
    let events = app.clone();
    let id = execution_id.clone();
    let started = Instant::now();
    let result = run_dump(
        tool,
        &conn,
        &database,
        &options,
        Path::new(&dest_path),
        &token,
        move |line, objects| {
            let _ = events.emit(
                DUMP_EVENT,
                Progress {
                    execution_id: &id,
                    line,
                    objects,
                },
            );
        },
    )
    .await;
    untrack(&state, &execution_id);

    let op = Op::new("pg_dump", &database, None);
    let name = &session.name;
    let ms = started.elapsed().as_millis();
    let mut summary = match result {
        Ok(summary) => {
            log::info!("{op} [{name}] wrote {} bytes in {ms} ms", summary.bytes);
            summary
        }
        // What the tool printed can quote data, so only the fact is logged.
        Err(e) => {
            log::warn!("{op} [{name}] failed after {ms} ms (details not logged)");
            return Err(e);
        }
    };
    if session.target.settings.pooler_mode {
        summary.warnings.insert(
            0,
            "This connection is in pooler (transaction) mode. pg_dump needs a session-mode \
             connection, so the backup may be inconsistent or fail."
                .to_string(),
        );
    }
    Ok(summary)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn restore_database<R: Runtime>(
    state: State<'_, AppState>,
    app: AppHandle<R>,
    session_id: String,
    database: String,
    source_path: String,
    options: RestoreOptions,
    execution_id: String,
) -> AppResult<RestoreSummary> {
    let session = state
        .sessions
        .read()
        .await
        .get(&session_id)
        .cloned()
        .ok_or_else(|| AppError::SessionNotFound(session_id.clone()))?;
    if session.target.settings.read_only {
        return Err(AppError::Tool(
            "This connection is read-only, so nothing can be restored through it. Edit the \
             connection and turn read-only off to restore a backup."
                .to_string(),
        ));
    }
    let source = Path::new(&source_path);
    let format = detect_format(source)?;
    let tools = find_tools().await;
    let found = if format == BackupFormat::Plain {
        ("psql", tools.psql.first())
    } else {
        ("pg_restore", tools.pg_restore.first())
    };
    let tool = found.1.ok_or_else(|| missing_tool(found.0))?;

    let token = track(&state, &execution_id);
    let events = app.clone();
    let id = execution_id.clone();
    let started = Instant::now();
    let result = run_restore(
        tool,
        format,
        &session,
        &database,
        source,
        &options,
        &token,
        move |line, objects| {
            let _ = events.emit(
                RESTORE_EVENT,
                Progress {
                    execution_id: &id,
                    line,
                    objects,
                },
            );
        },
    )
    .await;
    untrack(&state, &execution_id);

    let op = Op::new("restore", &database, None);
    let name = &session.name;
    let ms = started.elapsed().as_millis();
    match &result {
        Ok(summary) => log::info!(
            "{op} [{name}] finished in {ms} ms; {} statements failed",
            summary.errors.len()
        ),
        Err(_) => log::warn!("{op} [{name}] failed after {ms} ms (details not logged)"),
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dump_options(format: BackupFormat) -> DumpOptions {
        DumpOptions {
            format,
            content: Content::All,
            schemas: vec![],
            tables: vec![],
            exclude_data: vec![],
            no_owner: false,
            no_privileges: false,
            clean: false,
            compression: None,
            jobs: None,
        }
    }

    fn has(args: &[String], arg: &str) -> bool {
        args.iter().any(|a| a == arg)
    }

    #[test]
    fn parses_tool_versions() {
        assert_eq!(
            parse_version("pg_dump (PostgreSQL) 17.6\n"),
            Some(("17.6".to_string(), 17))
        );
        assert_eq!(
            parse_version("pg_dump (PostgreSQL) 16.4 (Ubuntu 16.4-1.pgdg22.04+1)\n"),
            Some(("16.4".to_string(), 16))
        );
        assert_eq!(
            parse_version("psql (PostgreSQL) 18beta1"),
            Some(("18beta1".to_string(), 18))
        );
        assert_eq!(
            parse_version("pg_restore (PostgreSQL) 9.6.24"),
            Some(("9.6.24".to_string(), 9))
        );
        assert_eq!(parse_version("sh: pg_dump: not found"), None);
        assert_eq!(major_of("17.11"), Some(17));
        assert_eq!(major_of("17.2 (Debian 17.2-1.pgdg120+1)"), Some(17));
    }

    #[test]
    fn wildcards_match_version_folders() {
        assert!(wild_match("*", "16"));
        assert!(wild_match("postgresql@*", "postgresql@17"));
        assert!(!wild_match("postgresql@*", "postgresql"));
        assert!(wild_match("pgsql-*", "pgsql-17"));
        assert!(!wild_match("16", "17"));
        assert!(wild_match("a*b*c", "aXXbYYc"));
    }

    #[test]
    fn expands_a_pattern_over_folders() {
        let root = std::env::temp_dir().join(format!("ps-dump-expand-{}", std::process::id()));
        for v in ["15", "17"] {
            std::fs::create_dir_all(root.join(v).join("bin")).unwrap();
        }
        let mut found = expand(&format!("{}/*/bin", root.display()));
        found.sort();
        assert_eq!(found, vec![root.join("15/bin"), root.join("17/bin")]);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_custom_dump_has_no_jobs_and_no_clean() {
        let mut options = dump_options(BackupFormat::Custom);
        options.jobs = Some(4);
        options.clean = true;
        let args = dump_args(&options, Path::new("/tmp/shop.dump")).unwrap();
        assert!(has(&args, "--format=c"));
        assert!(has(&args, "--file=/tmp/shop.dump"));
        assert!(has(&args, "--verbose"));
        assert!(!args.iter().any(|a| a.starts_with("--jobs")));
        assert!(!has(&args, "--clean"));
    }

    #[test]
    fn jobs_apply_to_the_directory_format_only() {
        let mut options = dump_options(BackupFormat::Directory);
        options.jobs = Some(4);
        let args = dump_args(&options, Path::new("/tmp/d")).unwrap();
        assert!(has(&args, "--format=d"));
        assert!(has(&args, "--jobs=4"));
        options.jobs = Some(1);
        let args = dump_args(&options, Path::new("/tmp/d")).unwrap();
        assert!(!args.iter().any(|a| a.starts_with("--jobs")));
        options.format = BackupFormat::Tar;
        options.jobs = Some(4);
        options.compression = Some(5);
        let args = dump_args(&options, Path::new("/tmp/d.tar")).unwrap();
        assert!(has(&args, "--format=t"));
        assert!(!args.iter().any(|a| a.starts_with("--jobs")));
        assert!(!args.iter().any(|a| a.starts_with("--compress")));
    }

    #[test]
    fn a_plain_dump_cleans_and_is_never_compressed() {
        let mut options = dump_options(BackupFormat::Plain);
        options.clean = true;
        options.compression = Some(9);
        options.no_owner = true;
        options.no_privileges = true;
        options.content = Content::SchemaOnly;
        let args = dump_args(&options, Path::new("/tmp/shop.sql")).unwrap();
        for flag in [
            "--format=p",
            "--clean",
            "--if-exists",
            "--no-owner",
            "--no-privileges",
            "--schema-only",
        ] {
            assert!(has(&args, flag), "{flag} missing from {args:?}");
        }
        assert!(!args.iter().any(|a| a.starts_with("--compress")));
    }

    #[test]
    fn scope_is_quoted_as_pg_dump_patterns() {
        let mut options = dump_options(BackupFormat::Custom);
        options.schemas = vec!["public".into(), "Odd \"one\"".into()];
        options.tables = vec![TableRef {
            schema: "sales".into(),
            name: "Order Items".into(),
        }];
        options.exclude_data = vec![TableRef {
            schema: "public".into(),
            name: "audit_log".into(),
        }];
        options.compression = Some(6);
        let args = dump_args(&options, Path::new("-weird")).unwrap();
        assert!(has(&args, "--schema=\"public\""));
        assert!(has(&args, "--schema=\"Odd \"\"one\"\"\""));
        assert!(has(&args, "--table=\"sales\".\"Order Items\""));
        assert!(has(&args, "--exclude-table-data=\"public\".\"audit_log\""));
        assert!(has(&args, "--compress=6"));
        // a name starting with a dash can't be read as an option
        assert!(has(&args, "--file=-weird"));
    }

    #[test]
    fn bad_dump_options_are_refused() {
        let mut options = dump_options(BackupFormat::Custom);
        options.compression = Some(12);
        assert!(dump_args(&options, Path::new("x")).is_err());
        options.compression = None;
        options.jobs = Some(0);
        assert!(dump_args(&options, Path::new("x")).is_err());
    }

    #[test]
    fn restore_single_transaction_excludes_jobs() {
        let mut options = RestoreOptions {
            single_transaction: true,
            jobs: Some(4),
            ..Default::default()
        };
        let args = restore_args(
            BackupFormat::Custom,
            &options,
            "shop",
            Path::new("/tmp/a.dump"),
        )
        .unwrap();
        assert!(has(&args, "--single-transaction"));
        assert!(!args.iter().any(|a| a.starts_with("--jobs")));

        options.single_transaction = false;
        let args = restore_args(
            BackupFormat::Directory,
            &options,
            "shop",
            Path::new("/tmp/d"),
        )
        .unwrap();
        assert!(has(&args, "--jobs=4"));
        let args =
            restore_args(BackupFormat::Tar, &options, "shop", Path::new("/tmp/a.tar")).unwrap();
        assert!(!args.iter().any(|a| a.starts_with("--jobs")));
        // the file comes last, after `--`
        assert_eq!(&args[args.len() - 2..], ["--", "/tmp/a.tar"]);
    }

    #[test]
    fn restore_options_map_to_flags() {
        let options = RestoreOptions {
            clean: true,
            create: true,
            content: Content::DataOnly,
            no_owner: true,
            no_privileges: true,
            exit_on_error: true,
            ..Default::default()
        };
        // clean and data-only contradict each other
        assert!(restore_args(BackupFormat::Custom, &options, "d", Path::new("f")).is_err());
        let options = RestoreOptions {
            content: Content::SchemaOnly,
            clean: true,
            ..options
        };
        let args = restore_args(BackupFormat::Custom, &options, "d", Path::new("f")).unwrap();
        for flag in [
            "--clean",
            "--if-exists",
            "--create",
            "--schema-only",
            "--no-owner",
            "--no-privileges",
            "--exit-on-error",
        ] {
            assert!(has(&args, flag), "{flag} missing from {args:?}");
        }
        let both = RestoreOptions {
            create: true,
            single_transaction: true,
            ..Default::default()
        };
        assert!(restore_args(BackupFormat::Custom, &both, "d", Path::new("f")).is_err());
    }

    #[test]
    fn the_database_name_is_quoted_as_a_connection_string() {
        let args = restore_args(
            BackupFormat::Custom,
            &RestoreOptions::default(),
            "it's=odd",
            Path::new("f"),
        )
        .unwrap();
        assert!(has(&args, "--dbname=dbname='it\\'s=odd'"));
        let args = psql_args(&RestoreOptions::default(), "shop", Path::new("/tmp/a.sql"));
        assert!(has(&args, "--set=ON_ERROR_STOP=1"));
        assert!(has(&args, "--file=/tmp/a.sql"));
        assert!(has(&args, "--dbname=dbname='shop'"));
    }

    fn profile(uri: &str, ssl_mode: SslMode) -> crate::models::ConnectionProfile {
        crate::models::ConnectionProfile {
            id: "id".into(),
            name: "prod".into(),
            color: None,
            source: crate::models::ConnectionSource::Uri { uri: uri.into() },
            database: None,
            username: None,
            has_password: false,
            tls: crate::models::TlsOptions {
                ssl_mode,
                ..Default::default()
            },
            ssh_tunnel: None,
            advanced: Default::default(),
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    fn conn_of(uri: &str, tunnel_port: Option<u16>) -> PgConn {
        let target = Target::from_profile(
            &profile(uri, SslMode::VerifyFull),
            &crate::secrets::InMemoryStore::new(),
            tunnel_port,
        )
        .unwrap();
        PgConn::from_target(&target)
    }

    #[test]
    fn a_tunnel_is_reached_at_its_local_port() {
        let direct = conn_of("postgres://app:s3cret@db.internal:5432/shop", None);
        assert_eq!(direct.host.as_deref(), Some("db.internal"));
        assert_eq!(direct.port.as_deref(), Some("5432"));
        assert_eq!(direct.hostaddr, None);
        assert_eq!(direct.user.as_deref(), Some("app"));
        assert_eq!(direct.password.as_deref(), Some("s3cret"));

        // through the tunnel: the real name (for the certificate check),
        // the tunnel's local end for the bytes
        let conn = conn_of("postgres://app:s3cret@db.internal:5432/shop", Some(50123));
        assert_eq!(conn.host.as_deref(), Some("db.internal"));
        assert_eq!(conn.hostaddr.as_deref(), Some("127.0.0.1"));
        assert_eq!(conn.port.as_deref(), Some("50123"));

        let env = conn.env("shop", 17);
        let get = |k: &str| {
            env.iter()
                .find(|(key, _)| *key == k)
                .map(|(_, v)| v.as_str())
        };
        assert_eq!(get("PGHOST"), Some("db.internal"));
        assert_eq!(get("PGHOSTADDR"), Some("127.0.0.1"));
        assert_eq!(get("PGPORT"), Some("50123"));
        assert_eq!(get("PGDATABASE"), Some("shop"));
        assert_eq!(get("PGPASSWORD"), Some("s3cret"));
        assert_eq!(get("PGSSLMODE"), Some("verify-full"));
        // no CA named: libpq 16+ is told to use the system's
        assert_eq!(get("PGSSLROOTCERT"), Some("system"));
        let old = conn.env("shop", 15);
        assert!(!old.iter().any(|(k, _)| *k == "PGSSLROOTCERT"));
    }

    #[test]
    fn the_password_never_reaches_the_arguments() {
        let secret = "s3cret-p@ss";
        let dump = dump_args(&dump_options(BackupFormat::Custom), Path::new("/tmp/a")).unwrap();
        let restore = restore_args(
            BackupFormat::Custom,
            &RestoreOptions::default(),
            "shop",
            Path::new("/tmp/a"),
        )
        .unwrap();
        let psql = psql_args(&RestoreOptions::default(), "shop", Path::new("/tmp/a.sql"));
        for args in [dump, restore, psql] {
            assert!(!args
                .iter()
                .any(|a| a.contains(secret) || a.contains("PGPASSWORD")));
        }
        let conn = PgConn {
            password: Some(secret.into()),
            user: Some("app".into()),
            ..Default::default()
        };
        let env = conn.env("shop", 17);
        assert!(env.contains(&("PGPASSWORD", secret.to_string())));
        assert!(env.contains(&("PGUSER", "app".to_string())));
    }

    #[test]
    fn detects_the_backup_format() {
        let dir = std::env::temp_dir().join(format!("ps-dump-detect-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("folder")).unwrap();
        let write = |name: &str, bytes: &[u8]| {
            let p = dir.join(name);
            std::fs::write(&p, bytes).unwrap();
            p
        };
        assert_eq!(
            detect_format(&write("a.dump", b"PGDMP\x01\x0e\x00")).unwrap(),
            BackupFormat::Custom
        );
        let mut tar = vec![0u8; 512];
        tar[..7].copy_from_slice(b"toc.dat");
        tar[257..262].copy_from_slice(b"ustar");
        assert_eq!(
            detect_format(&write("a.tar", &tar)).unwrap(),
            BackupFormat::Tar
        );
        assert_eq!(
            detect_format(&write("a.sql", b"--\n-- PostgreSQL database dump\n")).unwrap(),
            BackupFormat::Plain
        );
        assert_eq!(
            detect_format(&write("empty.sql", b"")).unwrap(),
            BackupFormat::Plain
        );
        assert!(detect_format(&write("a.sql.gz", &[0x1f, 0x8b, 8, 0])).is_err());
        // a folder needs its table of contents
        assert!(detect_format(&dir.join("folder")).is_err());
        write("folder/toc.dat", b"PGDMP");
        assert_eq!(
            detect_format(&dir.join("folder")).unwrap(),
            BackupFormat::Directory
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn an_old_pg_dump_is_refused_for_a_newer_server() {
        let tool = |major: u32| PgTool {
            path: "pg_dump".into(),
            version: format!("{major}.1"),
            major,
        };
        assert!(check_dump_version(&tool(16), Some("17.11")).is_err());
        assert!(check_dump_version(&tool(17), Some("17.11")).is_ok());
        assert!(check_dump_version(&tool(18), Some("16.4 (Debian)")).is_ok());
        assert!(check_dump_version(&tool(9), None).is_ok());
    }

    #[test]
    fn lines_are_clipped_and_counted() {
        assert_eq!(clip("short"), "short");
        assert_eq!(clip(&"x".repeat(1000)).len(), MAX_LINE + 3);
        assert!(counts_as_object(
            ToolKind::Dump,
            "pg_dump: dumping contents of table \"public.orders\""
        ));
        assert!(!counts_as_object(
            ToolKind::Dump,
            "pg_dump: reading schemas"
        ));
        assert!(counts_as_object(
            ToolKind::Restore,
            "pg_restore: creating TABLE \"public.orders\""
        ));
        assert!(counts_as_object(ToolKind::Psql, "CREATE TABLE"));
    }

    #[test]
    fn the_toc_names_the_timescale_extension_whole() {
        assert!(toc_line_is_timescale(
            "3212; 0 16386 EXTENSION - timescaledb "
        ));
        assert!(toc_line_is_timescale(
            "3212; 0 16386 EXTENSION - timescaledb"
        ));
        assert!(!toc_line_is_timescale(
            "3213; 0 16390 EXTENSION - timescaledb_toolkit"
        ));
        assert!(!toc_line_is_timescale("3214; 0 16391 EXTENSION - pgcrypto"));
        assert!(!toc_line_is_timescale(
            "3215; 0 0 COMMENT - EXTENSION timescaledb"
        ));
        assert!(!toc_line_is_timescale(
            "3216; 0 16392 TABLE public.timescaledb_notes"
        ));
    }

    #[test]
    fn the_sql_names_the_timescale_extension_whole() {
        assert!(sql_line_creates_timescale(
            "CREATE EXTENSION IF NOT EXISTS timescaledb WITH SCHEMA public;"
        ));
        assert!(sql_line_creates_timescale("CREATE EXTENSION timescaledb;"));
        assert!(sql_line_creates_timescale(
            "  create extension if not exists timescaledb;"
        ));
        assert!(!sql_line_creates_timescale(
            "CREATE EXTENSION IF NOT EXISTS timescaledb_toolkit WITH SCHEMA public;"
        ));
        assert!(!sql_line_creates_timescale(
            "CREATE EXTENSION IF NOT EXISTS pgcrypto;"
        ));
        assert!(!sql_line_creates_timescale(
            "-- CREATE EXTENSION timescaledb;"
        ));
        assert!(!sql_line_creates_timescale(
            "COMMENT ON EXTENSION timescaledb IS 'time-series';"
        ));
    }

    #[tokio::test]
    async fn a_plain_backup_is_checked_for_the_extension() {
        let dir = std::env::temp_dir().join(format!("ps-ts-sql-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let with = dir.join("with.sql");
        std::fs::write(
            &with,
            "--\n-- PostgreSQL database dump\n--\nCREATE EXTENSION IF NOT EXISTS timescaledb WITH SCHEMA public;\nCOPY public.t (a) FROM stdin;\n1\n\\.\n",
        )
        .unwrap();
        let without = dir.join("without.sql");
        std::fs::write(
            &without,
            "CREATE TABLE t (a int);\nCOPY t (a) FROM stdin;\n1\n\\.\n",
        )
        .unwrap();
        assert!(sql_has_timescale(&with).await.unwrap());
        assert!(!sql_has_timescale(&without).await.unwrap());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn timescale_warnings_are_neither_objects_nor_errors() {
        // pg_dump's note about circular foreign keys between a hypertable and
        // its chunks, with the lines that follow it.
        let script = "echo 'pg_dump: warning: there are circular foreign-key constraints on this table: hypertable' >&2; \
                      echo 'pg_dump: detail: Hypertables cannot be dumped in parallel.' >&2; \
                      echo 'pg_dump: hint: You might not be able to restore the dump without using --disable-triggers or temporarily dropping the constraints.' >&2; \
                      exit 0";
        let cancel = CancelToken::default();
        let mut last_objects = u64::MAX;
        let done = run_tool(
            "sh",
            &["-c".to_string(), script.to_string()],
            &[],
            ToolKind::Dump,
            &cancel,
            |_, n| last_objects = n,
        )
        .await
        .unwrap();
        assert!(done.success());
        assert_eq!(done.warnings.len(), 1);
        assert!(done.errors.is_empty());
        assert_eq!(last_objects, 0);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_tool_that_fails_reports_its_last_lines() {
        let cancel = CancelToken::default();
        let args = vec![
            "-c".to_string(),
            "echo 'pg_dump: error: boom' >&2; exit 1".to_string(),
        ];
        let mut seen = Vec::new();
        let done = run_tool("sh", &args, &[], ToolKind::Dump, &cancel, |l, _| {
            seen.push(l.to_string())
        })
        .await
        .unwrap();
        assert!(!done.success());
        assert_eq!(seen, ["pg_dump: error: boom"]);
        assert!(done.failure("pg_dump").to_string().contains("boom"));
        assert_eq!(done.errors.len(), 1);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cancelling_kills_the_tool() {
        let cancel = CancelToken::default();
        let stopper = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            stopper.cancel();
        });
        let started = Instant::now();
        let result = run_tool(
            "sh",
            &["-c".to_string(), "sleep 30".to_string()],
            &[],
            ToolKind::Dump,
            &cancel,
            |_, _| {},
        )
        .await;
        assert!(matches!(result, Err(AppError::Cancelled)));
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_environment_reaches_the_tool_but_not_the_arguments() {
        let cancel = CancelToken::default();
        let env = [("PGPASSWORD", "s3cret".to_string())];
        let args = vec!["-c".to_string(), "echo \"pw=$PGPASSWORD\"".to_string()];
        let mut out = String::new();
        run_tool("sh", &args, &env, ToolKind::Dump, &cancel, |l, _| {
            out = l.to_string()
        })
        .await
        .unwrap();
        assert_eq!(out, "pw=s3cret");
    }
}

#[cfg(test)]
mod live_tests {
    //! Against the dev server (docker-compose.dev.yml). Run with:
    //!   POSTGRES_STUDIO_TEST_URI=postgres://postgres:postgres@localhost:5433/shop \
    //!     cargo test --lib -- --ignored dump::live_tests
    //! Needs pg_dump, pg_restore and psql no older than the server; when they
    //! aren't, the test says so and passes. `POSTGRES_STUDIO_PG_BIN` names a
    //! folder with newer ones.
    use super::*;
    use crate::models::{
        ConnectionAdvancedOptions, ConnectionProfile, ConnectionSource, SslMode, TlsOptions,
    };
    use crate::pg::PgSession;
    use crate::secrets::InMemoryStore;
    use std::sync::Arc;

    const SCRATCH: &str = "agent_dump_restore";

    async fn session() -> PgSession {
        session_from("POSTGRES_STUDIO_TEST_URI").await
    }

    /// The server whose URI is in the variable `var`.
    async fn session_from(var: &str) -> PgSession {
        let uri = std::env::var(var).unwrap_or_else(|_| panic!("set {var}"));
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

    async fn scalar(session: &PgSession, database: &str, sql: &str) -> Option<String> {
        let client = session.target.open(database).await.unwrap();
        let rows = client.client.simple_query(sql).await.unwrap();
        rows.iter().find_map(|m| match m {
            tokio_postgres::SimpleQueryMessage::Row(r) => r.get(0).map(str::to_string),
            _ => None,
        })
    }

    async fn recreate_scratch(session: &PgSession) {
        let admin = session.target.open("postgres").await.unwrap();
        for sql in [
            format!("DROP DATABASE IF EXISTS {SCRATCH} WITH (FORCE)"),
            format!("CREATE DATABASE {SCRATCH}"),
        ] {
            admin.client.batch_execute(&sql).await.unwrap();
        }
    }

    #[tokio::test]
    #[ignore = "needs POSTGRES_STUDIO_TEST_URI"]
    async fn dumps_and_restores_a_database() {
        let session = session().await;
        let tools = find_tools().await;
        let (Some(dump), Some(restore), Some(psql)) = (
            tools.pg_dump.first(),
            tools.pg_restore.first(),
            tools.psql.first(),
        ) else {
            eprintln!("skipped: pg_dump, pg_restore and psql weren't all found");
            return;
        };
        if let Err(e) = check_dump_version(dump, session.server_version.as_deref()) {
            eprintln!("skipped: {e}");
            return;
        }
        let conn = PgConn::from_target(&session.target);
        // Not the default `shop`: the other live tests create and drop
        // tables there while they run, which a parallel dump trips over.
        let database = "analytics".to_string();
        let table = scalar(
            &session,
            &database,
            "SELECT quote_ident(table_schema) || '.' || quote_ident(table_name) \
             FROM information_schema.tables \
             WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1 LIMIT 1",
        )
        .await
        .expect("the dev database has a table in public");
        let count_sql = format!("SELECT count(*) FROM {table}");
        let expected = scalar(&session, &database, &count_sql).await.unwrap();

        let dir = std::env::temp_dir().join(format!("ps-dump-live-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let cancel = CancelToken::default();
        let mut lines = 0;
        let mut objects = 0;

        for format in [
            BackupFormat::Custom,
            BackupFormat::Directory,
            BackupFormat::Tar,
            BackupFormat::Plain,
        ] {
            let dest = dir.join(format!("{format:?}"));
            let mut options = dump_options_for(format);
            if format == BackupFormat::Directory {
                options.jobs = Some(2);
            }
            let summary = run_dump(dump, &conn, &database, &options, &dest, &cancel, |_, n| {
                lines += 1;
                objects = n;
            })
            .await
            .unwrap_or_else(|e| panic!("{format:?} dump failed: {e}"));
            assert!(summary.bytes > 0, "{format:?} dump is empty");
            assert_eq!(detect_format(&dest).unwrap(), format);

            recreate_scratch(&session).await;
            let tool = if format == BackupFormat::Plain {
                psql
            } else {
                restore
            };
            let options = RestoreOptions {
                no_owner: true,
                ..Default::default()
            };
            run_restore(
                tool,
                format,
                &session,
                SCRATCH,
                &dest,
                &options,
                &cancel,
                |_, _| {},
            )
            .await
            .unwrap_or_else(|e| panic!("{format:?} restore failed: {e}"));
            let restored = scalar(&session, SCRATCH, &count_sql).await.unwrap();
            assert_eq!(restored, expected, "{format:?}: rows of {table}");
        }
        assert!(lines > 0, "no progress lines came through");
        assert!(objects > 0, "no objects were counted");

        let admin = session.target.open("postgres").await.unwrap();
        admin
            .client
            .batch_execute(&format!("DROP DATABASE IF EXISTS {SCRATCH} WITH (FORCE)"))
            .await
            .unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// The TimescaleDB server's `tsdb`, backed up and restored into a database
    /// of its own, as the app does it. Needs pg_dump and pg_restore no older
    /// than the server.
    #[tokio::test]
    #[ignore = "needs POSTGRES_STUDIO_TIMESCALE_URI"]
    async fn restores_a_timescale_backup() {
        let session = session_from("POSTGRES_STUDIO_TIMESCALE_URI").await;
        let tools = find_tools().await;
        let (Some(dump), Some(restore)) = (tools.pg_dump.first(), tools.pg_restore.first()) else {
            eprintln!("skipped: pg_dump and pg_restore weren't both found");
            return;
        };
        for tool in [dump, restore] {
            if let Err(e) = check_dump_version(tool, session.server_version.as_deref()) {
                eprintln!("skipped: {e}");
                return;
            }
        }

        let source = "tsdb";
        let target = "ts_restore_test";
        // What the restore has to bring back, as one value.
        let counts = "SELECT concat_ws(',',
            (SELECT count(*) FROM timescaledb_information.hypertables),
            (SELECT count(*) FROM timescaledb_information.continuous_aggregates),
            (SELECT count(*) FROM timescaledb_information.chunks))";
        let expected = scalar(&session, source, counts).await.unwrap();
        assert!(
            !expected.starts_with("0,"),
            "{source} has no hypertables: {expected}"
        );

        let dir = std::env::temp_dir().join(format!("ps-ts-live-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let dest = dir.join("tsdb.dump");
        let cancel = CancelToken::default();
        let conn = PgConn::from_target(&session.target);
        run_dump(
            dump,
            &conn,
            source,
            &dump_options_for(BackupFormat::Custom),
            &dest,
            &cancel,
            |_, _| {},
        )
        .await
        .unwrap_or_else(|e| panic!("dump failed: {e}"));

        let admin = session.target.open("postgres").await.unwrap();
        for sql in [
            format!("DROP DATABASE IF EXISTS {target} WITH (FORCE)"),
            format!("CREATE DATABASE {target}"),
        ] {
            admin.client.batch_execute(&sql).await.unwrap();
        }

        let mut lines = Vec::new();
        let options = RestoreOptions {
            no_owner: true,
            ..Default::default()
        };
        let summary = run_restore(
            restore,
            BackupFormat::Custom,
            &session,
            target,
            &dest,
            &options,
            &cancel,
            |line, _| lines.push(line.to_string()),
        )
        .await
        .unwrap_or_else(|e| panic!("restore failed: {e}"));
        assert!(
            summary.errors.is_empty(),
            "statements failed: {:?}",
            summary.errors
        );
        for step in ["timescaledb_pre_restore", "timescaledb_post_restore"] {
            assert!(
                lines.iter().any(|l| l.contains(step)),
                "no {step} line in {lines:?}"
            );
        }

        let restored = scalar(&session, target, counts).await.unwrap();
        assert_eq!(restored, expected, "hypertables, caggs and chunks");
        // a new connection: the restoring setting is per database, and
        // post-restore must have cleared it
        let flag = scalar(
            &session,
            target,
            "SELECT coalesce(current_setting('timescaledb.restoring', true), 'off')",
        )
        .await
        .unwrap();
        assert_ne!(flag, "on", "timescaledb.restoring is still on");
        let left = scalar(
            &session,
            target,
            "SELECT count(*) FROM pg_db_role_setting s
             JOIN pg_database d ON d.oid = s.setdatabase
             WHERE d.datname = current_database() AND s.setconfig::text LIKE '%timescaledb.restoring%'",
        )
        .await
        .unwrap();
        assert_eq!(left, "0", "a restoring setting is left on the database");

        admin
            .client
            .batch_execute(&format!("DROP DATABASE IF EXISTS {target} WITH (FORCE)"))
            .await
            .unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
    }

    fn dump_options_for(format: BackupFormat) -> DumpOptions {
        DumpOptions {
            format,
            content: Content::All,
            schemas: vec![],
            tables: vec![],
            exclude_data: vec![],
            no_owner: true,
            no_privileges: false,
            clean: false,
            compression: None,
            jobs: None,
        }
    }
}
