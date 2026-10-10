use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

use aes_gcm::aead::{Aead, Generate, Key, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine;
use keyring::v1::Entry as KeyringEntry;

const SERVICE_NAME: &str = "postgres-studio";
const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SecretKind {
    Password,
    SshPassword,
    SshKeyPassphrase,
}

impl SecretKind {
    pub(crate) const ALL: [SecretKind; 3] = [
        SecretKind::Password,
        SecretKind::SshPassword,
        SecretKind::SshKeyPassphrase,
    ];

    fn suffix(self) -> &'static str {
        match self {
            SecretKind::Password => "password",
            SecretKind::SshPassword => "ssh-password",
            SecretKind::SshKeyPassphrase => "ssh-key-passphrase",
        }
    }
}

fn entry_key(connection_id: &str, kind: SecretKind) -> String {
    format!("{connection_id}:{}", kind.suffix())
}

pub trait SecretStore: Send + Sync {
    fn set(&self, connection_id: &str, kind: SecretKind, value: &str) -> Result<(), String>;
    fn get(&self, connection_id: &str, kind: SecretKind) -> Result<Option<String>, String>;
    fn delete(&self, connection_id: &str, kind: SecretKind) -> Result<(), String>;

    fn delete_all(&self, connection_id: &str) -> Result<(), String> {
        for kind in SecretKind::ALL {
            self.delete(connection_id, kind)?;
        }
        Ok(())
    }
}

/// Backed by the OS keychain (macOS Keychain / Windows Credential Manager /
/// Linux Secret Service) via the `keyring` crate.
pub struct KeyringStore;

impl KeyringStore {
    /// Returns `Err` if no platform credential store is available, e.g.
    /// headless Linux with no Secret Service provider running.
    pub fn probe() -> Result<Self, String> {
        KeyringEntry::store_status()
            .as_ref()
            .map_err(|e| e.to_string())?;
        Ok(Self)
    }
}

/// Keychain failures are logged here, where the operation and the entry are
/// known; some callers ignore them (cleanup after a delete or a test).
/// The entry's key holds only the connection id and the kind of secret.
fn keyring_error(op: &str, connection_id: &str, kind: SecretKind, e: keyring::v1::Error) -> String {
    log::warn!(
        "keychain {op} of {} failed: {e}",
        entry_key(connection_id, kind)
    );
    e.to_string()
}

impl SecretStore for KeyringStore {
    fn set(&self, connection_id: &str, kind: SecretKind, value: &str) -> Result<(), String> {
        let entry = KeyringEntry::new(SERVICE_NAME, &entry_key(connection_id, kind))
            .map_err(|e| keyring_error("write", connection_id, kind, e))?;
        entry
            .set_password(value)
            .map_err(|e| keyring_error("write", connection_id, kind, e))
    }

    fn get(&self, connection_id: &str, kind: SecretKind) -> Result<Option<String>, String> {
        let entry = KeyringEntry::new(SERVICE_NAME, &entry_key(connection_id, kind))
            .map_err(|e| keyring_error("read", connection_id, kind, e))?;
        match entry.get_password() {
            Ok(password) => Ok(Some(password)),
            Err(keyring::v1::Error::NoEntry) => Ok(None),
            Err(e) => Err(keyring_error("read", connection_id, kind, e)),
        }
    }

    fn delete(&self, connection_id: &str, kind: SecretKind) -> Result<(), String> {
        let entry = KeyringEntry::new(SERVICE_NAME, &entry_key(connection_id, kind))
            .map_err(|e| keyring_error("delete", connection_id, kind, e))?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::v1::Error::NoEntry) => Ok(()),
            Err(e) => Err(keyring_error("delete", connection_id, kind, e)),
        }
    }
}

/// Fallback for platforms with no usable OS keychain (e.g. headless Linux).
/// Secrets are AES-256-GCM encrypted at rest with a machine-local key file
/// (0600 permissions on Unix); still weaker than a real OS keychain, which
/// is why the caller is expected to get explicit user consent before using it.
pub struct EncryptedFileStore {
    secrets_path: PathBuf,
    cipher: Aes256Gcm,
    cache: RwLock<HashMap<String, String>>,
}

impl EncryptedFileStore {
    pub fn new(config_dir: &Path) -> Result<Self, String> {
        fs::create_dir_all(config_dir).map_err(|e| e.to_string())?;
        let key = load_or_create_key(&config_dir.join("secret.key"))?;
        let cipher = Aes256Gcm::new(&Key::<Aes256Gcm>::from(key));
        Ok(Self {
            secrets_path: config_dir.join("secrets.enc.json"),
            cipher,
            cache: RwLock::new(HashMap::new()),
        })
    }

    fn read_map(&self) -> Result<HashMap<String, String>, String> {
        if !self.secrets_path.exists() {
            return Ok(HashMap::new());
        }
        let raw = fs::read_to_string(&self.secrets_path).map_err(|e| e.to_string())?;
        serde_json::from_str(&raw).map_err(|e| e.to_string())
    }

