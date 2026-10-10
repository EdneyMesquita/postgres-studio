//! The models each agent can run, and the one the user set up for the CLI.
//!
//! The agents run with their user configuration ignored (no settings files,
//! hooks or other MCP servers), so the model the user picked for the CLI has
//! to be read here and passed explicitly. Codex keeps the models the account
//! can use in `models_cache.json`; Claude Code takes aliases that follow the
//! latest model of each family, or any full model name.

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

use super::detect::home_dir;
use super::AgentKind;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentModel {
    /// What the CLI takes: an alias or a model name.
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    /// Effort levels the model takes; empty means the agent's own list.
    pub efforts: Vec<String>,
    pub default_effort: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentModels {
    pub models: Vec<AgentModel>,
    /// Effort levels the CLI accepts.
    pub efforts: Vec<String>,
    /// The model set in the CLI's own configuration, used when the user
    /// picks "Default".
    pub default_model: Option<String>,
    pub default_effort: Option<String>,
}

const CLAUDE_ALIASES: [(&str, &str); 4] = [
    ("fable", "Fable"),
    ("opus", "Opus"),
    ("sonnet", "Sonnet"),
    ("haiku", "Haiku"),
];
const CLAUDE_EFFORTS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];
const CODEX_EFFORTS: [&str; 4] = ["low", "medium", "high", "xhigh"];

pub(crate) fn models_for(kind: AgentKind) -> AgentModels {
    match kind {
        AgentKind::Claude => claude_models(&claude_config_dir()),
        AgentKind::Codex => codex_models(&codex_home()),
    }
}

fn claude_config_dir() -> PathBuf {
    std::env::var_os("CLAUDE_CONFIG_DIR")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| home_dir().map(|h| h.join(".claude")))
        .unwrap_or_default()
}

fn codex_home() -> PathBuf {
    std::env::var_os("CODEX_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| home_dir().map(|h| h.join(".codex")))
        .unwrap_or_default()
}

fn claude_models(config_dir: &Path) -> AgentModels {
    let settings: Value = std::fs::read_to_string(config_dir.join("settings.json"))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or(Value::Null);
    let text = |key: &str| {
        settings
            .get(key)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    AgentModels {
        models: CLAUDE_ALIASES
            .iter()
            .map(|(id, name)| AgentModel {
                id: id.to_string(),
                name: name.to_string(),
                description: Some(format!("The latest {name} model")),
                efforts: Vec::new(),
                default_effort: None,
            })
            .collect(),
        efforts: CLAUDE_EFFORTS.iter().map(|e| e.to_string()).collect(),
        default_model: text("model").filter(|m| valid_model(m)),
        default_effort: text("effortLevel").filter(|e| valid_effort(e)),
    }
}

fn codex_models(home: &Path) -> AgentModels {
    let cache: Value = std::fs::read_to_string(home.join("models_cache.json"))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or(Value::Null);
    let mut listed: Vec<(i64, AgentModel)> = cache
        .get("models")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|m| m.get("visibility").and_then(Value::as_str) == Some("list"))
        .filter_map(|m| {
            let id = m.get("slug").and_then(Value::as_str)?.to_string();
            if !valid_model(&id) {
                return None;
            }
            let efforts = m
                .get("supported_reasoning_levels")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|l| l.get("effort").and_then(Value::as_str))
                .filter(|e| valid_effort(e))
                .map(str::to_string)
                .collect();
            let model = AgentModel {
                name: m
                    .get("display_name")
                    .and_then(Value::as_str)
                    .unwrap_or(&id)
                    .to_string(),
                description: m
                    .get("description")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                efforts,
                default_effort: m
                    .get("default_reasoning_level")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                id,
            };
            let priority = m
                .get("priority")
                .and_then(Value::as_i64)
                .unwrap_or(i64::MAX);
            Some((priority, model))
        })
        .collect();
    listed.sort_by_key(|(priority, _)| *priority);

    let config = std::fs::read_to_string(home.join("config.toml")).unwrap_or_default();
    AgentModels {
        models: listed.into_iter().map(|(_, m)| m).collect(),
        efforts: CODEX_EFFORTS.iter().map(|e| e.to_string()).collect(),
        default_model: toml_top_level(&config, "model").filter(|m| valid_model(m)),
        default_effort: toml_top_level(&config, "model_reasoning_effort")
            .filter(|e| valid_effort(e)),
    }
}

