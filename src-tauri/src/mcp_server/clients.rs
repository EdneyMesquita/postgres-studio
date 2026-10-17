//! Adding the server to the AI clients on this machine with one click.
//!
//! Claude Code is set up through its own CLI when it's found (it rewrites
//! `~/.claude.json` itself, so editing that file while it runs could be
//! undone), and through `~/.claude.json` otherwise. The others read a config
//! file that is merged in place: only this server's entry is touched, a
//! `.bak` copy is written first, and missing folders are created.
//!
//! The entry carries the URL and the bearer token. "Registered" means the
//! entry exists with this server's current URL.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Map, Value};
use tokio::process::Command;
use toml_edit::{DocumentMut, Item, Table};

use super::{ClientTarget, Inner, SERVER_NAME};
use crate::assistant::{detect, AgentKind};
use crate::error::{AppError, AppResult};

const CLI_TIMEOUT: Duration = Duration::from_secs(30);

/// Where the clients keep their configs. Injectable so tests use a temp
/// folder.
pub(crate) struct Paths {
    home: Option<PathBuf>,
    codex_home: Option<PathBuf>,
    vscode_user: Option<PathBuf>,
    /// Look for the `claude` CLI; off in tests, which use the file.
    detect_claude: bool,
}

impl Paths {
    pub fn from_env() -> Self {
        let home = detect::home_dir();
        let codex_home = std::env::var_os("CODEX_HOME")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .or_else(|| home.as_ref().map(|h| h.join(".codex")));
        Self {
            vscode_user: vscode_user_dir(home.as_deref()),
            home,
            codex_home,
            detect_claude: true,
        }
    }

    #[cfg(test)]
    pub fn for_tests(home: &Path) -> Self {
        Self {
            home: Some(home.to_path_buf()),
            codex_home: Some(home.join(".codex")),
            vscode_user: Some(home.join(".config").join("Code").join("User")),
            detect_claude: false,
        }
    }

    async fn claude_bin(&self) -> Option<PathBuf> {
        if self.detect_claude {
            detect::find_binary(AgentKind::Claude).await
        } else {
            None
        }
    }
}

/// VS Code's user settings folder.
fn vscode_user_dir(home: Option<&Path>) -> Option<PathBuf> {
    if cfg!(target_os = "windows") {
        std::env::var_os("APPDATA").map(|a| PathBuf::from(a).join("Code").join("User"))
    } else if cfg!(target_os = "macos") {
        home.map(|h| h.join("Library/Application Support/Code/User"))
    } else {
        let config = std::env::var_os("XDG_CONFIG_HOME")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .or_else(|| home.map(|h| h.join(".config")))?;
        Some(config.join("Code").join("User"))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Claude,
    Cursor,
    Codex,
    VsCode,
    Windsurf,
}

impl Kind {
    const ALL: [Kind; 5] = [
        Kind::Claude,
        Kind::Cursor,
        Kind::Codex,
        Kind::VsCode,
        Kind::Windsurf,
    ];

    fn from_id(id: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|k| k.id() == id)
    }

    fn id(self) -> &'static str {
        match self {
            Kind::Claude => "claude",
            Kind::Cursor => "cursor",
            Kind::Codex => "codex",
            Kind::VsCode => "vscode",
            Kind::Windsurf => "windsurf",
        }
    }

    fn name(self) -> &'static str {
        match self {
            Kind::Claude => "Claude Code",
            Kind::Cursor => "Cursor",
            Kind::Codex => "Codex",
            Kind::VsCode => "VS Code",
            Kind::Windsurf => "Windsurf",
        }
    }

    fn config_path(self, paths: &Paths) -> Option<PathBuf> {
        let home = paths.home.as_ref();
        match self {
            Kind::Claude => home.map(|h| h.join(".claude.json")),
            Kind::Cursor => home.map(|h| h.join(".cursor").join("mcp.json")),
            Kind::Codex => paths.codex_home.as_ref().map(|c| c.join("config.toml")),
            Kind::VsCode => paths.vscode_user.as_ref().map(|v| v.join("mcp.json")),
            Kind::Windsurf => {
                home.map(|h| h.join(".codeium").join("windsurf").join("mcp_config.json"))
            }
        }
    }

    /// The folder whose presence means the client is installed (Claude
    /// Code: its CLI, or its config file).
    fn install_dir(self, paths: &Paths) -> Option<PathBuf> {
        match self {
            Kind::Claude => None,
            Kind::Cursor => paths.home.as_ref().map(|h| h.join(".cursor")),
            Kind::Codex => paths.codex_home.clone(),
            Kind::VsCode => paths.vscode_user.clone(),
            Kind::Windsurf => paths
                .home
                .as_ref()
                .map(|h| h.join(".codeium").join("windsurf")),
        }
    }

    /// The JSON object holding the servers, and the key of the URL.
    fn json_layout(self) -> (&'static str, &'static str) {
        match self {
            Kind::VsCode => ("servers", "url"),
            Kind::Windsurf => ("mcpServers", "serverUrl"),
            _ => ("mcpServers", "url"),
        }
    }
}

