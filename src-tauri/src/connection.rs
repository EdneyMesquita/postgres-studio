use std::fs;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::models::ConnectionProfile;

/// CRUD store for non-secret connection profile metadata, persisted as a
/// single JSON file. Small enough (dozens of profiles, not thousands) that
/// read-whole/rewrite-whole is simpler than a real database and fine perf-wise.
pub struct ConnectionStore {
    path: PathBuf,
    profiles: RwLock<Vec<ConnectionProfile>>,
}

impl ConnectionStore {
    pub fn load(config_dir: &Path) -> AppResult<Self> {
        fs::create_dir_all(config_dir)?;
        let path = config_dir.join("connections.json");
        let profiles = if path.exists() {
            let raw = fs::read_to_string(&path)?;
            serde_json::from_str(&raw)
                .map_err(|e| AppError::InvalidInput(format!("connections.json is corrupt: {e}")))?
        } else {
            Vec::new()
        };
        Ok(Self {
            path,
            profiles: RwLock::new(profiles),
        })
    }

    fn persist(&self, profiles: &[ConnectionProfile]) -> AppResult<()> {
        let raw = serde_json::to_string_pretty(profiles)
            .map_err(|e| AppError::InvalidInput(e.to_string()))?;
        fs::write(&self.path, raw)?;
        Ok(())
    }

    pub fn list(&self) -> Vec<ConnectionProfile> {
        self.profiles.read().unwrap().clone()
    }

    pub fn get(&self, id: &str) -> AppResult<ConnectionProfile> {
        self.profiles
            .read()
            .unwrap()
            .iter()
            .find(|p| p.id == id)
            .cloned()
            .ok_or_else(|| AppError::NotFound(format!("connection profile {id}")))
    }

    /// Inserts a new profile (when `profile.id` is empty) or replaces an
    /// existing one, then persists. Returns the profile with its id set.
    pub fn upsert(&self, mut profile: ConnectionProfile) -> AppResult<ConnectionProfile> {
        if profile.id.is_empty() {
            profile.id = Uuid::new_v4().to_string();
        }
        let mut profiles = self.profiles.write().unwrap();
        match profiles.iter_mut().find(|p| p.id == profile.id) {
            Some(existing) => *existing = profile.clone(),
            None => profiles.push(profile.clone()),
        }
        self.persist(&profiles)?;
        Ok(profile)
    }

    pub fn delete(&self, id: &str) -> AppResult<()> {
        let mut profiles = self.profiles.write().unwrap();
        let before = profiles.len();
        profiles.retain(|p| p.id != id);
        if profiles.len() == before {
            return Err(AppError::NotFound(format!("connection profile {id}")));
        }
        self.persist(&profiles)?;
        Ok(())
    }
}

/// Strips `user:pass@` credentials out of a raw connection string so the
/// password never gets persisted to `connections.json`.
pub fn extract_uri_credentials(uri: &str) -> (String, Option<String>, Option<String>) {
    let Some(scheme_end) = uri.find("://") else {
        return (uri.to_string(), None, None);
    };
    let authority_start = scheme_end + 3;
    let rest = &uri[authority_start..];
    let Some(at_idx) = rest.find('@') else {
        return (uri.to_string(), None, None);
    };
    // Guard against an '@' that appears after the host (e.g. in a path/query).
    let host_boundary = rest.find(['/', '?']).unwrap_or(rest.len());
    if at_idx > host_boundary {
        return (uri.to_string(), None, None);
    }

    let userinfo = &rest[..at_idx];
    let after_at = &rest[at_idx + 1..];
    let stripped = format!("{}{}", &uri[..authority_start], after_at);

    match userinfo.split_once(':') {
        Some((user, pass)) => (
            stripped,
            Some(urlencoding::decode(user).unwrap_or_default().into_owned()),
            Some(urlencoding::decode(pass).unwrap_or_default().into_owned()),
        ),
        None => (
            stripped,
            Some(
                urlencoding::decode(userinfo)
                    .unwrap_or_default()
                    .into_owned(),
            ),
            None,
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loads_profiles_saved_before_colors_existed() {
        let dir = std::env::temp_dir().join(format!("postgres-studio-store-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("connections.json"),
            r#"[{
                "id": "old",
                "name": "Old",
                "source": { "kind": "uri", "uri": "postgres://localhost:5432" },
                "database": null,
                "username": null,
                "hasPassword": false,
                "tls": {
                    "enabled": false, "caFile": null, "certKeyFile": null,
                    "certKeyHasPassphrase": false,
                    "allowInvalidCertificates": false, "allowInvalidHostnames": false
                },
                "sshTunnel": null,
                "advanced": {
                    "appName": null, "connectTimeoutMs": null,
                    "serverSelectionTimeoutMs": null, "maxPoolSize": null,
                    "minPoolSize": null, "replicaSet": null, "readPreference": null,
                    "retryWrites": null, "directConnection": null,
                    "authMechanism": null, "authSource": null
                },
                "createdAt": "1",
                "updatedAt": "1"
            }]"#,
        )
        .unwrap();

        let store = ConnectionStore::load(&dir).unwrap();

        let profile = store.get("old").unwrap();
        assert_eq!(profile.name, "Old");
        assert_eq!(profile.color, None);
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn extracts_credentials_from_a_uri() {
        let uri =
            "postgresql://exampleuser:examplepass@db.example.net:5432/mydb?application_name=x";
        let (stripped, user, pass) = extract_uri_credentials(uri);
        assert_eq!(user.as_deref(), Some("exampleuser"));
        assert_eq!(pass.as_deref(), Some("examplepass"));
        assert_eq!(
            stripped,
            "postgresql://db.example.net:5432/mydb?application_name=x"
        );
    }

    #[test]
    fn leaves_uri_without_credentials_untouched() {
        let uri = "postgres://localhost:5432/test";
        let (stripped, user, pass) = extract_uri_credentials(uri);
        assert_eq!(stripped, uri);
        assert!(user.is_none());
        assert!(pass.is_none());
    }
}
