//! Opening connections: a profile becomes a `Target` (driver config, TLS,
//! session settings), and a `PgSession` holds the clients opened on it.
//!
//! A PostgreSQL connection reaches one database, so a session keeps one
//! shared client per database (for catalog reads and table pages, which
//! can safely interleave) and pinned clients per tab (consoles and edits,
//! whose transactions must not see anyone else's statements).

use std::collections::HashMap;
use std::str::FromStr;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use futures_util::StreamExt;
use tokio::sync::{mpsc, Mutex};
use tokio_postgres::config::Host;
use tokio_postgres::{AsyncMessage, Config, NoTls};
use tokio_postgres_rustls::MakeRustlsConnect;

use super::{split, tls};
use crate::error::{AppError, AppResult};
use crate::models::{self, ConnectionProfile, ConnectionSource, SslMode};
use crate::secrets::{SecretKind, SecretStore};
use crate::ssh_tunnel::{self, KnownHosts, SshTunnel, SshTunnelAuth, SshTunnelConfig};

const DEFAULT_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// Settings every session of a connection starts with.
#[derive(Debug, Clone, Default)]
pub struct SessionSettings {
    pub statement_timeout_ms: Option<u64>,
    pub search_path: Option<String>,
    pub read_only: bool,
    pub pooler_mode: bool,
}

/// Everything needed to open a client on any database of a server.
pub struct Target {
    config: Config,
    tls: Option<MakeRustlsConnect>,
    pub default_db: String,
    pub settings: SessionSettings,
}

/// A message the server sent outside a result: `RAISE NOTICE`, warnings.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Notice {
    pub severity: String,
    pub message: String,
    pub detail: Option<String>,
    pub hint: Option<String>,
}

pub struct PgClient {
    pub client: tokio_postgres::Client,
    pub database: String,
    notices: StdMutex<mpsc::UnboundedReceiver<Notice>>,
    tls: Option<MakeRustlsConnect>,
}

impl PgClient {
    /// Notices received since the last call.
    pub fn take_notices(&self) -> Vec<Notice> {
        let mut rx = self.notices.lock().unwrap();
        let mut out = Vec::new();
        while let Ok(n) = rx.try_recv() {
            out.push(n);
        }
        out
    }

    /// A handle that asks the server to stop what this client is running.
    pub fn canceller(&self) -> Canceller {
        Canceller {
            token: self.client.cancel_token(),
            tls: self.tls.clone(),
        }
    }

    pub fn is_closed(&self) -> bool {
        self.client.is_closed()
    }
}

/// Dropping a query's future doesn't stop it on the server; this does.
#[derive(Clone)]
pub struct Canceller {
    token: tokio_postgres::CancelToken,
    tls: Option<MakeRustlsConnect>,
}

impl Canceller {
    pub async fn cancel(&self) {
        let result = match &self.tls {
            Some(tls) => self.token.cancel_query(tls.clone()).await,
            None => self.token.cancel_query(NoTls).await,
        };
        if let Err(e) = result {
            log::warn!("cancel request failed: {e}");
        }
    }
}

