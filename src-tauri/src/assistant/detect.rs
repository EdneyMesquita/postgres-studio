//! Finding the agent CLIs.
//!
//! A GUI app launched from the dock or a desktop entry doesn't inherit the
//! PATH the user's login shell sets up, so `claude`/`codex` installed with
//! npm, bun or the native installers are usually invisible to it. The search
//! PATH is therefore the app's own PATH, merged with the login shell's
//! (asked once and cached) and the usual install folders. The same merged
//! PATH is given to the spawned CLIs, since npm-installed ones are
//! `#!/usr/bin/env node` scripts that need to find `node`.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::Serialize;
use tokio::process::Command;
use tokio::sync::OnceCell;

use super::models::{models_for, AgentModels};
use super::AgentKind;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedAgent {
    pub id: AgentKind,
    pub name: String,
    /// Where the CLI was found, with the home folder shown as `~`; `None`
    /// when it isn't installed.
    pub path: Option<String>,
    pub version: Option<String>,
    /// Set when the CLI was found but didn't run.
    pub error: Option<String>,
    /// What it can run, and what the user set up for it.
    #[serde(flatten)]
    pub models: AgentModels,
}

const LOGIN_SHELL_TIMEOUT: Duration = Duration::from_secs(3);
const VERSION_TIMEOUT: Duration = Duration::from_secs(5);

static SEARCH_DIRS: OnceCell<Vec<PathBuf>> = OnceCell::const_new();

pub(crate) fn home_dir() -> Option<PathBuf> {
    std::env::home_dir().filter(|p| !p.as_os_str().is_empty())
}

/// The merged search folders, in priority order, without duplicates.
pub(crate) async fn search_dirs() -> &'static [PathBuf] {
    SEARCH_DIRS
        .get_or_init(|| async {
            let own = std::env::var_os("PATH").unwrap_or_default();
            let login = login_shell_path().await.unwrap_or_default();
            merge_dirs(
                std::env::split_paths(&own)
                    .chain(std::env::split_paths(&OsString::from(login)))
                    .chain(common_dirs()),
            )
        })
        .await
}

/// The PATH value for spawned CLIs.
pub(crate) async fn child_path() -> OsString {
    std::env::join_paths(search_dirs().await).unwrap_or_else(|_| {
        // A folder with the separator in its name can't be joined; fall back
        // to what the app itself has.
        std::env::var_os("PATH").unwrap_or_default()
    })
}

fn merge_dirs(dirs: impl Iterator<Item = PathBuf>) -> Vec<PathBuf> {
    let mut merged: Vec<PathBuf> = Vec::new();
    for dir in dirs {
        if dir.as_os_str().is_empty() || merged.contains(&dir) {
            continue;
        }
        merged.push(dir);
    }
    merged
}

fn common_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(home) = home_dir() {
        for rel in [
            ".local/bin",
            ".claude/local",
            ".npm-global/bin",
            ".bun/bin",
            ".volta/bin",
            ".cargo/bin",
        ] {
            dirs.push(home.join(rel));
        }
    }
    if cfg!(windows) {
        if let Some(appdata) = std::env::var_os("APPDATA") {
            dirs.push(PathBuf::from(appdata).join("npm"));
        }
    } else {
        dirs.push(PathBuf::from("/usr/local/bin"));
        dirs.push(PathBuf::from("/opt/homebrew/bin"));
    }
    dirs
}

/// The PATH a login shell sets up, or `None` when there's no shell to ask
/// (Windows) or it doesn't answer within a few seconds.
async fn login_shell_path() -> Option<String> {
    if cfg!(windows) {
        return None;
    }
    let shell = std::env::var("SHELL")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            if cfg!(target_os = "macos") {
                "/bin/zsh".to_string()
            } else {
                "/bin/sh".to_string()
            }
        });
    // fish keeps PATH as a list, which "$PATH" would join with spaces.
    let script = if shell.ends_with("fish") {
        "printf %s (string join : $PATH)"
    } else {
        "printf %s \"$PATH\""
    };
    let output = tokio::time::timeout(
        LOGIN_SHELL_TIMEOUT,
        Command::new(&shell)
            .args(["-lc", script])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .ok()?
    .ok()?;
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (output.status.success() && !path.is_empty()).then_some(path)
}

fn candidate_names(kind: AgentKind) -> &'static [&'static str] {
    match (kind, cfg!(windows)) {
        (AgentKind::Claude, false) => &["claude"],
        (AgentKind::Codex, false) => &["codex"],
        (AgentKind::Claude, true) => &["claude.exe", "claude.cmd"],
        (AgentKind::Codex, true) => &["codex.exe", "codex.cmd"],
    }
}

fn is_executable(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.is_file() && meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        meta.is_file()
    }
}

/// The first `kind` binary on the merged PATH.
pub(crate) async fn find_binary(kind: AgentKind) -> Option<PathBuf> {
    find_in(search_dirs().await, candidate_names(kind))
}

fn find_in(dirs: &[PathBuf], names: &[&str]) -> Option<PathBuf> {
    dirs.iter()
        .flat_map(|dir| names.iter().map(move |name| dir.join(name)))
        .find(|path| is_executable(path))
}

