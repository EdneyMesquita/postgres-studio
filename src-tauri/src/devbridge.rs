//! A development-only HTTP bridge to the real commands.
//!
//! `npm run dev` in a plain browser has no Tauri IPC; with this running,
//! `src/lib/devBridge.ts` forwards every `invoke` to it, so the UI can be
//! exercised against a real database from a browser tab. It builds the app
//! on Tauri's mock runtime (no window) with the same commands and state,
//! keeps its own config folder, and listens on 127.0.0.1 only, answering
//! only the Vite dev page (or a request without an Origin, like curl). The
//! events the backend emits (export progress, the Assistant's stream) wait
//! in a queue the page long-polls with `GET /events`.

use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{
    get_ipc_response, mock_builder, mock_context, noop_assets, MockRuntime, INVOKE_KEY,
};
use tauri::webview::InvokeRequest;
use tauri::{Listener, Manager, WebviewWindow};

const ADDR: &str = "127.0.0.1:1430";
/// The Vite dev server's page (`npm run dev -- --port 1421`, or tauri dev's 1420).
const ORIGINS: [&str; 4] = [
    "http://localhost:1421",
    "http://127.0.0.1:1421",
    "http://localhost:1420",
    "http://127.0.0.1:1420",
];
/// Every event the backend emits to the window.
const EVENTS: [&str; 5] = [
    crate::assistant::EVENT,
    crate::assistant::STEP_EVENT,
    crate::assistant::APPROVAL_EVENT,
    crate::assistant::APPROVAL_CLOSED_EVENT,
    "export-progress",
];

/// Events waiting for the page's next `GET /events`.
#[derive(Default)]
struct EventQueue {
    events: Mutex<VecDeque<Value>>,
    ready: Condvar,
}

impl EventQueue {
    fn push(&self, event: Value) {
        let mut events = self.events.lock().expect("event queue poisoned");
        // nobody polling (no page open): keep the newest only
        if events.len() >= 5000 {
            events.pop_front();
        }
        events.push_back(event);
        self.ready.notify_all();
    }

    /// Whatever is queued, waiting up to `wait` for something to arrive.
    fn drain(&self, wait: Duration) -> Vec<Value> {
        let events = self.events.lock().expect("event queue poisoned");
        let (mut events, _) = self
            .ready
            .wait_timeout_while(events, wait, |e| e.is_empty())
            .expect("event queue poisoned");
        events.drain(..).collect()
    }
}

pub fn run() {
    let app = super::with_commands(mock_builder())
        .build(mock_context(noop_assets()))
        .expect("failed to build the mock app");
    // The mock runtime doesn't run `setup` hooks, so state goes in here.
    let home = app.path().home_dir().expect("no home folder");
    let dir = home.join(".config/postgres-studio-devbridge");
    app.manage(crate::state::AppState::init(&dir).expect("can't open the config folder"));
    app.manage(crate::saved_scripts::SavedScriptsStore::load(&dir, &home).expect("scripts store"));
    app.manage(crate::sidebar_layout::SidebarLayoutStore::load(&dir).expect("layout store"));
    app.manage(crate::assistant::Assistant::new(
        Arc::new(app.handle().clone()),
        dir.join("assistant"),
    ));
    println!("devbridge config folder: {}", dir.display());
    let queue = Arc::new(EventQueue::default());
    for name in EVENTS {
        let queue = queue.clone();
        app.listen_any(name, move |event| {
            let payload = serde_json::from_str(event.payload()).unwrap_or(Value::Null);
            queue.push(json!({ "event": name, "payload": payload }));
        });
    }
    let webview = Arc::new(
        tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("failed to build the mock window"),
    );
    let listener = TcpListener::bind(ADDR).expect("can't listen on 127.0.0.1:1430");
    println!("devbridge listening on http://{ADDR}");
    for stream in listener.incoming().flatten() {
        let webview = webview.clone();
        let queue = queue.clone();
        std::thread::spawn(move || {
            if let Err(e) = serve(stream, &webview, &queue) {
                eprintln!("devbridge: {e}");
            }
        });
    }
}

fn serve(
    mut stream: TcpStream,
    webview: &WebviewWindow<MockRuntime>,
    queue: &EventQueue,
) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut request_line = String::new();
    reader.read_line(&mut request_line)?;
    let mut length = 0usize;
    let mut origin: Option<String> = None;
    loop {
        let mut line = String::new();
        reader.read_line(&mut line)?;
        let line = line.trim_end();
        if line.is_empty() {
            break;
        }
        if let Some((k, v)) = line.split_once(':') {
            if k.eq_ignore_ascii_case("content-length") {
                length = v.trim().parse().unwrap_or(0);
            } else if k.eq_ignore_ascii_case("origin") {
                origin = Some(v.trim().to_string());
            }
        }
    }
    // Any other page open in a browser could reach 127.0.0.1 too, and run
    // commands with the saved credentials: only the dev page gets in.
    let origin = match origin {
        Some(o) if ORIGINS.contains(&o.as_str()) => Some(o),
        Some(_) => return respond(&mut stream, 403, None, r#"{"err":"origin not allowed"}"#),
        None => None,
    };
    let origin = origin.as_deref();
    if request_line.starts_with("OPTIONS") {
        return respond(&mut stream, 204, origin, "");
    }
    if request_line.starts_with("GET /events") {
        let events = queue.drain(Duration::from_secs(25));
        return respond(&mut stream, 200, origin, &Value::from(events).to_string());
    }
    let mut body = vec![0; length];
    reader.read_exact(&mut body)?;
    let call: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let cmd = call["cmd"].as_str().unwrap_or_default().to_string();
    let args = call.get("args").cloned().unwrap_or(json!({}));
    let response = get_ipc_response(
        webview,
        InvokeRequest {
            cmd,
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: "tauri://localhost".parse().expect("valid url"),
            body: InvokeBody::Json(args),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        },
    );
    let payload = match response {
        Ok(body) => json!({ "ok": body.deserialize::<Value>().unwrap_or(Value::Null) }),
        Err(err) => json!({ "err": err }),
    };
    respond(&mut stream, 200, origin, &payload.to_string())
}

fn respond(
    stream: &mut TcpStream,
    status: u16,
    origin: Option<&str>,
    body: &str,
) -> std::io::Result<()> {
    let cors = origin
        .map(|o| {
            format!(
                "Access-Control-Allow-Origin: {o}\r\nVary: Origin\r\n\
                 Access-Control-Allow-Headers: content-type\r\n\
                 Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
            )
        })
        .unwrap_or_default();
    write!(
        stream,
        "HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\n{cors}\
         Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}
