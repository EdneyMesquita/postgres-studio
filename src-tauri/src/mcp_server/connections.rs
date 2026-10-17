//! The server's own connections, one per saved connection, opened when a
//! tool first needs one. The UI's sessions aren't used: the app may not be
//! connected at all while a client works. A connection holds a client per
//! database a tool reached; it is closed (and its SSH tunnel shut down)
//! after sitting idle, when its level drops to None, when the profile
//! changes or is deleted, and when the server stops.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use super::Host;
use crate::error::AppResult;
use crate::logging;
use crate::models::ConnectionProfile;
use crate::pg::PgSession;

/// A connection unused this long is closed.
pub(crate) const IDLE_CLOSE: Duration = Duration::from_secs(10 * 60);

struct Entry {
    session: Arc<PgSession>,
    /// The profile's `updated_at` when it was opened: an edited profile
    /// gets a new connection.
    updated_at: String,
    last_used: Instant,
}

#[derive(Default)]
pub(crate) struct Pool {
    entries: tokio::sync::Mutex<HashMap<String, Entry>>,
}

impl Pool {
    /// The connection for `profile`, connecting first if needed.
    pub async fn session(
        &self,
        host: &dyn Host,
        profile: &ConnectionProfile,
    ) -> AppResult<Arc<PgSession>> {
        let stale = {
            let mut entries = self.entries.lock().await;
            match entries.get_mut(&profile.id) {
                Some(entry) if entry.updated_at == profile.updated_at => {
                    entry.last_used = Instant::now();
                    return Ok(entry.session.clone());
                }
                Some(_) => entries.remove(&profile.id),
                None => None,
            }
        };
        if let Some(stale) = stale {
            close(stale.session, "the connection was edited").await;
        }

        let target = format!(
            "\"{}\" ({}) at {}",
            profile.name,
            profile.id,
            logging::route(profile)
        );
        log::info!("MCP server: connecting to {target}");
        let started = Instant::now();
        let state = host.app_state();
        let session =
            PgSession::connect(profile, state.secret_store.as_ref(), &state.known_hosts).await;
        let session = logging::logged(
            &format!(
                "MCP server: connecting to {target} ({} ms)",
                started.elapsed().as_millis()
            ),
            session,
        )?;
        let session = Arc::new(session);
        let replaced = self.entries.lock().await.insert(
            profile.id.clone(),
            Entry {
                session: session.clone(),
                updated_at: profile.updated_at.clone(),
                last_used: Instant::now(),
            },
        );
        // Another call connected at the same time; one connection is enough.
        if let Some(replaced) = replaced {
            close(replaced.session, "a newer connection replaced it").await;
        }
        Ok(session)
    }

    pub async fn close(&self, connection_id: &str, why: &str) {
        let entry = self.entries.lock().await.remove(connection_id);
        if let Some(entry) = entry {
            close(entry.session, why).await;
        }
    }

    /// Closes the connections `keep` says no to.
    pub async fn retain(&self, keep: impl Fn(&str) -> bool, why: &str) {
        let closed: Vec<Entry> = {
            let mut entries = self.entries.lock().await;
            let ids: Vec<String> = entries.keys().filter(|id| !keep(id)).cloned().collect();
            ids.iter().filter_map(|id| entries.remove(id)).collect()
        };
        for entry in closed {
            close(entry.session, why).await;
        }
    }

    pub async fn close_idle(&self, max_idle: Duration) {
        let closed: Vec<Entry> = {
            let mut entries = self.entries.lock().await;
            let ids: Vec<String> = entries
                .iter()
                .filter(|(_, e)| e.last_used.elapsed() >= max_idle)
                .map(|(id, _)| id.clone())
                .collect();
            ids.iter().filter_map(|id| entries.remove(id)).collect()
        };
        for entry in closed {
            close(entry.session, "it was idle").await;
        }
    }

    pub async fn close_all(&self, why: &str) {
        self.retain(|_| false, why).await;
    }

    #[cfg(test)]
    pub async fn len(&self) -> usize {
        self.entries.lock().await.len()
    }
}

async fn close(session: Arc<PgSession>, why: &str) {
    session.shutdown().await;
    log::info!(
        "MCP server: closed its connection to \"{}\": {why}",
        session.name
    );
}
