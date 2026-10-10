use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

use serde::Serialize;
use uuid::Uuid;

use crate::error::{AppError, AppResult};

/// Folder under the user's home that receives scripts saved without picking
/// a location.
const DEFAULT_DIR_NAME: &str = "postgres-studio-scripts";
const SCRIPT_EXTENSION: &str = "sql";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedScript {
    pub path: String,
    pub name: String,
    /// Milliseconds since the Unix epoch; the sidebar lists newest first.
    pub modified_ms: u64,
}

/// Console scripts saved to disk. Files can live anywhere the user chose, so
/// every saved path is remembered in a small registry next to the other
/// config files; `list` also picks up scripts dropped into the default
/// folder by hand.
pub struct SavedScriptsStore {
    registry_path: PathBuf,
    default_dir: PathBuf,
    paths: Mutex<Vec<PathBuf>>,
}

impl SavedScriptsStore {
    pub fn load(config_dir: &Path, home_dir: &Path) -> AppResult<Self> {
        fs::create_dir_all(config_dir)?;
        let registry_path = config_dir.join("saved_scripts.json");
        let paths = if registry_path.exists() {
            let raw = fs::read_to_string(&registry_path)?;
            // A corrupt registry only loses the list, never the scripts
            // themselves, so start over rather than refuse to launch.
            serde_json::from_str(&raw).unwrap_or_default()
        } else {
            Vec::new()
        };
        Ok(Self {
            registry_path,
            default_dir: home_dir.join(DEFAULT_DIR_NAME),
            paths: Mutex::new(paths),
        })
    }

    /// A fresh, randomly named path in the default folder, creating the
    /// folder so a save dialog can open inside it.
    pub fn suggest_path(&self) -> AppResult<PathBuf> {
        fs::create_dir_all(&self.default_dir)?;
        let short_id = Uuid::new_v4().simple().to_string();
        Ok(self
            .default_dir
            .join(format!("script-{}.{SCRIPT_EXTENSION}", &short_id[..8])))
    }

    /// Writes `content` to `path`, or to a new randomly named file in the
    /// default folder when no path is given, and remembers the file.
    pub fn save(&self, path: Option<&str>, content: &str) -> AppResult<SavedScript> {
        let mut path = match path {
            Some(p) if !p.trim().is_empty() => PathBuf::from(p),
            _ => self.suggest_path()?,
        };
        if path.extension().is_none() {
            path.set_extension(SCRIPT_EXTENSION);
        }
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&path, content)?;

        let mut paths = self.paths.lock().unwrap();
        if !paths.contains(&path) {
            paths.push(path.clone());
            self.persist(&paths)?;
        }
        describe(&path)
    }

    /// Every remembered script that still exists, plus any `.sql` file in the
    /// default folder, newest first.
    pub fn list(&self) -> AppResult<Vec<SavedScript>> {
        let mut candidates = self.paths.lock().unwrap().clone();
        if let Ok(entries) = fs::read_dir(&self.default_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                let is_script = path.extension().is_some_and(|e| e == SCRIPT_EXTENSION);
                if is_script && path.is_file() && !candidates.contains(&path) {
                    candidates.push(path);
                }
            }
        }
        let mut scripts: Vec<SavedScript> = candidates
            .iter()
            .filter(|p| p.is_file())
            .filter_map(|p| describe(p).ok())
            .collect();
        scripts.sort_by_key(|s| std::cmp::Reverse(s.modified_ms));
        Ok(scripts)
    }

    /// Reads a script back. Only files this store lists can be read, so the
    /// command can't be used to read arbitrary files off disk.
    pub fn read(&self, path: &str) -> AppResult<String> {
        let known = self.list()?.into_iter().any(|s| s.path == path);
        if !known {
            return Err(AppError::NotFound(format!("saved script {path}")));
        }
        Ok(fs::read_to_string(path)?)
    }

    fn persist(&self, paths: &[PathBuf]) -> AppResult<()> {
        let raw = serde_json::to_string_pretty(paths)
            .map_err(|e| AppError::InvalidInput(e.to_string()))?;
        fs::write(&self.registry_path, raw)?;
        Ok(())
    }
}

fn describe(path: &Path) -> AppResult<SavedScript> {
    let modified_ms = fs::metadata(path)?
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Ok(SavedScript {
        path: path.to_string_lossy().into_owned(),
        name: path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        modified_ms,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A config dir and a home dir, both unique to the test.
    fn store() -> (SavedScriptsStore, PathBuf) {
        let root = std::env::temp_dir().join(format!("postgres-studio-scripts-{}", Uuid::new_v4()));
        let store = SavedScriptsStore::load(&root.join("config"), &root.join("home")).unwrap();
        (store, root)
    }

    #[test]
    fn saves_without_a_path_into_the_default_folder() {
        let (store, root) = store();
        let saved = store.save(None, "db;").unwrap();
        let path = PathBuf::from(&saved.path);
        assert_eq!(
            path.parent().unwrap(),
            root.join("home").join(DEFAULT_DIR_NAME)
        );
        assert!(saved.name.starts_with("script-") && saved.name.ends_with(".sql"));
        assert_eq!(fs::read_to_string(&path).unwrap(), "db;");
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn adds_the_extension_when_the_chosen_name_has_none() {
        let (store, root) = store();
        let chosen = root.join("elsewhere").join("report");
        let saved = store.save(Some(chosen.to_str().unwrap()), "1;").unwrap();
        assert_eq!(saved.name, "report.sql");
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn lists_scripts_saved_anywhere_and_dropped_in_the_default_folder() {
        let (store, root) = store();
        let elsewhere = root.join("elsewhere").join("a.sql");
        store.save(Some(elsewhere.to_str().unwrap()), "a").unwrap();
        store.save(None, "b").unwrap();
        // a file put in the default folder by hand, never saved through us
        fs::write(
            root.join("home").join(DEFAULT_DIR_NAME).join("manual.sql"),
            "c",
        )
        .unwrap();

        let names: Vec<String> = store.list().unwrap().into_iter().map(|s| s.name).collect();
        assert_eq!(names.len(), 3);
        assert!(names.contains(&"a.sql".to_string()));
        assert!(names.contains(&"manual.sql".to_string()));
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn saving_the_same_file_twice_lists_it_once_and_survives_a_reload() {
        let (store, root) = store();
        let path = root.join("elsewhere").join("same.sql");
        store.save(Some(path.to_str().unwrap()), "v1").unwrap();
        store.save(Some(path.to_str().unwrap()), "v2").unwrap();
        assert_eq!(store.list().unwrap().len(), 1);

        let reloaded = SavedScriptsStore::load(&root.join("config"), &root.join("home")).unwrap();
        let listed = reloaded.list().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(reloaded.read(&listed[0].path).unwrap(), "v2");
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn deleted_files_drop_out_of_the_list() {
        let (store, root) = store();
        let saved = store.save(None, "x").unwrap();
        fs::remove_file(&saved.path).unwrap();
        assert!(store.list().unwrap().is_empty());
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn refuses_to_read_files_it_does_not_know() {
        let (store, root) = store();
        let stray = root.join("stray.sql");
        fs::create_dir_all(&root).unwrap();
        fs::write(&stray, "secret").unwrap();
        assert!(store.read(stray.to_str().unwrap()).is_err());
        fs::remove_dir_all(root).ok();
    }
}
