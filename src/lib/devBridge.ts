/**
 * Development only: in a plain browser tab (`npm run dev`, no Tauri window)
 * there is no IPC, so this stands one in that forwards every command to the
 * devbridge binary (src-tauri/src/devbridge.rs), which runs the real
 * commands against real databases. The events the backend emits come back
 * through a long poll of `GET /events`; native dialogs become a prompt for a
 * path. Nothing here ships: the whole module is dropped from production
 * builds.
 */

const BRIDGE = "http://127.0.0.1:1430";

interface TauriInternals {
  transformCallback: (cb: (payload: unknown) => void) => number;
  unregisterCallback: (id: number) => void;
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  metadata: { currentWindow: { label: string }; currentWebview: { label: string; windowLabel: string } };
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: TauriInternals;
  }
}

if (import.meta.env.DEV && typeof window !== "undefined" && !window.__TAURI_INTERNALS__) {
  let nextId = 1;
  const callbacks = new Map<number, (payload: unknown) => void>();
  /** listen() registrations: event id -> the event name and its callback id. */
  const listeners = new Map<number, { event: string; handler: number }>();
  let polling = false;

  async function pollEvents() {
    if (polling) return;
    polling = true;
    for (;;) {
      try {
        const response = await fetch(`${BRIDGE}/events`);
        const events = (await response.json()) as { event: string; payload: unknown }[];
        for (const { event, payload } of events) {
          for (const [id, l] of listeners) {
            if (l.event === event) callbacks.get(l.handler)?.({ event, id, payload });
          }
        }
      } catch {
        // the bridge restarted or isn't up yet
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }
  (window as unknown as { __TAURI_EVENT_PLUGIN_INTERNALS__: unknown }).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: () => {},
  };
  window.__TAURI_INTERNALS__ = {
    transformCallback: (cb) => {
      const id = nextId++;
      callbacks.set(id, cb);
      return id;
    },
    unregisterCallback: (id) => {
      callbacks.delete(id);
    },
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
    invoke: async (cmd, args = {}) => {
      if (cmd === "plugin:event|listen") {
        const { event, handler } = args as { event: string; handler: number };
        const id = nextId++;
        listeners.set(id, { event, handler });
        void pollEvents();
        return id;
      }
      if (cmd === "plugin:event|unlisten") {
        listeners.delete((args as { eventId: number }).eventId);
        return null;
      }
      if (cmd.startsWith("plugin:event|") || cmd.startsWith("plugin:log|") || cmd.startsWith("plugin:opener|")) {
        return null;
      }
      if (cmd === "plugin:dialog|open" || cmd === "plugin:dialog|save") {
        return window.prompt(`${cmd === "plugin:dialog|save" ? "Save to" : "Open"} (path on this machine):`) || null;
      }
      if (cmd === "plugin:dialog|ask" || cmd === "plugin:dialog|confirm") {
        return window.confirm(String((args as { message?: string }).message ?? "Continue?"));
      }
      if (cmd === "plugin:dialog|message") return null;
      const response = await fetch(BRIDGE, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cmd, args }),
      }).catch(() => {
        throw `The dev bridge isn't running: cargo run --features devbridge --bin devbridge (in src-tauri)`;
      });
      const answer = (await response.json()) as { ok?: unknown; err?: unknown };
      if ("err" in answer) throw answer.err;
      return answer.ok;
    },
  };
}

export {};