fn installed(kind: Kind, paths: &Paths, claude_bin: Option<&Path>) -> bool {
    match kind {
        Kind::Claude => {
            claude_bin.is_some() || kind.config_path(paths).is_some_and(|p| p.is_file())
        }
        _ => kind.install_dir(paths).is_some_and(|d| d.is_dir()),
    }
}

/// The URL of this server's entry in the client's config, if any.
fn registered_url(kind: Kind, path: &Path) -> Option<String> {
    if kind == Kind::Codex {
        let raw = std::fs::read_to_string(path).ok()?;
        let doc: DocumentMut = raw.parse().ok()?;
        return doc
            .get("mcp_servers")?
            .get(SERVER_NAME)?
            .get("url")?
            .as_str()
            .map(str::to_string);
    }
    let (servers, url_key) = kind.json_layout();
    let doc = read_json(path).ok()?;
    let entry = doc.get(servers)?.get(SERVER_NAME)?;
    entry
        .get(url_key)
        .or_else(|| entry.get("url"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn target(kind: Kind, paths: &Paths, claude_bin: Option<&Path>, url: &str) -> ClientTarget {
    let path = kind.config_path(paths);
    ClientTarget {
        id: kind.id().to_string(),
        name: kind.name().to_string(),
        installed: installed(kind, paths, claude_bin),
        registered: path
            .as_deref()
            .and_then(|p| registered_url(kind, p))
            .is_some_and(|u| u == url),
        config_path: path.as_deref().map(detect::display_path),
    }
}

pub(crate) async fn targets(inner: &Inner) -> Vec<ClientTarget> {
    let paths = &inner.client_paths;
    let claude_bin = paths.claude_bin().await;
    let url = inner.url();
    Kind::ALL
        .into_iter()
        .map(|kind| target(kind, paths, claude_bin.as_deref(), &url))
        .collect()
}

fn kind_of(id: &str) -> AppResult<Kind> {
    Kind::from_id(id).ok_or_else(|| AppError::InvalidInput(format!("unknown AI client {id:?}")))
}

pub(crate) async fn register(inner: &Inner, id: &str) -> AppResult<ClientTarget> {
    let kind = kind_of(id)?;
    let paths = &inner.client_paths;
    let claude_bin = if kind == Kind::Claude {
        paths.claude_bin().await
    } else {
        None
    };
    if !installed(kind, paths, claude_bin.as_deref()) {
        return Err(AppError::InvalidInput(format!(
            "{} isn't installed on this computer",
            kind.name()
        )));
    }
    let url = inner.url();
    let token = inner.token()?;
    write_entry(kind, paths, claude_bin.as_deref(), &url, &token).await?;
    let target = target(kind, paths, claude_bin.as_deref(), &url);
    log::info!(
        "MCP server: added to {} ({})",
        kind.name(),
        target.config_path.as_deref().unwrap_or("its CLI")
    );
    Ok(target)
}

pub(crate) async fn unregister(inner: &Inner, id: &str) -> AppResult<ClientTarget> {
    let kind = kind_of(id)?;
    let paths = &inner.client_paths;
    let claude_bin = if kind == Kind::Claude {
        paths.claude_bin().await
    } else {
        None
    };
    if let Some(bin) = &claude_bin {
        // Exits 1 when there's nothing to remove.
        if let Err(e) = run_claude(bin, &["mcp", "remove", SERVER_NAME, "-s", "user"]).await {
            log::info!("MCP server: claude mcp remove: {e}");
        }
    }
    if let Some(path) = kind.config_path(paths) {
        if kind == Kind::Codex {
            toml_remove(&path)?;
        } else {
            json_remove(kind, &path)?;
        }
    }
    let target = target(kind, paths, claude_bin.as_deref(), &inner.url());
    log::info!("MCP server: removed from {}", kind.name());
    Ok(target)
}

/// Writes the registered clients' entries again, with the new token.
pub(crate) async fn reregister_all(inner: &Arc<Inner>) {
    for target in targets(inner).await {
        if !target.registered {
            continue;
        }
        if let Err(e) = register(inner, &target.id).await {
            log::warn!(
                "MCP server: couldn't give {} the new token: {e}",
                target.name
            );
        }
    }
}

async fn write_entry(
    kind: Kind,
    paths: &Paths,
    claude_bin: Option<&Path>,
    url: &str,
    token: &str,
) -> AppResult<()> {
    let path = kind
        .config_path(paths)
        .ok_or_else(|| AppError::InvalidInput("no home folder found".to_string()))?;
    if let Some(bin) = claude_bin {
        let header = format!("Authorization: Bearer {token}");
        // `add` refuses an existing name; the old entry may hold an old token.
        let _ = run_claude(bin, &["mcp", "remove", SERVER_NAME, "-s", "user"]).await;
        let added = run_claude(
            bin,
            &[
                "mcp",
                "add",
                "--transport",
                "http",
                "--scope",
                "user",
                SERVER_NAME,
                url,
                "--header",
                &header,
            ],
        )
        .await;
        match added {
            Ok(()) => return Ok(()),
            Err(e) => log::warn!(
                "MCP server: claude mcp add failed ({e}); editing ~/.claude.json instead"
            ),
        }
    }
    match kind {
        Kind::Codex => toml_write(&path, url, token),
        _ => json_write(kind, &path, url, token),
    }
}

/// Runs the Claude CLI; the error is its stderr (never the arguments,
/// which carry the token).
async fn run_claude(bin: &Path, args: &[&str]) -> Result<(), String> {
    let mut command = Command::new(bin);
    command
        .args(args)
        .env("PATH", detect::child_path().await)
        .env_remove("CLAUDECODE")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW: no console window flashing up.
        command.creation_flags(0x0800_0000);
    }
    let output = tokio::time::timeout(CLI_TIMEOUT, command.output())
        .await
        .map_err(|_| "timed out".to_string())?
        .map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let message = if stderr.trim().is_empty() {
            stdout
        } else {
            stderr
        };
        Err(message.trim().chars().take(300).collect())
    }
}

fn read_json(path: &Path) -> AppResult<Value> {
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Value::Object(Map::new())),
        Err(e) => return Err(e.into()),
    };
    if raw.trim().is_empty() {
        return Ok(Value::Object(Map::new()));
    }
    serde_json::from_str(&raw).map_err(|e| {
        AppError::InvalidInput(format!(
            "{} isn't valid JSON ({e}); fix it or add the server by hand",
            detect::display_path(path)
        ))
    })
}

