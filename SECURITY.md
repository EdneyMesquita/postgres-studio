# Security

## Reporting a vulnerability

Please email **edneyphp@gmail.com** rather than opening a public issue. Include what you found, how to reproduce it, and its impact if you can. This is a young, single-maintainer project without a formal SLA, but reports will be acknowledged and fixed as quickly as reasonably possible.

## How secrets are stored

Connection passwords, TLS client-key passphrases, and SSH credentials are never written to `connections.json` in plaintext. They go through, in order of preference:

1. **The OS keychain** - macOS Keychain, Windows Credential Manager, or the Linux Secret Service (via `gnome-keyring`/`kwallet`), through the [`keyring`](https://crates.io/crates/keyring) crate.
2. **An encrypted file fallback**, used only when no OS keychain backend is available (common on headless Linux). Secrets are AES-256-GCM encrypted with a machine-local key file (`0600` permissions on Unix). This is weaker than a real OS keychain - anyone with read access to your user account's app config directory and enough patience can decrypt it - but is still meaningfully better than plaintext.

The app reports which backend is active; if it's the encrypted-file fallback, you'll see a warning banner in the sidebar.

## SSH tunneling

Host keys are pinned on first connect (trust-on-first-use) and checked on every subsequent connection to that host. If a host's key changes, the connection is refused with an explicit mismatch error rather than silently trusting the new key - this could mean the server was legitimately reconfigured, or that something is intercepting the connection. Don't remove the stale entry from `ssh_known_hosts.json` unless you're sure the change is legitimate.

## Known limitations

- No code signing yet, so release builds are unsigned. Download only from <https://pgstudio.nilpointer.tech>, the Microsoft Store listing, or this repository's Releases page.
- Kerberos (GSSAPI) authentication is not compiled in by default, so it isn't a relevant attack surface for the distributed builds.
