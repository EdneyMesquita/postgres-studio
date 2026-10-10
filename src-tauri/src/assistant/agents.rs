//! Running the agent CLIs headless and turning their JSONL output into
//! `assistant-event`s.
//!
//! Claude Code runs as one long-lived process per session, reading turns as
//! stream-json lines on stdin; after a stop (which kills it) the next turn
//! respawns it with `--resume`. Codex runs one `codex exec` per turn, the
//! later ones as `codex exec resume <thread>`.
//!
//! Both are locked down to the MCP tools: Claude with no built-in tools, no
//! settings or CLAUDE.md, and only the `postgres_studio` server; Codex with no
//! user config, a read-only sandbox, no approvals, and every feature that
//! could run commands or reach outside turned off. Both run in an empty
//! folder of the app's own.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::task::JoinHandle;
use uuid::Uuid;

use super::{detect, mcp, prompt, AgentKind, AgentSession, AssistantEvent, Inner, EVENT};
use crate::error::{AppError, AppResult};

/// Env var Codex reads the MCP bearer token from, so it never appears on a
/// command line.
pub(crate) const TOKEN_ENV: &str = "POSTGRES_STUDIO_MCP_TOKEN";
const STDERR_TAIL: usize = 4 * 1024;

/// Codex features that would let the agent run commands, touch files, or
/// reach the network or other apps. Only ones `codex features list` knows
/// (0.153): an unknown name is an error.
const CODEX_DISABLED_FEATURES: [&str; 16] = [
    "shell_tool",
    "unified_exec",
    "apps",
    "plugins",
    "remote_plugin",
    "browser_use",
    "browser_use_external",
    "browser_use_full_cdp_access",
    "computer_use",
    "in_app_browser",
    "image_generation",
    "view_image",
    "multi_agent",
    "hooks",
    "skill_mcp_dependency_install",
    "tool_suggest",
];

/// Per-session process state. At most one turn runs at a time.
#[derive(Default)]
pub(crate) struct Runner {
    /// Set while a turn runs; whoever takes it emits that turn's turn-end,
    /// so there is exactly one.
    turn: Option<u64>,
    next_turn: u64,
    next_generation: u64,
    process: Option<Process>,
}

struct Process {
    /// Tells this process's output apart from a later one's after a stop.
    generation: u64,
    child: Child,
    /// Kept open for Claude, which reads turns from it.
    stdin: Option<ChildStdin>,
    stderr: Arc<Mutex<Vec<u8>>>,
    stderr_task: JoinHandle<()>,
}

/// One thing a CLI's output line means for the UI.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Parsed {
    CliSession(String),
    Text {
        block_id: String,
        text: String,
        done: bool,
    },
    TurnEnd {
        error: Option<String>,
    },
}

pub(crate) trait LineParser: Send + 'static {
    fn parse(&mut self, line: &str) -> Vec<Parsed>;
    /// What went wrong, when the process ends mid-turn without saying.
    fn last_error(&self) -> Option<String> {
        None
    }
}

/// Parses `claude -p --output-format stream-json --verbose
/// --include-partial-messages`.
#[derive(Default)]
pub(crate) struct ClaudeParser {
    message_id: Option<String>,
    /// Text blocks of the current message by content index.
    blocks: HashMap<u64, String>,
    /// Messages whose text arrived as stream events; their final
    /// `assistant` line repeats it and is skipped.
    streamed: HashSet<String>,
}

impl ClaudeParser {
    fn block_id(&self, index: u64) -> String {
        format!(
            "{}-{index}",
            self.message_id.as_deref().unwrap_or("message")
        )
    }
}

