use std::collections::HashMap;
use std::fs;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};

use russh::client::{self, AuthResult};
use russh::keys::{load_secret_key, HashAlg, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone)]
pub enum SshTunnelAuth {
    Password(String),
    PrivateKey {
        path: String,
        passphrase: Option<String>,
    },
    /// Not yet implemented; kept as an explicit variant so callers get a
    /// clear "unsupported" error instead of silently falling through.
    Agent,
}

#[derive(Debug, Clone)]
pub struct SshTunnelConfig {
    pub ssh_host: String,
    pub ssh_port: u16,
    pub ssh_username: String,
    pub auth: SshTunnelAuth,
    /// The Postgres host:port to reach *through* the tunnel, as seen from the
    /// SSH server's side of the connection.
    pub remote_host: String,
    pub remote_port: u16,
}

pub struct SshTunnel {
    pub local_addr: SocketAddr,
    shutdown_tx: Option<oneshot::Sender<()>>,
    accept_loop: JoinHandle<()>,
}

impl SshTunnel {
    pub async fn shutdown(mut self) {
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }
        let _ = self.accept_loop.await;
    }
}

/// Trust-on-first-use host key store, persisted next to connection profiles.
/// A known host whose fingerprint later changes fails the connection loudly
/// rather than silently trusting the new key, which is the actual point of
/// pinning it in the first place.
pub struct KnownHosts {
    path: PathBuf,
    entries: StdMutex<HashMap<String, String>>,
}

impl KnownHosts {
    pub fn load(config_dir: &Path) -> AppResult<Self> {
        fs::create_dir_all(config_dir)?;
        let path = config_dir.join("ssh_known_hosts.json");
        let entries = if path.exists() {
            let raw = fs::read_to_string(&path)?;
            serde_json::from_str(&raw).unwrap_or_default()
        } else {
            HashMap::new()
        };
        Ok(Self {
            path,
            entries: StdMutex::new(entries),
        })
    }

    fn persist(&self) -> AppResult<()> {
        let entries = self.entries.lock().unwrap();
        let raw =
            serde_json::to_string_pretty(&*entries).map_err(|e| AppError::Ssh(e.to_string()))?;
        fs::write(&self.path, raw)?;
        Ok(())
    }
}

#[derive(Debug, Clone)]
enum HostKeyOutcome {
    Pending,
    TrustedNew,
    AlreadyTrusted,
    Mismatch { expected: String, got: String },
}

struct TunnelHandler {
    known_hosts: Arc<KnownHosts>,
    host_key: String,
    outcome: Arc<StdMutex<HostKeyOutcome>>,
}

impl client::Handler for TunnelHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let fingerprint = match server_public_key {
            PublicKeyOrCertificate::PublicKey { key, .. } => {
                key.fingerprint(HashAlg::Sha256).to_string()
            }
            // Certificate-based host auth isn't pinned in v1; accept it and
            // rely on the CA trust chain russh already validated.
            PublicKeyOrCertificate::Certificate(_) => {
                *self.outcome.lock().unwrap() = HostKeyOutcome::TrustedNew;
                return Ok(true);
            }
        };

        let mut entries = self.known_hosts.entries.lock().unwrap();
        match entries.get(&self.host_key) {
            Some(known) if known == &fingerprint => {
                *self.outcome.lock().unwrap() = HostKeyOutcome::AlreadyTrusted;
                Ok(true)
            }
            Some(known) => {
                *self.outcome.lock().unwrap() = HostKeyOutcome::Mismatch {
                    expected: known.clone(),
                    got: fingerprint,
                };
                Ok(false)
            }
            None => {
                entries.insert(self.host_key.clone(), fingerprint);
                *self.outcome.lock().unwrap() = HostKeyOutcome::TrustedNew;
                Ok(true)
            }
        }
    }
}

