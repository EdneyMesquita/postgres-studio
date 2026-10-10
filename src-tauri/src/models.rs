use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

pub type ConnectionId = String;
pub type SessionId = String;

pub const DEFAULT_PORT: u16 = 5432;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ConnectionSource {
    /// A `postgres://` / `postgresql://` URI, or a libpq `key=value` string.
    /// Any password embedded in a URI is moved to the secret store before
    /// this is persisted, so `uri` never carries one to disk.
    Uri { uri: String },
    /// A host/port form.
    Manual { host: String, port: u16 },
}

/// libpq's `sslmode`, minus `allow` (rarely useful, and what it means -
/// plain first, TLS on refusal - can't be expressed with the driver).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SslMode {
    Disable,
    /// TLS when the server offers it, without checking the certificate.
    #[default]
    Prefer,
    /// TLS always, without checking the certificate (as libpq does).
    Require,
    /// TLS, with a certificate signed by a trusted CA; any host name.
    VerifyCa,
    /// TLS, with a trusted certificate issued for this host.
    VerifyFull,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TlsOptions {
    #[serde(default)]
    pub ssl_mode: SslMode,
    /// PEM file with the CA certificates to trust; the system's when absent.
    pub ca_file: Option<String>,
    /// PEM client certificate and its (unencrypted) private key.
    pub cert_file: Option<String>,
    pub key_file: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SshAuthMethod {
    Password,
    PrivateKey,
    Agent,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshTunnelOptions {
    pub enabled: bool,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: SshAuthMethod,
    pub private_key_path: Option<String>,
    /// Whether a passphrase for `private_key_path` is held in the secret store.
    pub private_key_has_passphrase: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionAdvancedOptions {
    pub app_name: Option<String>,
    pub connect_timeout_ms: Option<u64>,
    /// `statement_timeout` for every session the app opens; none when absent.
    pub statement_timeout_ms: Option<u64>,
    /// `search_path` for every session the app opens.
    pub search_path: Option<String>,
    /// For PgBouncer or Supabase's pooler in transaction mode: no prepared
    /// statements and no session settings, which such poolers break.
    #[serde(default)]
    pub pooler_mode: bool,
    /// Opens every session with `default_transaction_read_only`, so nothing
    /// written through the app can change data (production safety).
    #[serde(default)]
    pub read_only: bool,
    /// Whether the explorer lists `pg_catalog`, `information_schema` and
    /// the like.
    #[serde(default)]
    pub show_system_schemas: bool,
}

/// Persisted, non-secret connection metadata. Lives in `connections.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionProfile {
    pub id: ConnectionId,
    pub name: String,
    /// Identity color as `#RRGGBB`; `None` lets the UI pick one from the id.
    #[serde(default)]
    pub color: Option<String>,
    pub source: ConnectionSource,
    /// The database to connect to first; the URI's, or `postgres`.
    pub database: Option<String>,
    pub username: Option<String>,
    /// Whether a password for `username` is held in the secret store.
    pub has_password: bool,
    #[serde(default)]
    pub tls: TlsOptions,
    pub ssh_tunnel: Option<SshTunnelOptions>,
    #[serde(default)]
    pub advanced: ConnectionAdvancedOptions,
    pub created_at: String,
    pub updated_at: String,
}

/// What the frontend submits when creating/editing a profile. Secret fields
/// here are written to the secret store and never appear in `ConnectionProfile`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionProfileInput {
    pub id: Option<ConnectionId>,
    pub name: String,
    #[serde(default)]
    pub color: Option<String>,
    pub source: ConnectionSource,
    pub database: Option<String>,
    pub username: Option<String>,
    pub password: Option<String>,
    #[serde(default)]
    pub tls: TlsOptions,
    pub ssh_tunnel: Option<SshTunnelOptions>,
    pub ssh_password: Option<String>,
    pub ssh_key_passphrase: Option<String>,
    #[serde(default)]
    pub advanced: ConnectionAdvancedOptions,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionProfileMeta {
    pub id: ConnectionId,
    pub name: String,
    pub color: Option<String>,
    pub summary: String,
    pub database: Option<String>,
    pub read_only: bool,
}

impl From<&ConnectionProfile> for ConnectionProfileMeta {
    fn from(profile: &ConnectionProfile) -> Self {
        let summary = match &profile.source {
            ConnectionSource::Uri { uri } => redact_uri_summary(uri),
            ConnectionSource::Manual { host, port } => {
                let db = profile.database.as_deref().unwrap_or("postgres");
                format!("postgres://{host}:{port}/{db}")
            }
        };
        Self {
            id: profile.id.clone(),
            name: profile.name.clone(),
            color: profile.color.clone(),
            summary,
            database: profile.database.clone(),
            read_only: profile.advanced.read_only,
        }
    }
}

/// A connection color is either absent or a `#RRGGBB` hex string.
pub(crate) fn validate_color(color: Option<&str>) -> AppResult<()> {
    match color {
        None => Ok(()),
        Some(c)
            if c.len() == 7
                && c.starts_with('#')
                && c[1..].chars().all(|ch| ch.is_ascii_hexdigit()) =>
        {
            Ok(())
        }
        Some(c) => Err(AppError::InvalidInput(format!(
            "connection color must be a #RRGGBB hex value, got \"{c}\""
        ))),
    }
}

/// The URI with any `user:password@` masked and the query string dropped
/// (it can hold `password=` or `sslpassword=`).
pub(crate) fn redact_uri_summary(uri: &str) -> String {
    let uri = uri.split('?').next().unwrap_or(uri);
    match uri.find('@') {
        Some(at_idx) => match uri.find("://") {
            Some(scheme_idx) if scheme_idx < at_idx => {
                format!("{}://***@{}", &uri[..scheme_idx], &uri[at_idx + 1..])
            }
            _ => uri.to_string(),
        },
        // a key=value string: keep only host/port/dbname
        None if !uri.contains("://") => uri
            .split_whitespace()
            .filter(|kv| {
                let key = kv.split('=').next().unwrap_or_default();
                matches!(key, "host" | "hostaddr" | "port" | "dbname")
            })
            .collect::<Vec<_>>()
            .join(" "),
        None => uri.to_string(),
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionTestResult {
    pub success: bool,
    pub message: String,
    pub server_version: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionHandle {
    pub session_id: SessionId,
    pub server_version: Option<String>,
    /// The database the connection opened on.
    pub database: String,
    pub read_only: bool,
    pub pooler_mode: bool,
    pub show_system_schemas: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SecretBackendKind {
    Keyring,
    EncryptedFile,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretBackendInfo {
    pub backend: SecretBackendKind,
    pub warning: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionsExportSummary {
    pub exported: usize,
}

/// One connection found in an import file, shown for picking before
/// anything is saved.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionImportPreview {
    /// Position in the file; what `import_connections` takes to select it.
    pub index: usize,
    pub name: String,
    /// Where it connects, credentials masked.
    pub address: String,
    /// Imports, but needs attention afterwards.
    pub warning: Option<String>,
    /// Can't be imported; the reason why.
    pub error: Option<String>,
    /// A saved connection already has this name.
    pub exists: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionsImportSummary {
    pub imported: usize,
    /// Why individual connections in the file were skipped; the rest of the
    /// file still imports.
    pub errors: Vec<String>,
    /// Notes about connections that were imported but need attention.
    pub warnings: Vec<String>,
}

/// The file an export writes.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExportFormat {
    #[default]
    Csv,
    Json,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSummary {
    pub rows_written: u64,
    pub columns: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summaries_never_show_credentials() {
        assert_eq!(
            redact_uri_summary("postgres://alice:s3cret@db.example.com:5432/shop?sslmode=require"),
            "postgres://***@db.example.com:5432/shop"
        );
        assert_eq!(
            redact_uri_summary("postgresql://db/shop?password=s3cret"),
            "postgresql://db/shop"
        );
        assert_eq!(
            redact_uri_summary("host=db port=6543 user=alice password=s3cret dbname=shop"),
            "host=db port=6543 dbname=shop"
        );
    }
}
