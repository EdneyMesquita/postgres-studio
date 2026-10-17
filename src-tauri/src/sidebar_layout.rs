use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::error::{AppError, AppResult};

/// The sidebar's folders and the order of the connections in them.
///
/// Kept as the frontend's own JSON document: only the frontend interprets
/// the tree, and it reconciles it with the saved connections on load, so
/// this store just keeps the document safe on disk next to the other
/// config files.
pub struct SidebarLayoutStore {
    path: PathBuf,
}

impl SidebarLayoutStore {
    pub fn load(config_dir: &Path) -> AppResult<Self> {
        fs::create_dir_all(config_dir)?;
        Ok(Self {
            path: config_dir.join("sidebar_layout.json"),
        })
    }

    /// The saved layout, or null when there is none yet. A corrupt file also
    /// reads as null: the frontend rebuilds a flat layout from the saved
    /// connections, so nothing is lost but the folders.
    pub fn get(&self) -> AppResult<Value> {
        if !self.path.exists() {
            return Ok(Value::Null);
        }
        let raw = fs::read_to_string(&self.path)?;
        Ok(serde_json::from_str(&raw).unwrap_or(Value::Null))
    }

    /// Writes the layout to a temporary file and renames it into place, so
    /// a crash mid-write can't leave a half-written layout behind.
    pub fn save(&self, layout: &Value) -> AppResult<()> {
        let raw = serde_json::to_string_pretty(layout)
            .map_err(|e| AppError::InvalidInput(e.to_string()))?;
        let tmp = self.path.with_extension("json.tmp");
        fs::write(&tmp, raw)?;
        fs::rename(&tmp, &self.path)?;
        Ok(())
    }
}

/// The folder each connection sits in, as "Parent / Child", keyed by
/// connection id; connections at the top level are left out.
pub fn folder_paths(layout: &Value) -> HashMap<String, String> {
    fn walk(nodes: &Value, parent: Option<&str>, out: &mut HashMap<String, String>) {
        for node in nodes.as_array().into_iter().flatten() {
            let Some(id) = node.get("id").and_then(Value::as_str) else {
                continue;
            };
            match node.get("type").and_then(Value::as_str) {
                Some("connection") => {
                    if let Some(path) = parent {
                        out.insert(id.to_string(), path.to_string());
                    }
                }
                Some("folder") => {
                    let name = node.get("name").and_then(Value::as_str).unwrap_or_default();
                    let path = match parent {
                        Some(parent) => format!("{parent} / {name}"),
                        None => name.to_string(),
                    };
                    walk(
                        node.get("children").unwrap_or(&Value::Null),
                        Some(&path),
                        out,
                    );
                }
                _ => {}
            }
        }
    }
    let mut out = HashMap::new();
    walk(layout.get("root").unwrap_or(&Value::Null), None, &mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn store() -> (SidebarLayoutStore, PathBuf) {
        let dir =
            std::env::temp_dir().join(format!("postgres-studio-layout-{}", uuid::Uuid::new_v4()));
        (SidebarLayoutStore::load(&dir).unwrap(), dir)
    }

    #[test]
    fn reads_null_before_anything_is_saved() {
        let (store, dir) = store();
        assert_eq!(store.get().unwrap(), Value::Null);
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn round_trips_the_document_without_leaving_the_temp_file() {
        let (store, dir) = store();
        let layout = json!({ "version": 1, "root": [
            { "type": "folder", "id": "f1", "name": "Prod", "children": [
                { "type": "connection", "id": "c1" }
            ] }
        ] });

        store.save(&layout).unwrap();

        assert_eq!(store.get().unwrap(), layout);
        assert!(!dir.join("sidebar_layout.json.tmp").exists());
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn names_the_folder_path_of_each_connection() {
        let layout = json!({ "version": 1, "root": [
            { "type": "connection", "id": "top" },
            { "type": "folder", "id": "f1", "name": "Remote", "children": [
                { "type": "connection", "id": "c1" },
                { "type": "folder", "id": "f2", "name": "EU", "children": [
                    { "type": "connection", "id": "c2" }
                ] }
            ] }
        ] });
        let paths = folder_paths(&layout);
        assert_eq!(paths.get("c1").map(String::as_str), Some("Remote"));
        assert_eq!(paths.get("c2").map(String::as_str), Some("Remote / EU"));
        assert!(!paths.contains_key("top"));
        assert!(folder_paths(&Value::Null).is_empty());
    }

    #[test]
    fn a_corrupt_file_reads_as_null() {
        let (store, dir) = store();
        fs::write(dir.join("sidebar_layout.json"), "{ not json").unwrap();
        assert_eq!(store.get().unwrap(), Value::Null);
        fs::remove_dir_all(dir).ok();
    }
}