impl Target {
    pub fn from_profile(
        profile: &ConnectionProfile,
        secrets: &dyn SecretStore,
        tunnel_port: Option<u16>,
    ) -> AppResult<Self> {
        let password = if profile.has_password {
            let saved = secrets
                .get(&profile.id, SecretKind::Password)
                .map_err(AppError::Secret)?;
            Some(saved.ok_or_else(|| {
                AppError::PasswordMissing(
                    "The saved password for this connection is missing from the system keychain. \
                     Edit the connection and enter it again."
                        .to_string(),
                )
            })?)
        } else {
            None
        };
        let parsed = parse_source(&profile.source)?;
        let mut config = Config::new();
        let hosts = parsed.get_hosts();
        let ports = parsed.get_ports();
        let port_at = |i: usize| {
            ports
                .get(i)
                .or(ports.first())
                .copied()
                .unwrap_or(models::DEFAULT_PORT)
        };
        match tunnel_port {
            Some(local) => {
                let host = match hosts.first() {
                    Some(Host::Tcp(h)) => h.clone(),
                    None => "localhost".to_string(),
                    #[cfg(unix)]
                    Some(Host::Unix(_)) => {
                        return Err(AppError::InvalidInput(
                            "SSH tunneling to a Unix socket is not supported".to_string(),
                        ))
                    }
                };
                // TLS still checks the certificate against the real host
                // name, while the bytes go to the tunnel's local end.
                config
                    .host(&host)
                    .hostaddr(std::net::IpAddr::from([127, 0, 0, 1]))
                    .port(local);
            }
            None if hosts.is_empty() => {
                config.host("localhost").port(port_at(0));
            }
            None => {
                for (i, host) in hosts.iter().enumerate() {
                    match host {
                        Host::Tcp(h) => config.host(h),
                        #[cfg(unix)]
                        Host::Unix(p) => config.host_path(p),
                    };
                    config.port(port_at(i));
                }
                for addr in parsed.get_hostaddrs() {
                    config.hostaddr(*addr);
                }
            }
        }

        let user = profile
            .username
            .clone()
            .filter(|u| !u.is_empty())
            .or_else(|| parsed.get_user().map(str::to_string))
            .unwrap_or_else(default_user);
        config.user(&user);
        if let Some(pw) = password.as_deref() {
            config.password(pw);
        } else if let Some(pw) = parsed.get_password() {
            config.password(pw);
        }
        if let Some(options) = parsed.get_options() {
            config.options(options);
        }
        config.application_name(
            profile
                .advanced
                .app_name
                .as_deref()
                .filter(|n| !n.is_empty())
                .unwrap_or("Postgres Studio"),
        );
        config.connect_timeout(
            profile
                .advanced
                .connect_timeout_ms
                .map(Duration::from_millis)
                .unwrap_or(DEFAULT_CONNECT_TIMEOUT),
        );
        config.keepalives(true);
        config.target_session_attrs(parsed.get_target_session_attrs());
        config.ssl_mode(match profile.tls.ssl_mode {
            SslMode::Disable => tokio_postgres::config::SslMode::Disable,
            SslMode::Prefer => tokio_postgres::config::SslMode::Prefer,
            _ => tokio_postgres::config::SslMode::Require,
        });

        let default_db = profile
            .database
            .clone()
            .filter(|d| !d.is_empty())
            .or_else(|| parsed.get_dbname().map(str::to_string))
            .unwrap_or_else(|| "postgres".to_string());

        if let Some(path) = profile.advanced.search_path.as_deref() {
            if split::split(&format!("SET search_path TO {path}")).len() != 1 {
                return Err(AppError::InvalidInput(
                    "search_path must be a list of schema names".to_string(),
                ));
            }
        }

        Ok(Target {
            config,
            tls: tls::connector(&profile.tls)?,
            default_db,
            settings: SessionSettings {
                statement_timeout_ms: profile.advanced.statement_timeout_ms,
                search_path: profile
                    .advanced
                    .search_path
                    .clone()
                    .filter(|p| !p.trim().is_empty()),
                read_only: profile.advanced.read_only,
                pooler_mode: profile.advanced.pooler_mode,
            },
        })
    }

    /// Opens a client on `database` and applies the session settings.
    pub async fn open(&self, database: &str) -> AppResult<PgClient> {
        let mut config = self.config.clone();
        config.dbname(database);
        let (tx, rx) = mpsc::unbounded_channel();
        let client = match &self.tls {
            Some(tls) => {
                let (client, connection) = config.connect(tls.clone()).await?;
                drive(connection, tx);
                client
            }
            None => {
                let (client, connection) = config.connect(NoTls).await?;
                drive(connection, tx);
                client
            }
        };
        let client = PgClient {
            client,
            database: database.to_string(),
            notices: StdMutex::new(rx),
            tls: self.tls.clone(),
        };
        // Poolers in transaction mode hand each transaction to whichever
        // server connection is free, so session settings would land on a
        // stranger's session; there they are applied per statement instead.
        if !self.settings.pooler_mode {
            let setup = self.setup_sql();
            if !setup.is_empty() {
                client.client.batch_execute(&setup).await?;
            }
        }
        Ok(client)
    }

    fn setup_sql(&self) -> String {
        let mut sql = String::new();
        if let Some(ms) = self.settings.statement_timeout_ms {
            sql.push_str(&format!("SET statement_timeout = {ms};"));
        }
        if let Some(path) = &self.settings.search_path {
            sql.push_str(&format!("SET search_path TO {path};"));
        }
        if self.settings.read_only {
            sql.push_str("SET default_transaction_read_only = on;");
        }
        sql
    }
}

/// Runs the connection, forwarding notices; the client fails its calls
/// once this ends.
fn drive<S, T>(mut connection: tokio_postgres::Connection<S, T>, tx: mpsc::UnboundedSender<Notice>)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
    T: tokio_postgres::tls::TlsStream + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut messages = futures_util::stream::poll_fn(move |cx| connection.poll_message(cx));
        while let Some(message) = messages.next().await {
            match message {
                Ok(AsyncMessage::Notice(n)) => {
                    let _ = tx.send(Notice {
                        severity: n.severity().to_string(),
                        message: n.message().to_string(),
                        detail: n.detail().map(str::to_string),
                        hint: n.hint().map(str::to_string),
                    });
                }
                Ok(_) => {}
                Err(e) => {
                    log::warn!("connection ended: {e}");
                    break;
                }
            }
        }
    });
}

