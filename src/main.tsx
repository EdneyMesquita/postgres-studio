// First: in a plain browser during development, stands in for the Tauri IPC.
import "./lib/devBridge";
import React, { useEffect } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { AppErrorBoundary } from "./components/layout/AppErrorBoundary";
import "./index.css";
import { installErrorLogging } from "./lib/log";
import { applyTheme, getStoredTheme } from "./lib/themes";
import { rememberWindowSize } from "./lib/windowSize";

installErrorLogging();
applyTheme(getStoredTheme());
rememberWindowSize();

/** Marks the first commit, so startup can be measured (scripts/bench.mjs, the README). */
function MountMark() {
  useEffect(() => {
    performance.mark("app-mounted");
  }, []);
  return null;
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <App />
      <MountMark />
    </AppErrorBoundary>
  </React.StrictMode>,
);