impl LineParser for ClaudeParser {
    fn parse(&mut self, line: &str) -> Vec<Parsed> {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            return Vec::new();
        };
        let str_at = |v: &Value, key: &str| v.get(key).and_then(Value::as_str).map(str::to_string);
        match value.get("type").and_then(Value::as_str) {
            Some("system") if value.get("subtype").and_then(Value::as_str) == Some("init") => {
                str_at(&value, "session_id")
                    .map(Parsed::CliSession)
                    .into_iter()
                    .collect()
            }
            Some("stream_event") => {
                let Some(event) = value.get("event") else {
                    return Vec::new();
                };
                let index = event.get("index").and_then(Value::as_u64).unwrap_or(0);
                match event.get("type").and_then(Value::as_str) {
                    Some("message_start") => {
                        let id = event
                            .get("message")
                            .and_then(|m| str_at(m, "id"))
                            .unwrap_or_else(|| Uuid::new_v4().simple().to_string());
                        self.streamed.insert(id.clone());
                        self.message_id = Some(id);
                        self.blocks.clear();
                        Vec::new()
                    }
                    Some("content_block_start") => {
                        let block = event.get("content_block");
                        if block.and_then(|b| str_at(b, "type")).as_deref() != Some("text") {
                            return Vec::new();
                        }
                        let text = block.and_then(|b| str_at(b, "text")).unwrap_or_default();
                        self.blocks.insert(index, text.clone());
                        if text.is_empty() {
                            return Vec::new();
                        }
                        vec![Parsed::Text {
                            block_id: self.block_id(index),
                            text,
                            done: false,
                        }]
                    }
                    Some("content_block_delta") => {
                        let delta = event.get("delta");
                        if delta.and_then(|d| str_at(d, "type")).as_deref() != Some("text_delta") {
                            return Vec::new();
                        }
                        let piece = delta.and_then(|d| str_at(d, "text")).unwrap_or_default();
                        let text = self.blocks.entry(index).or_default();
                        text.push_str(&piece);
                        let text = text.clone();
                        vec![Parsed::Text {
                            block_id: self.block_id(index),
                            text,
                            done: false,
                        }]
                    }
                    Some("content_block_stop") => match self.blocks.get(&index) {
                        Some(text) => vec![Parsed::Text {
                            block_id: self.block_id(index),
                            text: text.clone(),
                            done: true,
                        }],
                        None => Vec::new(),
                    },
                    _ => Vec::new(),
                }
            }
            Some("assistant") => {
                let Some(message) = value.get("message") else {
                    return Vec::new();
                };
                let Some(id) = str_at(message, "id") else {
                    return Vec::new();
                };
                if self.streamed.contains(&id) {
                    return Vec::new();
                }
                message
                    .get("content")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .enumerate()
                    .filter(|(_, block)| block.get("type").and_then(Value::as_str) == Some("text"))
                    .map(|(i, block)| Parsed::Text {
                        block_id: format!("{id}-{i}"),
                        text: str_at(block, "text").unwrap_or_default(),
                        done: true,
                    })
                    .collect()
            }
            Some("result") => {
                let is_error = value
                    .get("is_error")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let error = is_error.then(|| {
                    str_at(&value, "result")
                        .filter(|r| !r.trim().is_empty())
                        .or_else(|| {
                            let errors: Vec<String> = value
                                .get("errors")
                                .and_then(Value::as_array)
                                .into_iter()
                                .flatten()
                                .filter_map(|e| e.as_str().map(str::to_string))
                                .collect();
                            (!errors.is_empty()).then(|| errors.join("\n"))
                        })
                        .or_else(|| str_at(&value, "subtype"))
                        .unwrap_or_else(|| "Claude Code reported an error.".to_string())
                });
                vec![Parsed::TurnEnd { error }]
            }
            _ => Vec::new(),
        }
    }
}

/// Parses `codex exec --json`.
pub(crate) struct CodexParser {
    /// Codex numbers items from `item_0` in every process, so ids are
    /// prefixed to stay unique across turns.
    prefix: String,
    last_error: Option<String>,
}

impl CodexParser {
    pub fn new() -> Self {
        Self {
            prefix: Uuid::new_v4().simple().to_string()[..8].to_string(),
            last_error: None,
        }
    }
}

impl LineParser for CodexParser {
    fn parse(&mut self, line: &str) -> Vec<Parsed> {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            return Vec::new();
        };
        let kind = value
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        match kind {
            "thread.started" => value
                .get("thread_id")
                .and_then(Value::as_str)
                .map(|id| Parsed::CliSession(id.to_string()))
                .into_iter()
                .collect(),
            "item.started" | "item.updated" | "item.completed" => {
                let Some(item) = value.get("item") else {
                    return Vec::new();
                };
                let item_type = item
                    .get("type")
                    .or_else(|| item.get("item_type"))
                    .and_then(Value::as_str);
                if item_type != Some("agent_message") {
                    return Vec::new();
                }
                let text = item.get("text").and_then(Value::as_str).unwrap_or_default();
                let done = kind == "item.completed";
                if text.is_empty() && !done {
                    return Vec::new();
                }
                let id = item.get("id").and_then(Value::as_str).unwrap_or("item");
                vec![Parsed::Text {
                    block_id: format!("{}-{id}", self.prefix),
                    text: text.to_string(),
                    done,
                }]
            }
            "turn.completed" => vec![Parsed::TurnEnd { error: None }],
            "turn.failed" => {
                let message = value
                    .get("error")
                    .and_then(|e| e.get("message").and_then(Value::as_str).or(e.as_str()))
                    .map(api_error_message)
                    .or_else(|| self.last_error.clone())
                    .unwrap_or_else(|| "Codex couldn't finish the turn.".to_string());
                vec![Parsed::TurnEnd {
                    error: Some(message),
                }]
            }
            // Not necessarily the end: Codex reports retried stream errors
            // this way too. A fatal one is followed by turn.failed or by the
            // process exiting, which reports it.
            "error" => {
                self.last_error = value
                    .get("message")
                    .and_then(Value::as_str)
                    .map(api_error_message);
                Vec::new()
            }
            _ => Vec::new(),
        }
    }

    fn last_error(&self) -> Option<String> {
        self.last_error.clone()
    }
}

