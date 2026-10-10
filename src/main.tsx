// First: in a plain browser during development, stands in for the Tauri IPC.
import "./lib/devBridge";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { AppErrorBoundary } from "./components/layout/AppErrorBoundary";
import "./lib/monaco";
import "./index.css";
import { installErrorLogging } from "./lib/log";
import { applyTheme, getStoredTheme } from "./lib/themes";

installErrorLogging();
applyTheme(getStoredTheme());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </React.StrictMode>,
);