/// A top-level string setting of a TOML file (before any `[table]`), which
/// is where Codex keeps `model` and `model_reasoning_effort`.
fn toml_top_level(text: &str, key: &str) -> Option<String> {
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            return None;
        }
        let Some((k, v)) = line.split_once('=') else {
            continue;
        };
        if k.trim() != key {
            continue;
        }
        let v = v.split('#').next().unwrap_or_default().trim();
        let unquoted = v
            .strip_prefix('"')
            .and_then(|s| s.strip_suffix('"'))
            .or_else(|| v.strip_prefix('\'').and_then(|s| s.strip_suffix('\'')))?;
        return Some(unquoted.to_string()).filter(|s| !s.is_empty());
    }
    None
}

/// A model name safe to pass as one argument: letters, digits and the
/// punctuation model ids use, never starting like a flag.
pub(crate) fn valid_model(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 100
        && !s.starts_with('-')
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || "._:/[]-@".contains(c))
}

pub(crate) fn valid_effort(s: &str) -> bool {
    !s.is_empty() && s.len() <= 16 && s.chars().all(|c| c.is_ascii_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "postgres-studio-models-{name}-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn claude_lists_aliases_and_reads_the_configured_model() {
        let dir = temp_dir("claude");
        std::fs::write(
            dir.join("settings.json"),
            r#"{ "model": "opus[1m]", "effortLevel": "high" }"#,
        )
        .unwrap();
        let models = claude_models(&dir);
        assert_eq!(
            models
                .models
                .iter()
                .map(|m| m.id.as_str())
                .collect::<Vec<_>>(),
            ["fable", "opus", "sonnet", "haiku"]
        );
        assert_eq!(models.default_model.as_deref(), Some("opus[1m]"));
        assert_eq!(models.default_effort.as_deref(), Some("high"));

        let empty = claude_models(&temp_dir("claude-empty"));
        assert_eq!(empty.default_model, None);
        assert_eq!(empty.models.len(), 4);
    }

    #[test]
    fn codex_lists_the_cached_models_in_order() {
        let dir = temp_dir("codex");
        std::fs::write(
            dir.join("models_cache.json"),
            r#"{ "models": [
                { "slug": "gpt-b", "display_name": "GPT-B", "visibility": "list", "priority": 2,
                  "supported_reasoning_levels": [{ "effort": "low" }, { "effort": "high" }] },
                { "slug": "hidden", "visibility": "hide", "priority": 0 },
                { "slug": "gpt-a", "display_name": "GPT-A", "description": "Fast", "visibility": "list",
                  "priority": 1, "default_reasoning_level": "medium" }
            ] }"#,
        )
        .unwrap();
        std::fs::write(
            dir.join("config.toml"),
            "model = \"gpt-b\"  # mine\nmodel_reasoning_effort = 'low'\n\n[profiles.x]\nmodel = \"other\"\n",
        )
        .unwrap();
        let models = codex_models(&dir);
        assert_eq!(
            models
                .models
                .iter()
                .map(|m| m.id.as_str())
                .collect::<Vec<_>>(),
            ["gpt-a", "gpt-b"]
        );
        assert_eq!(models.models[0].description.as_deref(), Some("Fast"));
        assert_eq!(models.models[1].efforts, ["low", "high"]);
        assert_eq!(models.default_model.as_deref(), Some("gpt-b"));
        assert_eq!(models.default_effort.as_deref(), Some("low"));

        let missing = codex_models(&temp_dir("codex-empty"));
        assert!(missing.models.is_empty() && missing.default_model.is_none());
    }

    #[test]
    fn model_names_that_could_act_as_flags_are_refused() {
        for ok in [
            "sonnet",
            "opus[1m]",
            "claude-fable-5-1",
            "gpt-6-astra",
            "org/model:v2",
        ] {
            assert!(valid_model(ok), "{ok}");
        }
        for bad in ["", "--tools", "a b", "x;rm", "é"] {
            assert!(!valid_model(bad), "{bad}");
        }
        assert!(valid_effort("xhigh") && !valid_effort("High") && !valid_effort("-x"));
    }
}