/// Codex passes API errors on as the raw response body, e.g.
/// `{"type":"error","status":400,"error":{"message":"The 'x' model is not
/// supported..."}}`; the message inside is what the user needs to read.
fn api_error_message(message: &str) -> String {
    serde_json::from_str::<Value>(message)
        .ok()
        .and_then(|body| {
            body.pointer("/error/message")
                .or_else(|| body.get("message"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_else(|| message.to_string())
}

/// How the system prompt reaches Claude.
pub(crate) enum PromptArg<'a> {
    Inline(&'a str),
    /// For Windows batch shims, which can't take a multi-line argument.
    File(&'a Path),
}

/// The model and effort a session runs with, when set.
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct ModelChoice<'a> {
    pub model: Option<&'a str>,
    pub effort: Option<&'a str>,
}

/// `claude` arguments for a session process.
pub(crate) fn claude_args(
    mcp_url: &str,
    authorization: &str,
    prompt: PromptArg<'_>,
    resume: Option<&str>,
    choice: ModelChoice<'_>,
) -> Vec<String> {
    let mcp_config = json!({
        "mcpServers": {
            "postgres_studio": {
                "type": "http",
                "url": mcp_url,
                "headers": { "Authorization": authorization },
            }
        }
    })
    .to_string();
    let mut args: Vec<String> = [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        // No built-in tools: no shell, files or web.
        "--tools",
        "",
        "--strict-mcp-config",
        "--mcp-config",
        &mcp_config,
        "--allowedTools",
        "mcp__postgres_studio",
        // Anything else that would ask for permission is refused rather than
        // waiting on a prompt nobody answers.
        "--permission-prompts",
        "none",
        // No user/project/local settings, hooks, plugins or CLAUDE.md.
        "--setting-sources",
        "",
        "--disable-slash-commands",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    match prompt {
        PromptArg::Inline(text) => {
            args.push("--append-system-prompt".to_string());
            args.push(text.to_string());
        }
        PromptArg::File(path) => {
            args.push("--append-system-prompt-file".to_string());
            args.push(path.to_string_lossy().into_owned());
        }
    }
    if let Some(model) = choice.model {
        args.push("--model".to_string());
        args.push(model.to_string());
    }
    if let Some(effort) = choice.effort {
        args.push("--effort".to_string());
        args.push(effort.to_string());
    }
    if let Some(id) = resume {
        args.push("--resume".to_string());
        args.push(id.to_string());
    }
    args
}

/// A TOML string literal for a `-c key=value` override. JSON's string
/// escapes are all valid TOML basic-string escapes.
fn toml_string(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".to_string())
}

/// `codex` arguments for one turn; the prompt goes on stdin (`-`).
/// `instructions` is `None` when it has to travel in the prompt instead.
pub(crate) fn codex_args(
    workdir: &Path,
    mcp_url: &str,
    instructions: Option<&str>,
    resume: Option<&str>,
    choice: ModelChoice<'_>,
) -> Vec<String> {
    let mut args: Vec<String> = vec!["exec".into()];
    if resume.is_some() {
        args.push("resume".into());
    }
    for flag in [
        "--json",
        "--skip-git-repo-check",
        "--ignore-user-config",
        "--ignore-rules",
    ] {
        args.push(flag.into());
    }
    // `exec resume` takes neither -C nor -s; the working folder is the
    // process's own and the sandbox is set through config there.
    if resume.is_none() {
        args.extend([
            "-C".into(),
            workdir.to_string_lossy().into_owned(),
            "-s".into(),
            "read-only".into(),
        ]);
    } else {
        args.extend(["-c".into(), "sandbox_mode=\"read-only\"".into()]);
    }
    args.extend(["-c".into(), "approval_policy=\"never\"".into()]);
    for feature in CODEX_DISABLED_FEATURES {
        args.extend(["--disable".into(), feature.into()]);
    }
    args.extend([
        "-c".into(),
        "web_search=\"disabled\"".into(),
        // The skills list points at files the agent has no tool to read.
        "-c".into(),
        "skills.include_instructions=false".into(),
        "-c".into(),
        format!("mcp_servers.postgres_studio.url={}", toml_string(mcp_url)),
        "-c".into(),
        format!(
            "mcp_servers.postgres_studio.bearer_token_env_var={}",
            toml_string(TOKEN_ENV)
        ),
        // The tools are read-only; with approvals off, a tool that needed
        // approval would just be refused.
        "-c".into(),
        "mcp_servers.postgres_studio.default_tools_approval_mode=\"approve\"".into(),
    ]);
    if let Some(instructions) = instructions {
        args.extend([
            "-c".into(),
            format!("developer_instructions={}", toml_string(instructions)),
        ]);
    }
    if let Some(model) = choice.model {
        args.extend(["-m".into(), model.into()]);
    }
    if let Some(effort) = choice.effort {
        args.extend([
            "-c".into(),
            format!("model_reasoning_effort={}", toml_string(effort)),
        ]);
    }
    if let Some(thread) = resume {
        args.push(thread.into());
    }
    args.push("-".into());
    args
}

async fn binary(inner: &Inner, kind: AgentKind) -> AppResult<PathBuf> {
    if let Some(path) = inner.binaries.lock().unwrap().get(&kind) {
        if path.exists() {
            return Ok(path.clone());
        }
    }
    let path = detect::find_binary(kind).await.ok_or_else(|| {
        AppError::Assistant(format!(
            "{} isn't installed, or Postgres Studio can't find it.",
            kind.display_name()
        ))
    })?;
    inner.binaries.lock().unwrap().insert(kind, path.clone());
    Ok(path)
}

struct Spawned {
    child: Child,
    stdin: ChildStdin,
    stdout: ChildStdout,
    stderr: Arc<Mutex<Vec<u8>>>,
    stderr_task: JoinHandle<()>,
}

async fn spawn(
    inner: &Inner,
    kind: AgentKind,
    program: &Path,
    args: &[String],
    env: &[(&str, &str)],
) -> AppResult<Spawned> {
    std::fs::create_dir_all(&inner.workdir)?;
    let mut command = Command::new(program);
    command
        .args(args)
        .current_dir(&inner.workdir)
        .env("PATH", detect::child_path().await)
        // Set when the app itself was started from a Claude Code session.
        .env_remove("CLAUDECODE")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    for (key, value) in env {
        command.env(key, value);
    }
    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW: no console window flashing up for each turn.
        command.creation_flags(0x0800_0000);
    }
    let mut child = command
        .spawn()
        .map_err(|e| AppError::Assistant(format!("Couldn't start {}: {e}", kind.display_name())))?;
    // Not the arguments: they carry the system prompt and the MCP address.
    log::info!(
        "started {} from {} (pid {})",
        kind.display_name(),
        program.display(),
        child
            .id()
            .map_or("unknown".to_string(), |pid| pid.to_string())
    );
    let (Some(stdin), Some(stdout), Some(mut stderr_pipe)) =
        (child.stdin.take(), child.stdout.take(), child.stderr.take())
    else {
        return Err(AppError::Assistant(format!(
            "Couldn't talk to {}.",
            kind.display_name()
        )));
    };
    let stderr = Arc::new(Mutex::new(Vec::new()));
    let tail = stderr.clone();
    let stderr_task = tokio::spawn(async move {
        let mut buf = [0u8; 4096];
        while let Ok(n) = stderr_pipe.read(&mut buf).await {
            if n == 0 {
                break;
            }
            let mut tail = tail.lock().unwrap();
            tail.extend_from_slice(&buf[..n]);
            let excess = tail.len().saturating_sub(STDERR_TAIL);
            tail.drain(..excess);
        }
    });
    Ok(Spawned {
        child,
        stdin,
        stdout,
        stderr,
        stderr_task,
    })
}

/// Starts a turn: hands `text` to the CLI and returns; the output arrives
/// as events.
pub(crate) async fn send(
    inner: &Arc<Inner>,
    session: &Arc<AgentSession>,
    text: String,
) -> AppResult<()> {
    let port = mcp::ensure_server(inner).await?;
    let mcp_url = mcp::url(port);
    let program = binary(inner, session.agent).await?;
    let batch_shim = detect::is_batch_shim(&program);
    let system_prompt = prompt::system_prompt(session);
    let resume = session.cli_session_id.lock().unwrap().clone();

    let mut runner = session.runner.lock().await;
    if runner.turn.is_some() {
        return Err(AppError::Assistant(
            "The Assistant is still answering.".to_string(),
        ));
    }
    runner.next_turn += 1;
    let turn = runner.next_turn;

    match session.agent {
        AgentKind::Claude => {
            if runner.process.is_none() {
                let prompt_file;
                let prompt_arg = if batch_shim {
                    prompt_file = write_prompt_file(inner, session, &system_prompt)?;
                    PromptArg::File(&prompt_file)
                } else {
                    PromptArg::Inline(&system_prompt)
                };
                let authorization = format!("Bearer ${{{TOKEN_ENV}}}");
                let args = claude_args(
                    &mcp_url,
                    &authorization,
                    prompt_arg,
                    resume.as_deref(),
                    session.model_choice(),
                );
                let spawned = spawn(
                    inner,
                    session.agent,
                    &program,
                    &args,
                    &[(TOKEN_ENV, &session.token)],
                )
                .await?;
                start_process(
                    inner,
                    session,
                    &mut runner,
                    spawned,
                    ClaudeParser::default(),
                );
            }
            let line = json!({
                "type": "user",
                "message": { "role": "user", "content": text },
            })
            .to_string()
                + "\n";
            let written = match runner.process.as_mut().and_then(|p| p.stdin.as_mut()) {
                Some(stdin) => stdin
                    .write_all(line.as_bytes())
                    .await
                    .and(stdin.flush().await),
                None => Err(std::io::ErrorKind::BrokenPipe.into()),
            };
            if let Err(e) = written {
                runner.process = None;
                return Err(AppError::Assistant(format!(
                    "Couldn't reach Claude Code: {e}"
                )));
            }
        }
        AgentKind::Codex => {
            // Windows batch shims can't take the multi-line instructions as
            // an argument, so the first turn carries them instead.
            let (instructions, stdin_text) = if batch_shim {
                let text = if resume.is_none() {
                    format!("{system_prompt}\n\n{text}")
                } else {
                    text
                };
                (None, text)
            } else {
                (Some(system_prompt.as_str()), text)
            };
            let args = codex_args(
                &inner.workdir,
                &mcp_url,
                instructions,
                resume.as_deref(),
                session.model_choice(),
            );
            let mut spawned = spawn(
                inner,
                session.agent,
                &program,
                &args,
                &[(TOKEN_ENV, &session.token)],
            )
            .await?;
            let written = spawned
                .stdin
                .write_all(stdin_text.as_bytes())
                .await
                .and(spawned.stdin.shutdown().await);
            if let Err(e) = written {
                return Err(AppError::Assistant(format!("Couldn't reach Codex: {e}")));
            }
            start_process(inner, session, &mut runner, spawned, CodexParser::new());
            // stdin must close for Codex to start; drop it now.
            if let Some(process) = runner.process.as_mut() {
                process.stdin = None;
            }
        }
    }
    runner.turn = Some(turn);
    Ok(())
}

fn write_prompt_file(inner: &Inner, session: &AgentSession, prompt: &str) -> AppResult<PathBuf> {
    // Beside the working folder, not in it, so the agent doesn't see it.
    let dir = inner
        .workdir
        .parent()
        .map(|p| p.join("assistant-prompts"))
        .unwrap_or_else(|| inner.workdir.join("..").join("assistant-prompts"));
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(format!("{}.txt", session.id));
    std::fs::write(&path, prompt)?;
    Ok(path)
}

fn start_process(
    inner: &Arc<Inner>,
    session: &Arc<AgentSession>,
    runner: &mut Runner,
    spawned: Spawned,
    parser: impl LineParser,
) {
    runner.next_generation += 1;
    let generation = runner.next_generation;
    runner.process = Some(Process {
        generation,
        child: spawned.child,
        stdin: Some(spawned.stdin),
        stderr: spawned.stderr,
        stderr_task: spawned.stderr_task,
    });
    tokio::spawn(read_output(
        inner.clone(),
        session.clone(),
        generation,
        spawned.stdout,
        parser,
    ));
}

async fn read_output(
    inner: Arc<Inner>,
    session: Arc<AgentSession>,
    generation: u64,
    stdout: ChildStdout,
    mut parser: impl LineParser,
) {
    let mut lines = BufReader::new(stdout).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let parsed = parser.parse(&line);
        if parsed.is_empty() {
            continue;
        }
        let mut runner = session.runner.lock().await;
        if runner.process.as_ref().map(|p| p.generation) != Some(generation) {
            // Stopped or replaced: what's left of its output is stale.
            return;
        }
        for event in parsed {
            match event {
                Parsed::CliSession(id) => {
                    *session.cli_session_id.lock().unwrap() = Some(id.clone());
                    inner.emit(
                        EVENT,
                        &AssistantEvent::CliSession {
                            agent_session_id: session.id.clone(),
                            cli_session_id: id,
                        },
                    );
                }
                Parsed::Text {
                    block_id,
                    text,
                    done,
                } => inner.emit(
                    EVENT,
                    &AssistantEvent::Text {
                        agent_session_id: session.id.clone(),
                        block_id,
                        text,
                        done,
                    },
                ),
                Parsed::TurnEnd { error } => {
                    if runner.turn.take().is_some() {
                        inner.emit(
                            EVENT,
                            &AssistantEvent::TurnEnd {
                                agent_session_id: session.id.clone(),
                                error,
                                stopped: false,
                            },
                        );
                    }
                }
            }
        }
    }

    // The process closed its output: it exited, or is about to.
    let (process, turn) = {
        let mut runner = session.runner.lock().await;
        if runner.process.as_ref().map(|p| p.generation) != Some(generation) {
            return;
        }
        (runner.process.take(), runner.turn.take())
    };
    let Some(mut process) = process else { return };
    let status = tokio::time::timeout(Duration::from_secs(5), process.child.wait()).await;
    let _ = tokio::time::timeout(Duration::from_secs(1), &mut process.stderr_task).await;
    let name = session.agent.display_name();
    let exit = match &status {
        Ok(Ok(status)) => status.to_string(),
        Ok(Err(e)) => format!("unknown status: {e}"),
        Err(_) => "still running after 5 s".to_string(),
    };
    if turn.is_none() {
        log::info!("{name} exited ({exit}); conversation {}", session.id);
        return;
    }
    let stderr = String::from_utf8_lossy(&process.stderr.lock().unwrap())
        .trim()
        .to_string();
    let error = parser
        .last_error()
        .or_else(|| (!stderr.is_empty()).then(|| stderr.clone()))
        .unwrap_or_else(|| match status {
            Ok(Ok(status)) => format!("{name} stopped unexpectedly ({status})."),
            _ => format!("{name} stopped unexpectedly."),
        });
    // The CLI's own error (an API error, a crash message), cut short; the
    // conversation itself stays out of the log.
    log::warn!(
        "{name} exited mid-turn ({exit}); conversation {}: {}",
        session.id,
        error.chars().take(500).collect::<String>()
    );
    inner.emit(
        EVENT,
        &AssistantEvent::TurnEnd {
            agent_session_id: session.id.clone(),
            error: Some(error),
            stopped: false,
        },
    );
}

/// Ends the running turn, if any: kills the process and denies what the
/// session is waiting on. `closing` also ends an idle Claude process.
pub(crate) async fn stop(inner: &Arc<Inner>, session: &Arc<AgentSession>, closing: bool) {
    let (turn, process) = {
        let mut runner = session.runner.lock().await;
        let turn = runner.turn.take();
        let process = if turn.is_some() || closing {
            runner.process.take()
        } else {
            None
        };
        (turn, process)
    };
    if let Some(mut process) = process {
        log::info!(
            "stopping {}; conversation {}",
            session.agent.display_name(),
            session.id
        );
        let _ = process.child.start_kill();
        tokio::spawn(async move {
            let _ = process.child.wait().await;
        });
    }
    inner.close_approvals(&session.id);
    if turn.is_some() {
        inner.emit(
            EVENT,
            &AssistantEvent::TurnEnd {
                agent_session_id: session.id.clone(),
                error: None,
                stopped: true,
            },
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed(parser: &mut impl LineParser, lines: &[&str]) -> Vec<Parsed> {
        lines.iter().flat_map(|l| parser.parse(l)).collect()
    }

    fn text(block_id: &str, text: &str, done: bool) -> Parsed {
        Parsed::Text {
            block_id: block_id.to_string(),
            text: text.to_string(),
            done,
        }
    }

    #[test]
    fn parses_claude_stream_json() {
        let mut parser = ClaudeParser::default();
        let events = feed(
            &mut parser,
            &[
                r#"{"type":"system","subtype":"init","session_id":"5a1c","tools":[],"mcp_servers":[{"name":"postgres_studio","status":"connected"}]}"#,
                r#"{"type":"stream_event","event":{"type":"message_start","message":{"id":"msg_1","content":[]}},"session_id":"5a1c"}"#,
                r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}}"#,
                r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hmm"}}}"#,
                r#"{"type":"stream_event","event":{"type":"content_block_stop","index":0}}"#,
                r#"{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}}"#,
                r#"{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"The orders"}}}"#,
                r#"{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":" collection"}}}"#,
                r#"{"type":"assistant","message":{"id":"msg_1","content":[{"type":"text","text":"The orders collection"}]}}"#,
                r#"{"type":"stream_event","event":{"type":"content_block_stop","index":1}}"#,
                r#"{"type":"stream_event","event":{"type":"message_stop"}}"#,
                r#"not json"#,
                r#"{"type":"result","subtype":"success","is_error":false,"result":"The orders collection","session_id":"5a1c"}"#,
            ],
        );
        assert_eq!(
            events,
            [
                Parsed::CliSession("5a1c".to_string()),
                text("msg_1-1", "The orders", false),
                text("msg_1-1", "The orders collection", false),
                text("msg_1-1", "The orders collection", true),
                Parsed::TurnEnd { error: None },
            ]
        );
    }

    #[test]
    fn claude_whole_messages_and_errors() {
        let mut parser = ClaudeParser::default();
        let events = feed(
            &mut parser,
            &[
                r#"{"type":"assistant","message":{"id":"msg_2","content":[{"type":"tool_use","name":"x"},{"type":"text","text":"Done."}]}}"#,
                r#"{"type":"result","subtype":"success","is_error":true,"result":"Not logged in · Please run /login"}"#,
                r#"{"type":"result","subtype":"error_max_turns","is_error":true}"#,
            ],
        );
        assert_eq!(
            events,
            [
                text("msg_2-1", "Done.", true),
                Parsed::TurnEnd {
                    error: Some("Not logged in · Please run /login".to_string())
                },
                Parsed::TurnEnd {
                    error: Some("error_max_turns".to_string())
                },
            ]
        );
    }

    #[test]
    fn parses_codex_json() {
        let mut parser = CodexParser::new();
        let p = parser.prefix.clone();
        let events = feed(
            &mut parser,
            &[
                r#"{"type":"thread.started","thread_id":"0199a213-81c0-7800-8aa1-bbab2a035a53"}"#,
                r#"{"type":"turn.started"}"#,
                r#"{"type":"item.started","item":{"id":"item_0","type":"mcp_tool_call","server":"postgres_studio","tool":"sample_schema","status":"in_progress"}}"#,
                r#"{"type":"item.completed","item":{"id":"item_1","type":"reasoning","text":"thinking"}}"#,
                r#"{"type":"item.updated","item":{"id":"item_2","type":"agent_message","text":"Orders has"}}"#,
                r#"{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"Orders has 12 fields."}}"#,
                r#"{"type":"error","message":"Reconnecting... 1/5"}"#,
                r#"{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}"#,
            ],
        );
        assert_eq!(
            events,
            [
                Parsed::CliSession("0199a213-81c0-7800-8aa1-bbab2a035a53".to_string()),
                text(&format!("{p}-item_2"), "Orders has", false),
                text(&format!("{p}-item_2"), "Orders has 12 fields.", true),
                Parsed::TurnEnd { error: None },
            ]
        );
        assert_eq!(parser.last_error().as_deref(), Some("Reconnecting... 1/5"));

        let failed = CodexParser::new()
            .parse(r#"{"type":"turn.failed","error":{"message":"You've hit your usage limit."}}"#);
        assert_eq!(
            api_error_message(
                r#"{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The 'gpt-x' model is not supported."}}"#
            ),
            "The 'gpt-x' model is not supported."
        );
        assert_eq!(
            failed,
            [Parsed::TurnEnd {
                error: Some("You've hit your usage limit.".to_string())
            }]
        );
    }

    #[test]
    fn claude_arguments() {
        let args = claude_args(
            "http://127.0.0.1:4000/mcp",
            "Bearer ${POSTGRES_STUDIO_MCP_TOKEN}",
            PromptArg::Inline("be brief"),
            Some("5a1c"),
            ModelChoice {
                model: Some("haiku"),
                effort: Some("low"),
            },
        );
        let joined = args.join(" ");
        assert!(joined.starts_with(
            "-p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --tools  --strict-mcp-config --mcp-config "
        ));
        let config: Value = serde_json::from_str(&args[11]).unwrap();
        assert_eq!(
            config["mcpServers"]["postgres_studio"],
            json!({ "type": "http", "url": "http://127.0.0.1:4000/mcp", "headers": { "Authorization": "Bearer ${POSTGRES_STUDIO_MCP_TOKEN}" } })
        );
        let pairs: Vec<(&str, &str)> = args
            .windows(2)
            .map(|w| (w[0].as_str(), w[1].as_str()))
            .collect();
        for expected in [
            ("--tools", ""),
            ("--allowedTools", "mcp__postgres_studio"),
            ("--setting-sources", ""),
            ("--permission-prompts", "none"),
            ("--append-system-prompt", "be brief"),
            ("--resume", "5a1c"),
            ("--model", "haiku"),
            ("--effort", "low"),
        ] {
            assert!(
                pairs.contains(&expected),
                "missing {expected:?} in {args:?}"
            );
        }
        let fresh = claude_args(
            "u",
            "a",
            PromptArg::File(Path::new("/p.txt")),
            None,
            ModelChoice::default(),
        );
        assert!(!fresh.contains(&"--resume".to_string()));
        assert!(
            !fresh.contains(&"--model".to_string()) && !fresh.contains(&"--effort".to_string())
        );
        assert!(fresh
            .windows(2)
            .any(|w| w[0] == "--append-system-prompt-file" && w[1] == "/p.txt"));
    }

    #[test]
    fn codex_arguments() {
        let workdir = Path::new("/data/assistant");
        let first = codex_args(
            workdir,
            "http://127.0.0.1:4000/mcp",
            Some("line one\n\"two\""),
            None,
            ModelChoice {
                model: Some("gpt-6-luna"),
                effort: Some("medium"),
            },
        );
        assert_eq!(
            &first[..5],
            [
                "exec",
                "--json",
                "--skip-git-repo-check",
                "--ignore-user-config",
                "--ignore-rules"
            ]
        );
        let pairs: Vec<(&str, &str)> = first
            .windows(2)
            .map(|w| (w[0].as_str(), w[1].as_str()))
            .collect();
        for expected in [
            ("-C", "/data/assistant"),
            ("-s", "read-only"),
            ("-c", "approval_policy=\"never\""),
            ("--disable", "shell_tool"),
            ("--disable", "unified_exec"),
            ("-c", "web_search=\"disabled\""),
            ("-c", "skills.include_instructions=false"),
            (
                "-c",
                "mcp_servers.postgres_studio.url=\"http://127.0.0.1:4000/mcp\"",
            ),
            (
                "-c",
                "mcp_servers.postgres_studio.bearer_token_env_var=\"POSTGRES_STUDIO_MCP_TOKEN\"",
            ),
            ("-c", "developer_instructions=\"line one\\n\\\"two\\\"\""),
            ("-m", "gpt-6-luna"),
            ("-c", "model_reasoning_effort=\"medium\""),
        ] {
            assert!(
                pairs.contains(&expected),
                "missing {expected:?} in {first:?}"
            );
        }
        assert_eq!(first.last().unwrap(), "-");

        let later = codex_args(workdir, "u", None, Some("thread-1"), ModelChoice::default());
        assert!(!later.contains(&"-m".to_string()));
        assert_eq!(&later[..2], ["exec", "resume"]);
        assert!(!later.contains(&"-C".to_string()) && !later.contains(&"-s".to_string()));
        assert!(later.contains(&"sandbox_mode=\"read-only\"".to_string()));
        assert!(!later
            .iter()
            .any(|a| a.starts_with("developer_instructions")));
        assert_eq!(&later[later.len() - 2..], ["thread-1", "-"]);
    }

    /// Drives the Claude runner against a fake `claude` script: no model,
    /// no account.
    #[cfg(unix)]
    #[tokio::test]
    async fn claude_runner_lifecycle_with_a_fake_cli() {
        use super::super::test_support::{inner_with, session, RecordingHost};
        use super::super::AssistantPolicy;
        use std::os::unix::fs::PermissionsExt;

        let dir = std::env::temp_dir().join(format!("postgres-studio-fake-cli-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("claude");
        std::fs::write(
            &script,
            r#"#!/bin/sh
printf '%s\n' "--spawn--" "$@" >> "$0.args"
n=0
while IFS= read -r line; do
  n=$((n+1))
  case "$line" in
    *hang*) sleep 30 ;;
    *die*) echo "boom: lost the connection" >&2; exit 3 ;;
    *) printf '%s\n' '{"type":"system","subtype":"init","session_id":"S1"}' \
         "{\"type\":\"assistant\",\"message\":{\"id\":\"m$$-$n\",\"content\":[{\"type\":\"text\",\"text\":\"hi\"}]}}" \
         '{"type":"result","subtype":"success","is_error":false,"result":"hi"}' ;;
  esac
done
"#,
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();

        let host = Arc::new(RecordingHost::default());
        let session = session("shop", "c1");
        let inner = inner_with(host.clone(), &session, AssistantPolicy::default());
        inner
            .binaries
            .lock()
            .unwrap()
            .insert(AgentKind::Claude, script.clone());

        let turn_ends = |n: usize| {
            let host = host.clone();
            async move {
                for _ in 0..500 {
                    let ends: Vec<Value> = host
                        .events_named(EVENT)
                        .into_iter()
                        .filter(|e| e["type"] == "turn-end")
                        .collect();
                    if ends.len() >= n {
                        return ends;
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
                panic!("expected {n} turn-end events");
            }
        };

        send(&inner, &session, "hello".into()).await.unwrap();
        assert_eq!(turn_ends(1).await[0]["error"], Value::Null);
        assert_eq!(
            session.cli_session_id.lock().unwrap().as_deref(),
            Some("S1")
        );
        send(&inner, &session, "again".into()).await.unwrap();
        turn_ends(2).await;

        send(&inner, &session, "hang".into()).await.unwrap();
        assert!(send(&inner, &session, "busy".into()).await.is_err());
        stop(&inner, &session, false).await;
        let ends = turn_ends(3).await;
        assert_eq!(ends[2]["stopped"], true);

        send(&inner, &session, "after".into()).await.unwrap();
        let ends = turn_ends(4).await;
        assert_eq!(ends[3]["error"], Value::Null);
        assert_eq!(ends.len(), 4, "one turn-end per turn");

        send(&inner, &session, "die".into()).await.unwrap();
        let ends = turn_ends(5).await;
        let error = ends[4]["error"].as_str().unwrap();
        assert!(error.contains("boom: lost the connection"), "{error}");

        let texts: Vec<Value> = host
            .events_named(EVENT)
            .into_iter()
            .filter(|e| e["type"] == "text")
            .collect();
        assert_eq!(texts.len(), 3);
        assert!(texts.iter().all(|t| t["done"] == true && t["text"] == "hi"));

        let args = std::fs::read_to_string(dir.join("claude.args")).unwrap();
        let spawns: Vec<&str> = args.split("--spawn--\n").skip(1).collect();
        assert_eq!(
            spawns.len(),
            2,
            "one process until the stop, then a resumed one"
        );
        assert!(!spawns[0].contains("--resume"));
        assert!(spawns[1].contains("--resume\nS1\n"));
        stop(&inner, &session, true).await;
        std::fs::remove_dir_all(dir).ok();
    }
}