/// Copies the current file to `<file>.bak`, then replaces it.
fn write_with_backup(path: &Path, contents: &str) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    if path.exists() {
        let mut backup = path.as_os_str().to_owned();
        backup.push(".bak");
        std::fs::copy(path, PathBuf::from(backup))?;
    }
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    std::fs::write(&tmp, contents)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

fn object_at<'a>(
    map: &'a mut Map<String, Value>,
    key: &str,
) -> AppResult<&'a mut Map<String, Value>> {
    let value = map
        .entry(key.to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    if !value.is_object() {
        return Err(AppError::InvalidInput(format!(
            "\"{key}\" in the client's config isn't an object; fix it or add the server by hand"
        )));
    }
    Ok(value.as_object_mut().expect("checked"))
}

fn json_write(kind: Kind, path: &Path, url: &str, token: &str) -> AppResult<()> {
    let mut doc = read_json(path)?;
    let root = doc.as_object_mut().ok_or_else(|| {
        AppError::InvalidInput(format!(
            "{} isn't a JSON object",
            detect::display_path(path)
        ))
    })?;
    let (servers_key, url_key) = kind.json_layout();
    let servers = object_at(root, servers_key)?;
    let entry = object_at(servers, SERVER_NAME)?;
    if matches!(kind, Kind::Claude | Kind::VsCode) {
        entry.insert("type".into(), Value::String("http".into()));
    }
    entry.insert(url_key.into(), Value::String(url.to_string()));
    let headers = object_at(entry, "headers")?;
    headers.insert(
        "Authorization".into(),
        Value::String(format!("Bearer {token}")),
    );
    let mut text =
        serde_json::to_string_pretty(&doc).map_err(|e| AppError::InvalidInput(e.to_string()))?;
    text.push('\n');
    write_with_backup(path, &text)
}

fn json_remove(kind: Kind, path: &Path) -> AppResult<()> {
    if !path.exists() {
        return Ok(());
    }
    let mut doc = read_json(path)?;
    let (servers_key, _) = kind.json_layout();
    let removed = doc
        .get_mut(servers_key)
        .and_then(Value::as_object_mut)
        .and_then(|servers| servers.remove(SERVER_NAME))
        .is_some();
    if !removed {
        return Ok(());
    }
    let mut text =
        serde_json::to_string_pretty(&doc).map_err(|e| AppError::InvalidInput(e.to_string()))?;
    text.push('\n');
    write_with_backup(path, &text)
}