/// Whether a binary is a Windows batch shim (npm's `claude.cmd`). Rust's
/// `Command` runs those through `cmd.exe` itself, with the escaping `cmd`
/// needs, but refuses arguments that can't be escaped for it, such as ones
/// containing line breaks.
pub(crate) fn is_batch_shim(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"))
}

/// A path for display, with the home folder shown as `~`.
pub(crate) fn display_path(path: &Path) -> String {
    if let Some(home) = home_dir() {
        if let Ok(rest) = path.strip_prefix(&home) {
            let sep = std::path::MAIN_SEPARATOR;
            return format!("~{sep}{}", rest.display());
        }
    }
    path.display().to_string()
}

/// Pulls the version number out of a `--version` line:
/// `2.1.276 (Claude Code)` -> `2.1.276`, `codex-cli 0.153.4` -> `0.153.4`.
/// Falls back to the whole line when nothing looks like a version.
pub(crate) fn parse_version(output: &str) -> Option<String> {
    let line = output.lines().map(str::trim).find(|l| !l.is_empty())?;
    let version = line
        .split_whitespace()
        .map(|token| token.trim_start_matches('v'))
        .find(|token| token.starts_with(|c: char| c.is_ascii_digit()) && token.contains('.'))
        .map(|token| {
            token
                .trim_end_matches(|c: char| !c.is_ascii_alphanumeric())
                .to_string()
        });
    Some(version.unwrap_or_else(|| line.to_string()))
}

async fn version_of(path: &Path) -> Result<String, String> {
    let output = tokio::time::timeout(
        VERSION_TIMEOUT,
        Command::new(path)
            .arg("--version")
            .env("PATH", child_path().await)
            .stdin(Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| "`--version` didn't answer within 5 seconds".to_string())?
    .map_err(|e| format!("couldn't run it: {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let detail = stderr
            .lines()
            .chain(stdout.lines())
            .find(|l| !l.trim().is_empty());
        return Err(match detail {
            Some(line) => format!("`--version` failed: {}", line.trim()),
            None => format!("`--version` failed ({})", output.status),
        });
    }
    parse_version(&stdout).ok_or_else(|| "`--version` printed nothing".to_string())
}

/// Every agent with where it was found and its version.
pub(crate) async fn detect_agents() -> Vec<(AgentKind, DetectedAgent, Option<PathBuf>)> {
    let mut detected = Vec::new();
    for kind in AgentKind::ALL {
        let path = find_binary(kind).await;
        let (version, error) = match &path {
            Some(path) => match version_of(path).await {
                Ok(v) => (Some(v), None),
                Err(e) => (None, Some(e)),
            },
            None => (None, None),
        };
        detected.push((
            kind,
            DetectedAgent {
                id: kind,
                name: kind.display_name().to_string(),
                path: path.as_deref().map(display_path),
                version,
                error,
                models: if path.is_some() {
                    models_for(kind)
                } else {
                    AgentModels::default()
                },
            },
            path,
        ));
    }
    detected
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_strings_parse() {
        assert_eq!(
            parse_version("2.1.276 (Claude Code)\n").as_deref(),
            Some("2.1.276")
        );
        assert_eq!(
            parse_version("codex-cli 0.153.4").as_deref(),
            Some("0.153.4")
        );
        assert_eq!(
            parse_version("\n  v1.2.3-beta.1,\n").as_deref(),
            Some("1.2.3-beta.1")
        );
        assert_eq!(
            parse_version("something odd").as_deref(),
            Some("something odd")
        );
        assert_eq!(parse_version("  \n"), None);
    }

    #[test]
    fn merged_dirs_keep_the_first_occurrence() {
        let merged = merge_dirs(
            ["/a", "", "/b", "/a", "/c", "/b"]
                .into_iter()
                .map(PathBuf::from),
        );
        assert_eq!(merged, ["/a", "/b", "/c"].map(PathBuf::from).to_vec());
    }

    #[test]
    fn finds_the_first_executable_candidate() {
        let dir =
            std::env::temp_dir().join(format!("postgres-studio-detect-{}", uuid::Uuid::new_v4()));
        let (first, second) = (dir.join("one"), dir.join("two"));
        std::fs::create_dir_all(&first).unwrap();
        std::fs::create_dir_all(&second).unwrap();
        let bin = second.join("claude");
        std::fs::write(&bin, "#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            // not executable yet: skipped
            assert_eq!(find_in(&[first.clone(), second.clone()], &["claude"]), None);
            std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        assert_eq!(find_in(&[first, second], &["claude"]), Some(bin));
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn home_is_shown_as_a_tilde() {
        let Some(home) = home_dir() else { return };
        let shown = display_path(&home.join(".local").join("bin").join("claude"));
        assert!(shown.starts_with('~'), "{shown}");
        assert!(shown.ends_with("claude"));
        assert_eq!(
            display_path(Path::new("/usr/bin/claude")),
            "/usr/bin/claude"
        );
    }

    #[test]
    fn batch_shims_are_recognized() {
        assert!(is_batch_shim(Path::new("C:\\npm\\claude.cmd")));
        assert!(is_batch_shim(Path::new("codex.BAT")));
        assert!(!is_batch_shim(Path::new("/usr/bin/claude")));
    }
}