/// A URI or key=value string, minus the TLS parameters the driver can't
/// parse (they live in the profile's TLS options instead).
fn parse_source(source: &ConnectionSource) -> AppResult<Config> {
    match source {
        ConnectionSource::Manual { host, port } => {
            let mut config = Config::new();
            config.host(host).port(*port);
            Ok(config)
        }
        ConnectionSource::Uri { uri } => {
            let cleaned = strip_tls_params(uri);
            Config::from_str(&cleaned)
                .map_err(|e| AppError::InvalidInput(format!("invalid connection string: {e}")))
        }
    }
}

const TLS_PARAMS: [&str; 6] = [
    "sslmode",
    "sslrootcert",
    "sslcert",
    "sslkey",
    "sslpassword",
    "sslnegotiation",
];

pub(crate) fn strip_tls_params(uri: &str) -> String {
    if uri.contains("://") {
        let Some((base, query)) = uri.split_once('?') else {
            return uri.to_string();
        };
        let kept: Vec<&str> = query
            .split('&')
            .filter(|kv| !TLS_PARAMS.contains(&kv.split('=').next().unwrap_or_default()))
            .collect();
        if kept.is_empty() {
            base.to_string()
        } else {
            format!("{base}?{}", kept.join("&"))
        }
    } else {
        uri.split_whitespace()
            .filter(|kv| !TLS_PARAMS.contains(&kv.split('=').next().unwrap_or_default()))
            .collect::<Vec<_>>()
            .join(" ")
    }
}

/// A parameter of a URI's query string or a key=value string, decoded.
pub(crate) fn uri_param(uri: &str, key: &str) -> Option<String> {
    if uri.contains("://") {
        let query = uri.split_once('?')?.1;
        query.split('&').find_map(|kv| {
            let (k, v) = kv.split_once('=')?;
            (k == key).then(|| {
                urlencoding::decode(v)
                    .map(|s| s.into_owned())
                    .unwrap_or_default()
            })
        })
    } else {
        uri.split_whitespace().find_map(|kv| {
            let (k, v) = kv.split_once('=')?;
            (k == key).then(|| v.trim_matches('\'').to_string())
        })
    }
}

fn default_user() -> String {
    std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_else(|_| "postgres".to_string())
}

/// Starts the profile's SSH tunnel, if it has one.
pub async fn start_tunnel(
    profile: &ConnectionProfile,
    secrets: &dyn SecretStore,
    known_hosts: &Arc<KnownHosts>,
) -> AppResult<Option<SshTunnel>> {
    let Some(ssh) = profile.ssh_tunnel.as_ref().filter(|s| s.enabled) else {
        return Ok(None);
    };
    let parsed = parse_source(&profile.source)?;
    let remote_host = match parsed.get_hosts().first() {
        Some(Host::Tcp(h)) => h.clone(),
        None => "localhost".to_string(),
        #[cfg(unix)]
        Some(Host::Unix(_)) => {
            return Err(AppError::InvalidInput(
                "SSH tunneling to a Unix socket is not supported".to_string(),
            ))
        }
    };
    let remote_port = parsed
        .get_ports()
        .first()
        .copied()
        .unwrap_or(models::DEFAULT_PORT);
    let auth = match ssh.auth_method {
        models::SshAuthMethod::Password => SshTunnelAuth::Password(
            secrets
                .get(&profile.id, SecretKind::SshPassword)
                .map_err(AppError::Secret)?
                .ok_or_else(|| AppError::InvalidInput("SSH password not set".to_string()))?,
        ),
        models::SshAuthMethod::PrivateKey => {
            let path = ssh.private_key_path.clone().ok_or_else(|| {
                AppError::InvalidInput("SSH private key path not set".to_string())
            })?;
            let passphrase = if ssh.private_key_has_passphrase {
                secrets
                    .get(&profile.id, SecretKind::SshKeyPassphrase)
                    .map_err(AppError::Secret)?
            } else {
                None
            };
            SshTunnelAuth::PrivateKey { path, passphrase }
        }
        models::SshAuthMethod::Agent => SshTunnelAuth::Agent,
    };
    let tunnel = ssh_tunnel::start_tunnel(
        SshTunnelConfig {
            ssh_host: ssh.host.clone(),
            ssh_port: ssh.port,
            ssh_username: ssh.username.clone(),
            auth,
            remote_host,
            remote_port,
        },
        known_hosts.clone(),
    )
    .await?;
    Ok(Some(tunnel))
}

/// The server's version as `SHOW server_version` prints it, e.g. `17.11`.
pub async fn server_version(client: &PgClient) -> Option<String> {
    let rows = client
        .client
        .simple_query("SHOW server_version")
        .await
        .ok()?;
    rows.iter().find_map(|m| match m {
        tokio_postgres::SimpleQueryMessage::Row(r) => r.get(0).map(|v| {
            // Debian builds append " (Debian 17.2-1.pgdg120+1)".
            v.split_whitespace().next().unwrap_or(v).to_string()
        }),
        _ => None,
    })
}