    fn write_map(&self, map: &HashMap<String, String>) -> Result<(), String> {
        let raw = serde_json::to_string_pretty(map).map_err(|e| e.to_string())?;
        fs::write(&self.secrets_path, raw).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let perms = fs::Permissions::from_mode(0o600);
            fs::set_permissions(&self.secrets_path, perms).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    fn encrypt(&self, plaintext: &str) -> Result<String, String> {
        let nonce = Nonce::generate();
        let ciphertext = self
            .cipher
            .encrypt(&nonce, plaintext.as_bytes())
            .map_err(|e| e.to_string())?;
        let mut combined: Vec<u8> = nonce.as_slice().to_vec();
        combined.extend(ciphertext);
        Ok(B64.encode(combined))
    }

    fn decrypt(&self, encoded: &str) -> Result<String, String> {
        let combined = B64.decode(encoded).map_err(|e| e.to_string())?;
        if combined.len() < 12 {
            return Err("corrupt secret entry".to_string());
        }
        let (nonce_bytes, ciphertext) = combined.split_at(12);
        let nonce_array: [u8; 12] = nonce_bytes
            .try_into()
            .map_err(|_| "corrupt secret entry".to_string())?;
        let nonce = Nonce::from(nonce_array);
        let plaintext = self
            .cipher
            .decrypt(&nonce, ciphertext)
            .map_err(|e| e.to_string())?;
        String::from_utf8(plaintext).map_err(|e| e.to_string())
    }
}

impl SecretStore for EncryptedFileStore {
    fn set(&self, connection_id: &str, kind: SecretKind, value: &str) -> Result<(), String> {
        let key = entry_key(connection_id, kind);
        let encrypted = self.encrypt(value)?;
        let mut map = self.read_map()?;
        map.insert(key.clone(), encrypted.clone());
        self.write_map(&map)?;
        self.cache.write().unwrap().insert(key, value.to_string());
        Ok(())
    }

    fn get(&self, connection_id: &str, kind: SecretKind) -> Result<Option<String>, String> {
        let key = entry_key(connection_id, kind);
        if let Some(cached) = self.cache.read().unwrap().get(&key) {
            return Ok(Some(cached.clone()));
        }
        let map = self.read_map()?;
        match map.get(&key) {
            Some(encoded) => {
                let plaintext = self.decrypt(encoded)?;
                self.cache.write().unwrap().insert(key, plaintext.clone());
                Ok(Some(plaintext))
            }
            None => Ok(None),
        }
    }

    fn delete(&self, connection_id: &str, kind: SecretKind) -> Result<(), String> {
        let key = entry_key(connection_id, kind);
        let mut map = self.read_map()?;
        map.remove(&key);
        self.write_map(&map)?;
        self.cache.write().unwrap().remove(&key);
        Ok(())
    }
}

fn load_or_create_key(path: &Path) -> Result<[u8; 32], String> {
    if path.exists() {
        let raw = fs::read(path).map_err(|e| e.to_string())?;
        raw.try_into()
            .map_err(|_| "secret.key is corrupt (wrong length)".to_string())
    } else {
        let key = Key::<Aes256Gcm>::generate();
        let bytes: [u8; 32] = key
            .as_slice()
            .try_into()
            .map_err(|_| "key generation failed".to_string())?;
        fs::write(path, bytes).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o600))
                .map_err(|e| e.to_string())?;
        }
        Ok(bytes)
    }
}

/// Test/development double that never touches the OS keychain or disk.
#[cfg(test)]
pub struct InMemoryStore {
    map: RwLock<HashMap<String, String>>,
}

#[cfg(test)]
impl InMemoryStore {
    pub fn new() -> Self {
        Self {
            map: RwLock::new(HashMap::new()),
        }
    }

    /// How many secrets are stored, to catch ones left behind.
    pub fn len(&self) -> usize {
        self.map.read().unwrap().len()
    }
}

#[cfg(test)]
impl SecretStore for InMemoryStore {
    fn set(&self, connection_id: &str, kind: SecretKind, value: &str) -> Result<(), String> {
        self.map
            .write()
            .unwrap()
            .insert(entry_key(connection_id, kind), value.to_string());
        Ok(())
    }

    fn get(&self, connection_id: &str, kind: SecretKind) -> Result<Option<String>, String> {
        Ok(self
            .map
            .read()
            .unwrap()
            .get(&entry_key(connection_id, kind))
            .cloned())
    }

    fn delete(&self, connection_id: &str, kind: SecretKind) -> Result<(), String> {
        self.map
            .write()
            .unwrap()
            .remove(&entry_key(connection_id, kind));
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn in_memory_store_roundtrips() {
        let store = InMemoryStore::new();
        store.set("conn1", SecretKind::Password, "hunter2").unwrap();
        assert_eq!(
            store.get("conn1", SecretKind::Password).unwrap(),
            Some("hunter2".to_string())
        );
        store.delete("conn1", SecretKind::Password).unwrap();
        assert_eq!(store.get("conn1", SecretKind::Password).unwrap(), None);
    }

    #[test]
    fn encrypted_file_store_roundtrips() {
        let dir =
            std::env::temp_dir().join(format!("postgres-studio-test-{}", uuid::Uuid::new_v4()));
        let store = EncryptedFileStore::new(&dir).unwrap();
        store
            .set("conn1", SecretKind::SshPassword, "s3cret")
            .unwrap();
        assert_eq!(
            store.get("conn1", SecretKind::SshPassword).unwrap(),
            Some("s3cret".to_string())
        );

        // A fresh store instance (simulating app restart) must decrypt
        // using the same persisted key, not just the in-process cache.
        let store2 = EncryptedFileStore::new(&dir).unwrap();
        assert_eq!(
            store2.get("conn1", SecretKind::SshPassword).unwrap(),
            Some("s3cret".to_string())
        );

        std::fs::remove_dir_all(&dir).ok();
    }
}
