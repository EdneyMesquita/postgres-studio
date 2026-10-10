//! The window's size between runs, measured as the page's own viewport.
//!
//! tauri-plugin-window-state keeps the maximized state and the position, but
//! not the size: on Wayland with client-side decorations it reads the size
//! with the shadow around the window and restores it as the content size,
//! so the window grew with every start (1100x680 came back as 1190x813).
//! The page reports `innerWidth`/`innerHeight` (CSS pixels, the webview's
//! content) and the window is set to that logical size before it shows,
//! which is the same quantity both ways on every platform.

use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, LogicalSize, Manager, Runtime, WebviewWindow};

use crate::error::{AppError, AppResult};

const FILE: &str = "window-size.json";
/// tauri.conf.json's minimum; anything smaller is a stale or broken value.
const MIN: (f64, f64) = (900.0, 600.0);
const MAX: f64 = 16_384.0;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
struct Saved {
    width: f64,
    height: f64,
}

fn sane(width: f64, height: f64) -> Option<Saved> {
    let ok = |v: f64, min: f64| v.is_finite() && v >= min && v <= MAX;
    (ok(width, MIN.0) && ok(height, MIN.1)).then_some(Saved { width, height })
}

/// Sizes the window as it was last time, before it shows. Nothing saved, or
/// nothing usable, leaves tauri.conf.json's size.
pub fn restore<R: Runtime>(window: &WebviewWindow<R>, config_dir: &Path) {
    let Ok(text) = std::fs::read_to_string(config_dir.join(FILE)) else {
        return;
    };
    let Some(saved) = serde_json::from_str::<Saved>(&text)
        .ok()
        .and_then(|s| sane(s.width, s.height))
    else {
        log::warn!("ignoring an unusable {FILE}");
        return;
    };
    if let Err(e) = window.set_size(LogicalSize::new(saved.width, saved.height)) {
        log::warn!("couldn't restore the window's size: {e}");
    }
}

/// The page's viewport after a resize settles (not while maximized or full
/// screen: the plugin restores those, and unmaximizing goes back to this).
#[tauri::command]
pub async fn remember_window_size<R: Runtime>(
    app: AppHandle<R>,
    width: f64,
    height: f64,
) -> AppResult<()> {
    let saved = sane(width, height)
        .ok_or_else(|| AppError::InvalidInput(format!("window size {width}x{height}")))?;
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::InvalidInput(e.to_string()))?;
    std::fs::create_dir_all(&dir)?;
    let tmp = dir.join(format!("{FILE}.tmp"));
    std::fs::write(&tmp, serde_json::to_vec(&saved).expect("plain numbers"))?;
    std::fs::rename(tmp, dir.join(FILE))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_only_usable_sizes() {
        assert_eq!(
            sane(1100.0, 680.0),
            Some(Saved {
                width: 1100.0,
                height: 680.0
            })
        );
        assert_eq!(sane(899.0, 680.0), None);
        assert_eq!(sane(1100.0, f64::NAN), None);
        assert_eq!(sane(1e9, 700.0), None);
    }
}
