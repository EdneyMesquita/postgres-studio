//! Import/export of connection profiles.
//!
//! Export writes the app's own JSON (`{"type": "Postgres Studio
//! Connections", "version": 1, "connections": [...]}`), which keeps every
//! option of a profile. Import reads that, and pgAdmin 4's `servers.json`
//! (File > Export servers in pgAdmin), whose passwords pgAdmin never
//! exports, so those come in without one.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::models::{
    ConnectionAdvancedOptions, ConnectionProfile, ConnectionProfileInput, ConnectionSource,
    SshAuthMethod, SshTunnelOptions, SslMode, TlsOptions, DEFAULT_PORT,
};
use crate::secrets::{SecretKind, SecretStore};

const FILE_TYPE: &str = "Postgres Studio Connections";
const FILE_VERSION: u32 = 1;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileEntry {
    name: String,
    #[serde(default)]
    color: Option<String>,
    source: ConnectionSource,
    #[serde(default)]
    database: Option<String>,
    #[serde(default)]
    username: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    password: Option<String>,
    #[serde(default)]
    tls: TlsOptions,
    #[serde(default)]
    ssh_tunnel: Option<SshTunnelOptions>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    ssh_password: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    ssh_key_passphrase: Option<String>,
    #[serde(default)]
    advanced: ConnectionAdvancedOptions,
}

#[derive(Debug, Serialize, Deserialize)]
struct ExportFile {
    #[serde(rename = "type")]
    file_type: String,
    version: u32,
    connections: Vec<serde_json::Value>,
}

/// Writes `profiles` to `dest_path`. With `include_secrets`, passwords and
/// passphrases are read from the secret store and written in plain text:
/// only the file gets them, never the frontend, and the UI says so.
pub fn export_connections(
    profiles: &[ConnectionProfile],
    include_secrets: bool,
    secrets: &dyn SecretStore,
    dest_path: &Path,
) -> AppResult<usize> {
    let secret = |id: &str, kind: SecretKind| -> AppResult<Option<String>> {
        if include_secrets {
            secrets.get(id, kind).map_err(AppError::Secret)
        } else {
            Ok(None)
        }
    };
    let mut connections = Vec::with_capacity(profiles.len());
    for p in profiles {
        let entry = FileEntry {
            name: p.name.clone(),
            color: p.color.clone(),
            source: p.source.clone(),
            database: p.database.clone(),
            username: p.username.clone(),
            password: if p.has_password {
                secret(&p.id, SecretKind::Password)?
            } else {
                None
            },
            tls: p.tls.clone(),
            ssh_tunnel: p.ssh_tunnel.clone(),
            ssh_password: secret(&p.id, SecretKind::SshPassword)?,
            ssh_key_passphrase: secret(&p.id, SecretKind::SshKeyPassphrase)?,
            advanced: p.advanced.clone(),
        };
        connections
            .push(serde_json::to_value(entry).map_err(|e| AppError::InvalidInput(e.to_string()))?);
    }
    let file = ExportFile {
        file_type: FILE_TYPE.to_string(),
        version: FILE_VERSION,
        connections,
    };
    let raw =
        serde_json::to_string_pretty(&file).map_err(|e| AppError::InvalidInput(e.to_string()))?;
    std::fs::write(dest_path, raw)?;
    Ok(profiles.len())
}

/// One connection read from a file, ready for `materialize_profile`.
#[derive(Debug)]
pub struct ParsedImportEntry {
    pub input: ConnectionProfileInput,
    /// Imports, but needs attention afterwards.
    pub warning: Option<String>,
}

impl ParsedImportEntry {
    /// Where it connects, for the preview.
    pub fn address(&self) -> String {
        match &self.input.source {
            ConnectionSource::Uri { uri } => crate::models::redact_uri_summary(uri),
            ConnectionSource::Manual { host, port } => format!("{host}:{port}"),
        }
    }
}