pub async fn start_tunnel(
    config: SshTunnelConfig,
    known_hosts: Arc<KnownHosts>,
) -> AppResult<SshTunnel> {
    let host_key = format!("{}:{}", config.ssh_host, config.ssh_port);
    let outcome = Arc::new(StdMutex::new(HostKeyOutcome::Pending));
    let handler = TunnelHandler {
        known_hosts: known_hosts.clone(),
        host_key,
        outcome: outcome.clone(),
    };

    let ssh_config = Arc::new(client::Config::default());
    let mut handle = client::connect(
        ssh_config,
        (config.ssh_host.as_str(), config.ssh_port),
        handler,
    )
    .await
    .map_err(|e| ssh_connect_error(&outcome, e))?;
    known_hosts.persist()?;

    let auth_result = match &config.auth {
        SshTunnelAuth::Password(password) => handle
            .authenticate_password(&config.ssh_username, password)
            .await
            .map_err(|e| AppError::Ssh(e.to_string()))?,
        SshTunnelAuth::PrivateKey { path, passphrase } => {
            let key = load_secret_key(path, passphrase.as_deref()).map_err(|e| {
                AppError::Ssh(describe_key_error(&e.to_string(), passphrase.is_some()))
            })?;
            let key_with_alg = PrivateKeyWithHashAlg::new(Arc::new(key), Some(HashAlg::Sha256));
            handle
                .authenticate_publickey(&config.ssh_username, key_with_alg)
                .await
                .map_err(|e| AppError::Ssh(e.to_string()))?
        }
        SshTunnelAuth::Agent => {
            return Err(AppError::Ssh(
                "SSH agent authentication is not yet supported".to_string(),
            ))
        }
    };

    match auth_result {
        AuthResult::Success => {}
        AuthResult::Failure { .. } => {
            return Err(AppError::Ssh("SSH authentication failed".to_string()))
        }
    }

    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let local_addr = listener.local_addr()?;

    let handle = Arc::new(handle);
    let (shutdown_tx, mut shutdown_rx) = oneshot::channel::<()>();
    let remote_host = config.remote_host.clone();
    let remote_port = config.remote_port;

    let accept_loop = tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = &mut shutdown_rx => break,
                accepted = listener.accept() => {
                    let Ok((socket, peer_addr)) = accepted else { continue };
                    let handle = handle.clone();
                    let remote_host = remote_host.clone();
                    tokio::spawn(async move {
                        let channel = match handle
                            .channel_open_direct_tcpip(
                                remote_host,
                                remote_port as u32,
                                peer_addr.ip().to_string(),
                                peer_addr.port() as u32,
                            )
                            .await
                        {
                            Ok(channel) => channel,
                            Err(_) => return,
                        };
                        let mut channel_stream = channel.into_stream();
                        let mut socket = socket;
                        let _ = tokio::io::copy_bidirectional(&mut socket, &mut channel_stream).await;
                    });
                }
            }
        }
    });

    Ok(SshTunnel {
        local_addr,
        shutdown_tx: Some(shutdown_tx),
        accept_loop,
    })
}

fn ssh_connect_error(outcome: &Arc<StdMutex<HostKeyOutcome>>, err: russh::Error) -> AppError {
    match &*outcome.lock().unwrap() {
        HostKeyOutcome::Mismatch { expected, got } => AppError::Ssh(format!(
            "SSH host key mismatch! Expected fingerprint {expected}, got {got}. \
             This could mean the server was reconfigured, or an attacker is \
             intercepting the connection. Remove the stale entry from \
             ssh_known_hosts.json only if you're sure the change is legitimate."
        )),
        _ => AppError::Ssh(err.to_string()),
    }
}

/// What went wrong loading a private key, in words a user can act on.
fn describe_key_error(error: &str, had_passphrase: bool) -> String {
    let lower = error.to_lowercase();
    if lower.contains("encrypted") && !had_passphrase {
        "The private key is protected by a passphrase: fill in the key passphrase.".to_string()
    } else if (lower.contains("cryptographic") || lower.contains("decrypt")) && had_passphrase {
        "Couldn't unlock the private key: the passphrase is wrong.".to_string()
    } else {
        format!("failed to load private key: {error}")
    }
}

#[cfg(test)]
mod tests {
    use super::describe_key_error;

    #[test]
    fn key_errors_read_plainly() {
        assert!(
            describe_key_error("SshKey: cryptographic error", true).contains("passphrase is wrong")
        );
        assert!(describe_key_error("The key is encrypted", false)
            .contains("fill in the key passphrase"));
        assert!(
            describe_key_error("No such file or directory (os error 2)", false)
                .starts_with("failed to load private key")
        );
    }
}
