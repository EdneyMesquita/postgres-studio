//! Folders that programs other than the app must see too.
//!
//! Installed from the Microsoft Store, the app runs as an MSIX package, and
//! Windows redirects what it writes under AppData into a private folder of
//! the package. The app finds its files where it wrote them; other programs
//! look at the real AppData and find nothing there. That broke two things:
//! the agent CLI the Assistant starts ("Can't access working directory ...
//! does not exist") and the file manager opening the logs folder. Folders
//! shared with other programs therefore go in the package's own LocalState
//! when packaged: every program sees it at the same path, and Windows
//! removes it with the app.

use std::path::{Path, PathBuf};

/// The package's LocalState folder when the app runs from an MSIX install,
/// `None` otherwise (an MSI/NSIS install, macOS, Linux, a dev build).
pub fn package_state_dir() -> Option<PathBuf> {
    if !cfg!(windows) {
        return None;
    }
    let family = family_from_exe(&std::env::current_exe().ok()?)?;
    let local = std::env::var_os("LOCALAPPDATA")?;
    Some(
        PathBuf::from(local)
            .join("Packages")
            .join(family)
            .join("LocalState"),
    )
}

/// Where a folder the app shares with other programs goes: the package's
/// LocalState when packaged, otherwise `default`.
pub fn shared_dir(default: PathBuf, name: &str) -> PathBuf {
    package_state_dir().map_or(default, |dir| dir.join(name))
}

/// The package family name, `Name_PublisherId`, of an executable installed
/// as `...\WindowsApps\Name_Version_Arch_ResourceId_PublisherId\app.exe`.
/// Package names can't contain `_`, so the folder splits into those five.
fn family_from_exe(exe: &Path) -> Option<String> {
    let text = exe.to_string_lossy();
    let mut parts = text.rsplit(['\\', '/']);
    let _file = parts.next()?;
    let full_name = parts.next()?;
    if !parts.next()?.eq_ignore_ascii_case("WindowsApps") {
        return None;
    }
    let fields: Vec<&str> = full_name.split('_').collect();
    match fields.as_slice() {
        [name, _version, _arch, _resource, publisher]
            if !name.is_empty() && !publisher.is_empty() =>
        {
            Some(format!("{name}_{publisher}"))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_family_name_of_a_store_install() {
        let exe = Path::new(
            r"C:\Program Files\WindowsApps\NilPointer.PostgresStudio_1.0.1.0_x64__8wekyb3d8bbwe\postgres-studio.exe",
        );
        assert_eq!(
            family_from_exe(exe).as_deref(),
            Some("NilPointer.PostgresStudio_8wekyb3d8bbwe")
        );
    }

    #[test]
    fn other_installs_are_not_packaged() {
        for exe in [
            r"C:\Program Files\Postgres Studio\postgres-studio.exe",
            r"C:\Users\me\AppData\Local\Postgres Studio\postgres-studio.exe",
            r"C:\Program Files\WindowsApps\postgres-studio.exe",
            r"C:\Program Files\WindowsApps\Broken_1.0_x64\postgres-studio.exe",
            "/usr/bin/postgres-studio",
            "postgres-studio",
        ] {
            assert_eq!(family_from_exe(Path::new(exe)), None, "{exe}");
        }
    }

    #[test]
    fn shared_folders_stay_put_outside_a_package() {
        // Tests never run from an MSIX install.
        let default = PathBuf::from("/data/assistant");
        assert_eq!(shared_dir(default.clone(), "assistant"), default);
    }
}