/// One `Ok` per importable connection; one that can't be imported becomes
/// an `Err` saying why, so the rest of the file still imports.
pub fn parse_connections_file(raw: &str) -> AppResult<Vec<Result<ParsedImportEntry, String>>> {
    let value: serde_json::Value = serde_json::from_str(raw)
        .map_err(|e| AppError::InvalidInput(format!("not a recognized connections file: {e}")))?;
    if value.get("type").and_then(|t| t.as_str()) == Some(FILE_TYPE) {
        let file: ExportFile = serde_json::from_value(value).map_err(|e| {
            AppError::InvalidInput(format!("not a recognized connections file: {e}"))
        })?;
        return Ok(file
            .connections
            .into_iter()
            .enumerate()
            .map(|(i, entry)| parse_own(i, entry))
            .collect());
    }
    if let Some(servers) = value.get("Servers").and_then(|s| s.as_object()) {
        let mut entries: Vec<(&String, &serde_json::Value)> = servers.iter().collect();
        entries.sort_by_key(|(k, _)| k.parse::<u64>().unwrap_or(u64::MAX));
        return Ok(entries
            .into_iter()
            .enumerate()
            .map(|(i, (_, server))| parse_pgadmin(i, server))
            .collect());
    }
    Err(AppError::InvalidInput(
        "Unrecognized file (expected a Postgres Studio connections export or pgAdmin's servers.json)"
            .to_string(),
    ))
}

