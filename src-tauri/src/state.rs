use std::collections::HashMap;
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tokio::sync::{Notify, RwLock};

use crate::connection::ConnectionStore;
use crate::error::{AppError, AppResult};
use crate::models::{SecretBackendKind, SessionId};
use crate::pg::connect::Canceller;
use crate::pg::PgSession;
use crate::secrets::{EncryptedFileStore, KeyringStore, SecretStore};
use crate::ssh_tunnel::KnownHosts;

/// A running task's cancel switch: a flag a loop can poll, and a wait an
/// `await` can race against, so cancelling also stops a task that is
/// waiting on the server.
#[derive(Clone, Default)]
pub struct CancelToken {
    flag: Arc<AtomicBool>,
    notify: Arc<Notify>,
}

impl CancelToken {
    pub fn cancel(&self) {
        self.flag.store(true, Ordering::Relaxed);
        self.notify.notify_waiters();
    }

    pub fn is_cancelled(&self) -> bool {
        self.flag.load(Ordering::Relaxed)
    }

    /// The flag itself, for code that only polls.
    pub fn flag(&self) -> Arc<AtomicBool> {
        self.flag.clone()
    }

    /// Resolves once `cancel` is called (at once if it already was).
    pub async fn cancelled(&self) {
        loop {
            // registered before the check, so a cancel in between still wakes it
            let notified = self.notify.notified();
            if self.is_cancelled() {
                return;
            }
            notified.await;
        }
    }

    /// Runs `task` unless cancelled first. Dropping the future stops waiting;
    /// stopping the statement on the server is the `Canceller`'s job.
    pub async fn guard<T>(&self, task: impl Future<Output = AppResult<T>>) -> AppResult<T> {
        tokio::select! {
            result = task => result,
            () = self.cancelled() => Err(AppError::Cancelled),
        }
    }
}

/// A statement in flight: what stops the waiting, and what stops the
/// server's work.
pub struct RunningTask {
    pub token: CancelToken,
    pub canceller: Option<Canceller>,
}

pub struct AppState {
    pub connection_store: ConnectionStore,
    pub secret_store: Box<dyn SecretStore>,
    pub secret_backend: SecretBackendKind,
    pub known_hosts: Arc<KnownHosts>,
    pub sessions: RwLock<HashMap<SessionId, Arc<PgSession>>>,
    /// In-flight statements, keyed by the frontend-generated execution id,
    /// so `cancel_query` reaches both the waiting task and the server.
    pub running_tasks: Mutex<HashMap<String, RunningTask>>,
}

impl AppState {
    pub fn init(config_dir: &std::path::Path) -> Result<Self, String> {
        let connection_store = ConnectionStore::load(config_dir).map_err(|e| e.to_string())?;
        log::info!(
            "{} saved connections in {}",
            connection_store.list().len(),
            config_dir.display()
        );
        let known_hosts = Arc::new(KnownHosts::load(config_dir).map_err(|e| e.to_string())?);

        let (secret_store, secret_backend): (Box<dyn SecretStore>, SecretBackendKind) =
            match KeyringStore::probe() {
                Ok(store) => {
                    log::info!("secrets are kept in the OS keychain");
                    (Box::new(store), SecretBackendKind::Keyring)
                }
                Err(e) => {
                    log::warn!(
                        "no usable OS keychain ({e}); secrets are kept in an encrypted file instead"
                    );
                    let store = EncryptedFileStore::new(config_dir).inspect_err(|e| {
                        log::error!("can't open the encrypted secret file: {e}")
                    })?;
                    (Box::new(store), SecretBackendKind::EncryptedFile)
                }
            };

        Ok(Self {
            connection_store,
            secret_store,
            secret_backend,
            known_hosts,
            sessions: RwLock::new(HashMap::new()),
            running_tasks: Mutex::new(HashMap::new()),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn cancelling_stops_a_task_that_is_waiting() {
        let token = CancelToken::default();
        let canceller = token.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(20)).await;
            canceller.cancel();
        });
        let never = std::future::pending::<AppResult<()>>();
        let result = tokio::time::timeout(Duration::from_secs(2), token.guard(never)).await;
        assert!(matches!(result, Ok(Err(AppError::Cancelled))));
        assert!(token.is_cancelled());
    }

    #[tokio::test]
    async fn a_task_cancelled_before_it_starts_does_not_run() {
        let token = CancelToken::default();
        token.cancel();
        let result = token.guard(std::future::pending::<AppResult<()>>()).await;
        assert!(matches!(result, Err(AppError::Cancelled)));
    }

    #[tokio::test]
    async fn a_finished_task_keeps_its_result() {
        let token = CancelToken::default();
        assert_eq!(token.guard(async { Ok(7) }).await.unwrap(), 7);
    }
}