/// A live connection: its target, tunnel and the clients opened on it.
pub struct PgSession {
    pub name: String,
    pub target: Arc<Target>,
    pub server_version: Option<String>,
    tunnel: Mutex<Option<SshTunnel>>,
    shared: Mutex<HashMap<String, Arc<PgClient>>>,
    pinned: Mutex<HashMap<String, Arc<PgClient>>>,
}

impl PgSession {
    /// Connects to the default database, which proves the target works.
    pub async fn connect(
        profile: &ConnectionProfile,
        secrets: &dyn SecretStore,
        known_hosts: &Arc<KnownHosts>,
    ) -> AppResult<Self> {
        let tunnel = start_tunnel(profile, secrets, known_hosts).await?;
        let built = Target::from_profile(
            profile,
            secrets,
            tunnel.as_ref().map(|t| t.local_addr.port()),
        );
        let target = match built {
            Ok(t) => t,
            Err(e) => {
                if let Some(t) = tunnel {
                    t.shutdown().await;
                }
                return Err(e);
            }
        };
        let first = match target.open(&target.default_db).await {
            Ok(c) => c,
            Err(e) => {
                if let Some(t) = tunnel {
                    t.shutdown().await;
                }
                return Err(e);
            }
        };
        let server_version = server_version(&first).await;
        let mut shared = HashMap::new();
        shared.insert(target.default_db.clone(), Arc::new(first));
        Ok(PgSession {
            name: profile.name.clone(),
            target: Arc::new(target),
            server_version,
            tunnel: Mutex::new(tunnel),
            shared: Mutex::new(shared),
            pinned: Mutex::new(HashMap::new()),
        })
    }

    /// The shared client on `database`, opened (or reopened) on demand.
    pub async fn client(&self, database: &str) -> AppResult<Arc<PgClient>> {
        let mut shared = self.shared.lock().await;
        if let Some(c) = shared.get(database).filter(|c| !c.is_closed()) {
            return Ok(c.clone());
        }
        let client = Arc::new(self.target.open(database).await?);
        shared.insert(database.to_string(), client.clone());
        Ok(client)
    }

    /// A client of `key`'s own (a tab), on `database`. A key that moves to
    /// another database gets a new client; the old one closes.
    pub async fn pinned(&self, key: &str, database: &str) -> AppResult<Arc<PgClient>> {
        let mut pinned = self.pinned.lock().await;
        if let Some(c) = pinned
            .get(key)
            .filter(|c| !c.is_closed() && c.database == database)
        {
            return Ok(c.clone());
        }
        let client = Arc::new(self.target.open(database).await?);
        pinned.insert(key.to_string(), client.clone());
        Ok(client)
    }

    /// The pinned client of `key`, if one is open.
    pub async fn pinned_if_open(&self, key: &str) -> Option<Arc<PgClient>> {
        self.pinned
            .lock()
            .await
            .get(key)
            .filter(|c| !c.is_closed())
            .cloned()
    }

    /// Closes `key`'s client; an open transaction on it rolls back.
    pub async fn release(&self, key: &str) {
        self.pinned.lock().await.remove(key);
    }

    pub async fn shutdown(&self) {
        self.pinned.lock().await.clear();
        self.shared.lock().await.clear();
        if let Some(t) = self.tunnel.lock().await.take() {
            t.shutdown().await;
        }
    }
}

/// Connects once and reports the server version, for the connection form.
pub async fn test_connection(
    profile: &ConnectionProfile,
    secrets: &dyn SecretStore,
    known_hosts: &Arc<KnownHosts>,
) -> AppResult<Option<String>> {
    let session = PgSession::connect(profile, secrets, known_hosts).await?;
    let version = session.server_version.clone();
    session.shutdown().await;
    Ok(version)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tls_parameters_are_stripped_from_uris() {
        assert_eq!(
            strip_tls_params(
                "postgres://db/shop?sslmode=verify-full&application_name=x&sslrootcert=/ca.pem"
            ),
            "postgres://db/shop?application_name=x"
        );
        assert_eq!(
            strip_tls_params("postgres://db/shop?sslmode=require"),
            "postgres://db/shop"
        );
        assert_eq!(
            strip_tls_params("host=db sslmode=verify-ca dbname=shop"),
            "host=db dbname=shop"
        );
    }

    #[test]
    fn reads_uri_parameters() {
        assert_eq!(
            uri_param("postgres://db/shop?sslmode=verify-full&x=1", "sslmode").as_deref(),
            Some("verify-full")
        );
        assert_eq!(
            uri_param("host=db sslmode=disable", "sslmode").as_deref(),
            Some("disable")
        );
    }
}