fn parse_own(index: usize, raw: serde_json::Value) -> Result<ParsedImportEntry, String> {
    let name = raw
        .get("name")
        .and_then(|n| n.as_str())
        .map(str::to_string)
        .unwrap_or_else(|| format!("Imported connection {}", index + 1));
    let entry: FileEntry =
        serde_json::from_value(raw).map_err(|e| format!("\"{name}\" can't be read: {e}"))?;
    Ok(ParsedImportEntry {
        input: ConnectionProfileInput {
            id: None,
            name: entry.name,
            color: entry.color,
            source: entry.source,
            database: entry.database,
            username: entry.username,
            password: entry.password,
            tls: entry.tls,
            ssh_tunnel: entry.ssh_tunnel,
            ssh_password: entry.ssh_password,
            ssh_key_passphrase: entry.ssh_key_passphrase,
            advanced: entry.advanced,
        },
        warning: None,
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct PgAdminServer {
    name: Option<String>,
    host: Option<String>,
    #[serde(default)]
    host_addr: Option<String>,
    port: Option<u16>,
    #[serde(rename = "MaintenanceDB")]
    maintenance_db: Option<String>,
    username: Option<String>,
    #[serde(rename = "SSLMode")]
    ssl_mode: Option<String>,
    #[serde(default)]
    tunnel_host: Option<String>,
    #[serde(default)]
    tunnel_port: Option<serde_json::Value>,
    #[serde(default)]
    tunnel_username: Option<String>,
    #[serde(default)]
    tunnel_identity_file: Option<String>,
    #[serde(default, rename = "UseSSHTunnel")]
    use_ssh_tunnel: Option<serde_json::Value>,
    #[serde(default)]
    connection_parameters: Option<serde_json::Value>,
}

fn parse_pgadmin(index: usize, raw: &serde_json::Value) -> Result<ParsedImportEntry, String> {
    let s: PgAdminServer = serde_json::from_value(raw.clone())
        .map_err(|e| format!("server {} can't be read: {e}", index + 1))?;
    let name = s
        .name
        .clone()
        .unwrap_or_else(|| format!("Imported server {}", index + 1));
    let host = s
        .host
        .clone()
        .or(s.host_addr.clone())
        .filter(|h| !h.is_empty())
        .ok_or_else(|| format!("\"{name}\" has no host (service-file servers aren't supported)"))?;
    let param = |key: &str| {
        s.connection_parameters
            .as_ref()
            .and_then(|p| p.get(key))
            .and_then(|v| v.as_str())
            .map(str::to_string)
    };
    let ssl_mode = match s.ssl_mode.clone().or_else(|| param("sslmode")).as_deref() {
        Some("disable") => SslMode::Disable,
        Some("require") => SslMode::Require,
        Some("verify-ca") => SslMode::VerifyCa,
        Some("verify-full") => SslMode::VerifyFull,
        _ => SslMode::Prefer,
    };
    let truthy = |v: &Option<serde_json::Value>| match v {
        Some(serde_json::Value::Bool(b)) => *b,
        Some(serde_json::Value::Number(n)) => n.as_i64() == Some(1),
        Some(serde_json::Value::String(s)) => s == "1" || s.eq_ignore_ascii_case("true"),
        _ => false,
    };
    let ssh_tunnel =
        (truthy(&s.use_ssh_tunnel) && s.tunnel_host.is_some()).then(|| SshTunnelOptions {
            enabled: true,
            host: s.tunnel_host.clone().unwrap_or_default(),
            port: s
                .tunnel_port
                .as_ref()
                .and_then(|p| {
                    p.as_u64()
                        .or_else(|| p.as_str().and_then(|s| s.parse().ok()))
                })
                .and_then(|p| u16::try_from(p).ok())
                .unwrap_or(22),
            username: s.tunnel_username.clone().unwrap_or_default(),
            auth_method: if s.tunnel_identity_file.is_some() {
                SshAuthMethod::PrivateKey
            } else {
                SshAuthMethod::Password
            },
            private_key_path: s.tunnel_identity_file.clone(),
            private_key_has_passphrase: false,
        });
    Ok(ParsedImportEntry {
        input: ConnectionProfileInput {
            id: None,
            name,
            color: None,
            source: ConnectionSource::Manual {
                host,
                port: s.port.unwrap_or(DEFAULT_PORT),
            },
            database: s.maintenance_db.clone(),
            username: s.username.clone(),
            password: None,
            tls: TlsOptions {
                ssl_mode,
                ca_file: param("sslrootcert"),
                cert_file: param("sslcert"),
                key_file: param("sslkey"),
            },
            ssh_tunnel,
            ssh_password: None,
            ssh_key_passphrase: None,
            advanced: ConnectionAdvancedOptions::default(),
        },
        warning: s.username.as_ref().map(|_| {
            "pgAdmin doesn't export passwords; add it by editing the connection".to_string()
        }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secrets::InMemoryStore;

    fn profile(id: &str, name: &str) -> ConnectionProfile {
        ConnectionProfile {
            id: id.to_string(),
            name: name.to_string(),
            color: Some("#4FA25A".to_string()),
            source: ConnectionSource::Manual {
                host: "db.internal".to_string(),
                port: 5433,
            },
            database: Some("shop".to_string()),
            username: Some("alice".to_string()),
            has_password: true,
            tls: TlsOptions {
                ssl_mode: SslMode::VerifyFull,
                ..Default::default()
            },
            ssh_tunnel: None,
            advanced: ConnectionAdvancedOptions {
                read_only: true,
                ..Default::default()
            },
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    #[test]
    fn exports_and_imports_every_option() {
        let secrets = InMemoryStore::new();
        secrets.set("a", SecretKind::Password, "s3cret").unwrap();
        let dir =
            std::env::temp_dir().join(format!("postgres-studio-conn-io-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();

        for (include, expected) in [(false, None), (true, Some("s3cret"))] {
            let path = dir.join(format!("out-{include}.json"));
            export_connections(&[profile("a", "prod")], include, &secrets, &path).unwrap();
            let raw = std::fs::read_to_string(&path).unwrap();
            assert_eq!(raw.contains("s3cret"), include);
            let parsed = parse_connections_file(&raw).unwrap();
            let entry = parsed.into_iter().next().unwrap().unwrap();
            assert_eq!(entry.input.name, "prod");
            assert_eq!(entry.input.password.as_deref(), expected);
            assert_eq!(entry.input.tls.ssl_mode, SslMode::VerifyFull);
            assert!(entry.input.advanced.read_only);
            assert_eq!(entry.address(), "db.internal:5433");
        }
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn reads_pgadmin_servers() {
        let raw = r#"{"Servers": {
            "2": {"Name": "Second", "Group": "Servers", "Host": "db2", "Port": 5432, "MaintenanceDB": "postgres", "Username": "bob", "SSLMode": "require"},
            "1": {"Name": "First", "Group": "Servers", "Host": "db1", "Port": 6543, "MaintenanceDB": "shop", "Username": "alice",
                  "ConnectionParameters": {"sslmode": "verify-full", "sslrootcert": "/ca.pem"},
                  "UseSSHTunnel": 1, "TunnelHost": "jump", "TunnelPort": "2222", "TunnelUsername": "me"},
            "3": {"Name": "Service only", "Service": "x"}
        }}"#;
        let parsed = parse_connections_file(raw).unwrap();
        assert_eq!(parsed.len(), 3);
        let first = parsed[0].as_ref().unwrap();
        assert_eq!(first.input.name, "First");
        assert_eq!(first.input.tls.ssl_mode, SslMode::VerifyFull);
        assert_eq!(first.input.tls.ca_file.as_deref(), Some("/ca.pem"));
        let ssh = first.input.ssh_tunnel.as_ref().unwrap();
        assert_eq!((ssh.host.as_str(), ssh.port), ("jump", 2222));
        assert!(first.warning.is_some());
        assert_eq!(
            parsed[1].as_ref().unwrap().input.tls.ssl_mode,
            SslMode::Require
        );
        assert!(parsed[2].is_err());
    }

    #[test]
    fn rejects_other_files() {
        assert!(
            parse_connections_file(r#"{"type": "Some Other Tool", "connections": []}"#).is_err()
        );
        assert!(parse_connections_file("not json").is_err());
    }
}
