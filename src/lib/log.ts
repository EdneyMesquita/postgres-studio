import { error as logError } from "@tauri-apps/plugin-log";

/** Long enough for a stack trace, short enough not to flood the log. */
const MAX_MESSAGE = 4000;

function describe(err: unknown): string {
  if (err instanceof Error) {
    const stack = err.stack ?? "";
    // V8 stacks start with "Name: message"; don't print it twice.
    return stack.startsWith(`${err.name}: ${err.message}`) ? stack : `${err.name}: ${err.message}\n${stack}`;
  }
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err) ?? String(err);
  } catch {
    return String(err);
  }
}

/**
 * Writes a frontend failure to the app's log file. Never throws: without
 * the Tauri IPC (the plain-browser dev mock) there is nowhere to write,
 * and a failure to log must not become another unhandled rejection.
 */
export function reportError(context: string, err: unknown, detail?: string) {
  let message = `${context}: ${describe(err)}`;
  if (detail) message += `\n${detail}`;
  try {
    logError(message.slice(0, MAX_MESSAGE)).catch(() => {});
  } catch {
    // no IPC at all
  }
}

/** Sends uncaught errors and unhandled promise rejections to the log. */
export function installErrorLogging() {
  window.addEventListener("error", (event) => {
    reportError("Uncaught error", event.error ?? event.message);
  });
  window.addEventListener("unhandledrejection", (event) => {
    // A string reason is a backend command's error, which the backend has
    // already logged without the user data a query error can quote.
    const reason =
      typeof event.reason === "string"
        ? "a backend command failed and nothing handled it (its error is logged by the backend)"
        : event.reason;
    reportError("Unhandled promise rejection", reason);
  });
}