fn read_toml(path: &Path) -> AppResult<DocumentMut> {
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(e.into()),
    };
    raw.parse().map_err(|e| {
        AppError::InvalidInput(format!(
            "{} isn't valid TOML ({e}); fix it or add the server by hand",
            detect::display_path(path)
        ))
    })
}

fn table_at<'a>(item: &'a mut Item, key: &str) -> AppResult<&'a mut dyn toml_edit::TableLike> {
    if item.is_none() {
        let mut table = Table::new();
        table.set_implicit(true);
        *item = Item::Table(table);
    }
    item.as_table_like_mut().ok_or_else(|| {
        AppError::InvalidInput(format!(
            "\"{key}\" in Codex's config.toml isn't a table; fix it or add the server by hand"
        ))
    })
}

fn toml_write(path: &Path, url: &str, token: &str) -> AppResult<()> {
    let mut doc = read_toml(path)?;
    let servers = table_at(
        doc.entry("mcp_servers").or_insert(Item::None),
        "mcp_servers",
    )?;
    let entry_item = servers.entry(SERVER_NAME).or_insert(Item::None);
    if entry_item.is_none() {
        *entry_item = Item::Table(Table::new());
    }
    let entry = table_at(entry_item, SERVER_NAME)?;
    entry.insert("url", toml_edit::value(url));
    let headers_item = entry.entry("http_headers").or_insert(Item::None);
    if headers_item.is_none() {
        *headers_item = Item::Table(Table::new());
    }
    let headers = table_at(headers_item, "http_headers")?;
    headers.insert("Authorization", toml_edit::value(format!("Bearer {token}")));
    write_with_backup(path, &doc.to_string())
}

