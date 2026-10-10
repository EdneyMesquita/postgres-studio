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
    fn a_corrupt_file_reads_as_null() {
        let (store, dir) = store();
        fs::write(dir.join("sidebar_layout.json"), "{ not json").unwrap();
        assert_eq!(store.get().unwrap(), Value::Null);
        fs::remove_dir_all(dir).ok();
    }
}
