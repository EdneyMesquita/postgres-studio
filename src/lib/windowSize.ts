import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * Reports the page's viewport once a resize settles, for the next start
 * (src-tauri/src/window_size.rs). Not while maximized or full screen: the
 * window state plugin brings those back, and unmaximizing returns to this.
 */
export function rememberWindowSize() {
  let timer: number | undefined;
  window.addEventListener("resize", () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(async () => {
      try {
        const current = getCurrentWindow();
        if ((await current.isMaximized()) || (await current.isFullscreen())) return;
        await invoke("remember_window_size", { width: window.innerWidth, height: window.innerHeight });
      } catch {
        // outside the app (a browser tab in development), or closing
      }
    }, 500);
  });
}