fn toml_remove(path: &Path) -> AppResult<()> {
    if !path.exists() {
        return Ok(());
    }
    let mut doc = read_toml(path)?;
    let removed = doc
        .get_mut("mcp_servers")
        .and_then(Item::as_table_like_mut)
        .and_then(|servers| servers.remove(SERVER_NAME))
        .is_some();
    if removed {
        write_with_backup(path, &doc.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::time::Duration;

    use super::super::test_support::inner;
    use super::*;

    fn read(path: &Path) -> String {
        fs::read_to_string(path).unwrap()
    }

    #[tokio::test]
    async fn targets_follow_what_is_installed() {
        let (host, inner) = inner(Duration::from_secs(1));
        let home = host.dir.join("home");
        let targets = targets(&inner).await;
        assert_eq!(targets.len(), 5);
        assert!(targets.iter().all(|t| !t.installed && !t.registered));
        assert!(register(&inner, "cursor").await.is_err(), "not installed");
        assert!(register(&inner, "nope").await.is_err());

        fs::create_dir_all(home.join(".cursor")).unwrap();
        let cursor = targets_by_id(&inner, "cursor").await;
        assert!(cursor.installed);
        assert!(cursor.config_path.unwrap().ends_with("mcp.json"));
    }

    async fn targets_by_id(inner: &Inner, id: &str) -> ClientTarget {
        targets(inner)
            .await
            .into_iter()
            .find(|t| t.id == id)
            .unwrap()
    }

    #[tokio::test]
    async fn json_clients_merge_and_unmerge_in_place() {
        let (host, inner) = inner(Duration::from_secs(1));
        let home = host.dir.join("home");
        let token = inner.token().unwrap();
        let url = inner.url();
        let cases = [
            ("cursor", home.join(".cursor/mcp.json"), "mcpServers", "url"),
            (
                "vscode",
                home.join(".config/Code/User/mcp.json"),
                "servers",
                "url",
            ),
            (
                "windsurf",
                home.join(".codeium/windsurf/mcp_config.json"),
                "mcpServers",
                "serverUrl",
            ),
            ("claude", home.join(".claude.json"), "mcpServers", "url"),
        ];
        for (id, path, servers, url_key) in cases {
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(
                &path,
                format!(r#"{{"theme":"dark","{servers}":{{"other":{{"command":"x"}}}},"zz":1}}"#),
            )
            .unwrap();

            let target = register(&inner, id).await.unwrap();
            assert!(target.installed && target.registered, "{id}");
            let doc: Value = serde_json::from_str(&read(&path)).unwrap();
            let entry = &doc[servers][SERVER_NAME];
            assert_eq!(entry[url_key], url.as_str(), "{id}");
            assert_eq!(entry["headers"]["Authorization"], format!("Bearer {token}"));
            if id == "vscode" || id == "claude" {
                assert_eq!(entry["type"], "http");
            }
            // Unrelated keys stay, in their order.
            assert_eq!(doc["theme"], "dark");
            assert_eq!(doc[servers]["other"]["command"], "x");
            let keys: Vec<&String> = doc.as_object().unwrap().keys().collect();
            assert_eq!(keys, ["theme", servers, "zz"]);
            let mut backup = path.clone().into_os_string();
            backup.push(".bak");
            assert!(read(Path::new(&backup)).contains("\"theme\""));

            // Idempotent.
            let before = read(&path);
            register(&inner, id).await.unwrap();
            assert_eq!(read(&path), before, "{id}");

            let target = unregister(&inner, id).await.unwrap();
            assert!(!target.registered, "{id}");
            let doc: Value = serde_json::from_str(&read(&path)).unwrap();
            assert!(doc[servers].get(SERVER_NAME).is_none());
            assert_eq!(doc[servers]["other"]["command"], "x");
            let after = read(&path);
            unregister(&inner, id).await.unwrap();
            assert_eq!(read(&path), after, "{id}");
        }
    }

    #[tokio::test]
    async fn a_missing_config_file_is_created() {
        let (host, inner) = inner(Duration::from_secs(1));
        let home = host.dir.join("home");
        fs::create_dir_all(home.join(".config/Code/User")).unwrap();
        register(&inner, "vscode").await.unwrap();
        let doc: Value =
            serde_json::from_str(&read(&home.join(".config/Code/User/mcp.json"))).unwrap();
        assert_eq!(doc["servers"][SERVER_NAME]["type"], "http");
    }

    #[tokio::test]
    async fn invalid_json_is_left_alone() {
        let (host, inner) = inner(Duration::from_secs(1));
        let path = host.dir.join("home/.cursor/mcp.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "{ // comment\n}").unwrap();
        assert!(register(&inner, "cursor").await.is_err());
        assert_eq!(read(&path), "{ // comment\n}");
    }

    #[tokio::test]
    async fn codex_toml_is_edited_in_place() {
        let (host, inner) = inner(Duration::from_secs(1));
        let path = host.dir.join("home/.codex/config.toml");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let original =
            "# my settings\nmodel = \"gpt-5\"\n\n[mcp_servers.other]\ncommand = \"x\" # keep\n";
        fs::write(&path, original).unwrap();
        let token = inner.token().unwrap();

        let target = register(&inner, "codex").await.unwrap();
        assert!(target.registered);
        let text = read(&path);
        assert!(text.starts_with(original), "{text}");
        assert!(text.contains("[mcp_servers.postgres-studio]"), "{text}");
        assert!(
            text.contains("[mcp_servers.postgres-studio.http_headers]"),
            "{text}"
        );
        assert!(!text.contains("\n[mcp_servers]\n"), "{text}");
        let doc: DocumentMut = text.parse().unwrap();
        assert_eq!(
            doc["mcp_servers"][SERVER_NAME]["url"].as_str(),
            Some(inner.url().as_str())
        );
        assert_eq!(
            doc["mcp_servers"][SERVER_NAME]["http_headers"]["Authorization"].as_str(),
            Some(format!("Bearer {token}").as_str())
        );

        register(&inner, "codex").await.unwrap();
        assert_eq!(read(&path), text, "idempotent");

        let target = unregister(&inner, "codex").await.unwrap();
        assert!(!target.registered);
        let after = read(&path);
        assert!(after.contains("[mcp_servers.other]"));
        assert!(after.contains("# my settings"));
        assert!(!after.contains("postgres-studio"));
    }

    #[tokio::test]
    async fn a_new_token_reaches_the_registered_clients() {
        let (host, inner) = inner(Duration::from_secs(1));
        let home = host.dir.join("home");
        fs::create_dir_all(home.join(".cursor")).unwrap();
        fs::create_dir_all(home.join(".codex")).unwrap();
        register(&inner, "cursor").await.unwrap();
        let token = inner.regenerate_token().unwrap();
        reregister_all(&inner).await;
        let doc: Value = serde_json::from_str(&read(&home.join(".cursor/mcp.json"))).unwrap();
        assert_eq!(
            doc["mcpServers"][SERVER_NAME]["headers"]["Authorization"],
            format!("Bearer {token}")
        );
        // Codex wasn't registered, so it's left alone.
        assert!(!home.join(".codex/config.toml").exists());
    }
}
