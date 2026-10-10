//! The MCP server the agents reach the database through: streamable HTTP
//! (JSON-RPC 2.0 over POST, answered with plain JSON - no SSE stream) on
//! 127.0.0.1, one listener for the whole app, started on first use.
//!
//! Every request must carry `Authorization: Bearer <token>` of a live
//! Assistant session; the token is what picks the connection and database a
//! tool call reads. Requests whose `Host` (or `Origin`) isn't this loopback
//! address are refused, so a web page can't reach the server through DNS
//! rebinding.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};

use super::http::{self, Head, ReadError, Response};
use super::{tools, AgentSession, Inner};
use crate::error::{AppError, AppResult};

pub(crate) const PATH: &str = "/mcp";
/// How long an idle keep-alive connection is kept.
const IDLE_TIMEOUT: Duration = Duration::from_secs(300);
const DEFAULT_PROTOCOL_VERSION: &str = "2025-06-18";

/// Starts the server unless it's running; returns its port.
pub(crate) async fn ensure_server(inner: &Arc<Inner>) -> AppResult<u16> {
    let mut server = inner.server.lock().await;
    if let Some(port) = *server {
        return Ok(port);
    }
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|e| AppError::Assistant(format!("Couldn't start the Assistant's server: {e}")))?;
    let port = listener.local_addr()?.port();
    log::info!("Assistant tool server listening on 127.0.0.1:{port}");
    let inner_for_loop = inner.clone();
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                continue;
            };
            let inner = inner_for_loop.clone();
            tokio::spawn(serve_connection(inner, stream, port));
        }
    });
    *server = Some(port);
    Ok(port)
}

pub(crate) fn url(port: u16) -> String {
    format!("http://127.0.0.1:{port}{PATH}")
}

async fn serve_connection(inner: Arc<Inner>, stream: TcpStream, port: u16) {
    let _ = stream.set_nodelay(true);
    let (read, mut write) = stream.into_split();
    let mut reader = BufReader::new(read);
    loop {
        let head = match tokio::time::timeout(IDLE_TIMEOUT, http::read_head(&mut reader)).await {
            Err(_) | Ok(Err(ReadError::Closed)) | Ok(Err(ReadError::Io)) => return,
            Ok(Err(e)) => {
                let _ = write
                    .write_all(&read_error_response(e).to_bytes(false))
                    .await;
                return;
            }
            Ok(Ok(head)) => head,
        };
        if head.expects_continue()
            && write
                .write_all(b"HTTP/1.1 100 Continue\r\n\r\n")
                .await
                .is_err()
        {
            return;
        }
        let body = match http::read_body(&mut reader, &head).await {
            Ok(body) => body,
            Err(ReadError::Closed | ReadError::Io) => return,
            Err(e) => {
                let _ = write
                    .write_all(&read_error_response(e).to_bytes(false))
                    .await;
                return;
            }
        };
        let keep_alive = head.keep_alive();
        let response = handle(&inner, port, &head, &body).await;
        if write
            .write_all(&response.to_bytes(keep_alive))
            .await
            .is_err()
            || !keep_alive
        {
            return;
        }
    }
}

fn read_error_response(error: ReadError) -> Response {
    match error {
        ReadError::TooLarge => Response::text(413, "request too large"),
        ReadError::Malformed(why) => Response::text(400, why),
        ReadError::Closed | ReadError::Io => Response::empty(400),
    }
}

/// Whether a `Host` header names this server: 127.0.0.1 or localhost, on
/// its port.
fn host_allowed(host: Option<&str>, port: u16) -> bool {
    let Some(host) = host else {
        return false;
    };
    let (name, host_port) = match host.rsplit_once(':') {
        Some((name, p)) => (name, Some(p)),
        None => (host, None),
    };
    let name_ok = name == "127.0.0.1" || name.eq_ignore_ascii_case("localhost");
    let port_ok = host_port.is_none_or(|p| p.parse::<u16>().ok() == Some(port));
    name_ok && port_ok
}

/// Browsers send `Origin`; the CLIs don't. One that's present must be
/// this server's own.
fn origin_allowed(origin: Option<&str>, port: u16) -> bool {
    match origin {
        None => true,
        Some(origin) => origin
            .strip_prefix("http://")
            .is_some_and(|host| host_allowed(Some(host), port)),
    }
}

fn bearer(head: &Head) -> Option<&str> {
    let value = head.header("authorization")?.trim();
    let (scheme, token) = value.split_once(' ')?;
    scheme
        .eq_ignore_ascii_case("bearer")
        .then(|| token.trim())
        .filter(|t| !t.is_empty())
}

async fn handle(inner: &Arc<Inner>, port: u16, head: &Head, body: &[u8]) -> Response {
    if !host_allowed(head.header("host"), port) || !origin_allowed(head.header("origin"), port) {
        return Response::text(403, "forbidden");
    }
    if head.path != PATH {
        return Response::text(404, "not found");
    }
    let Some(session) = bearer(head).and_then(|t| inner.session_by_token(t)) else {
        return Response::text(401, "unauthorized")
            .with_header("WWW-Authenticate", "Bearer realm=\"postgres-studio\"");
    };
    match head.method.as_str() {
        "POST" => {
            let message: Value = match serde_json::from_slice(body) {
                Ok(v) => v,
                Err(e) => {
                    return Response::json(
                        400,
                        &rpc_error(Value::Null, -32700, &format!("Parse error: {e}")),
                    )
                }
            };
            match handle_payload(inner, &session, message).await {
                Some(answer) => Response::json(200, &answer),
                None => Response::empty(202),
            }
        }
        // No server-initiated stream is offered.
        "GET" => Response::empty(405).with_header("Allow", "POST, DELETE"),
        "DELETE" => Response::empty(200),
        _ => Response::empty(405).with_header("Allow", "POST, DELETE"),
    }
}

/// A single message or a batch; `None` when nothing needs answering.
pub(crate) async fn handle_payload(
    inner: &Arc<Inner>,
    session: &Arc<AgentSession>,
    payload: Value,
) -> Option<Value> {
    match payload {
        Value::Array(messages) => {
            if messages.is_empty() {
                return Some(rpc_error(Value::Null, -32600, "Invalid Request"));
            }
            let mut answers = Vec::new();
            for message in messages {
                if let Some(answer) = handle_message(inner, session, message).await {
                    answers.push(answer);
                }
            }
            (!answers.is_empty()).then_some(Value::Array(answers))
        }
        message => handle_message(inner, session, message).await,
    }
}

pub(crate) async fn handle_message(
    inner: &Arc<Inner>,
    session: &Arc<AgentSession>,
    message: Value,
) -> Option<Value> {
    let Value::Object(message) = message else {
        return Some(rpc_error(Value::Null, -32600, "Invalid Request"));
    };
    let id = message.get("id").cloned();
    let Some(method) = message.get("method").and_then(Value::as_str) else {
        // A response to a request this server never makes, or garbage.
        return id.map(|id| rpc_error(id, -32600, "Invalid Request"));
    };
    // Notifications (initialized, cancelled, ...) need no answer.
    let id = id?;
    let params = message.get("params").cloned().unwrap_or(Value::Null);

    let result = match method {
        "initialize" => {
            let version = params
                .get("protocolVersion")
                .and_then(Value::as_str)
                .unwrap_or(DEFAULT_PROTOCOL_VERSION);
            json!({
                "protocolVersion": version,
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "postgres-studio", "version": env!("CARGO_PKG_VERSION") },
                "instructions": tools::INSTRUCTIONS,
            })
        }
        "ping" => json!({}),
        "tools/list" => json!({ "tools": tools::definitions() }),
        "tools/call" => {
            let Some(name) = params.get("name").and_then(Value::as_str) else {
                return Some(rpc_error(id, -32602, "Missing tool name"));
            };
            let args = params.get("arguments").cloned().unwrap_or(Value::Null);
            match tools::call(inner, session, name, args).await {
                Some(output) => json!({
                    "content": [{ "type": "text", "text": output.text }],
                    "isError": output.is_error,
                }),
                None => return Some(rpc_error(id, -32602, &format!("Unknown tool: {name}"))),
            }
        }
        _ => {
            return Some(rpc_error(
                id,
                -32601,
                &format!("Method not found: {method}"),
            ))
        }
    };
    Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
}

fn rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

#[cfg(test)]
mod tests {
    use super::super::test_support::{inner_with, session, RecordingHost};
    use super::super::AssistantPolicy;
    use super::*;
    use tokio::io::AsyncReadExt;

    fn setup() -> (Arc<AgentSession>, Arc<Inner>) {
        let session = session("shop", "c1");
        let inner = inner_with(
            Arc::new(RecordingHost::default()),
            &session,
            AssistantPolicy {
                allowed_connections: vec!["c1".into()],
                ..Default::default()
            },
        );
        (session, inner)
    }

    #[tokio::test]
    async fn initialize_echoes_the_protocol_version() {
        let (session, inner) = setup();
        let answer = handle_message(
            &inner,
            &session,
            json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
                "protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": { "name": "t", "version": "1" }
            } }),
        )
        .await
        .unwrap();
        assert_eq!(answer["id"], 1);
        assert_eq!(answer["result"]["protocolVersion"], "2025-03-26");
        assert_eq!(answer["result"]["capabilities"], json!({ "tools": {} }));
        assert_eq!(answer["result"]["serverInfo"]["name"], "postgres-studio");
        assert!(answer["result"]["instructions"]
            .as_str()
            .unwrap()
            .contains("describe_table"));
    }

    #[tokio::test]
    async fn lists_the_six_tools() {
        let (session, inner) = setup();
        let answer = handle_message(
            &inner,
            &session,
            json!({ "jsonrpc": "2.0", "id": "a", "method": "tools/list" }),
        )
        .await
        .unwrap();
        let names: Vec<&str> = answer["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap())
            .collect();
        assert_eq!(
            names,
            [
                "list_tables",
                "describe_table",
                "explain",
                "count",
                "dry_run",
                "query"
            ]
        );
    }

    #[tokio::test]
    async fn notifications_unknown_methods_and_batches() {
        let (session, inner) = setup();
        let none = handle_message(
            &inner,
            &session,
            json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
        )
        .await;
        assert!(none.is_none());

        let answer = handle_message(
            &inner,
            &session,
            json!({ "jsonrpc": "2.0", "id": 7, "method": "resources/list" }),
        )
        .await
        .unwrap();
        assert_eq!(answer["error"]["code"], -32601);

        let answer = handle_message(
            &inner,
            &session,
            json!({ "jsonrpc": "2.0", "id": 8, "method": "tools/call", "params": { "name": "drop_database" } }),
        )
        .await
        .unwrap();
        assert_eq!(answer["error"]["code"], -32602);

        let batch = handle_payload(
            &inner,
            &session,
            json!([
                { "jsonrpc": "2.0", "method": "notifications/initialized" },
                { "jsonrpc": "2.0", "id": 1, "method": "ping" }
            ]),
        )
        .await
        .unwrap();
        assert_eq!(batch, json!([{ "jsonrpc": "2.0", "id": 1, "result": {} }]));
    }

    #[tokio::test]
    async fn tool_failures_are_results_not_rpc_errors() {
        let (session, inner) = setup();
        let answer = handle_message(
            &inner,
            &session,
            json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {
                "name": "explain", "arguments": { "collection": "orders" }
            } }),
        )
        .await
        .unwrap();
        assert_eq!(answer["result"]["isError"], true);
        assert_eq!(answer["result"]["content"][0]["type"], "text");
    }

    #[test]
    fn host_and_origin_checks() {
        assert!(host_allowed(Some("127.0.0.1:4000"), 4000));
        assert!(host_allowed(Some("localhost:4000"), 4000));
        assert!(host_allowed(Some("LOCALHOST"), 4000));
        assert!(!host_allowed(Some("127.0.0.1:4001"), 4000));
        assert!(!host_allowed(Some("evil.example:4000"), 4000));
        assert!(!host_allowed(None, 4000));
        assert!(origin_allowed(None, 4000));
        assert!(origin_allowed(Some("http://localhost:4000"), 4000));
        assert!(!origin_allowed(Some("https://evil.example"), 4000));
    }

    async fn roundtrip(port: u16, request: String) -> String {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut response = Vec::new();
        stream.read_to_end(&mut response).await.unwrap();
        String::from_utf8(response).unwrap()
    }

    #[tokio::test]
    async fn serves_over_http_with_auth_and_host_checks() {
        let (session, inner) = setup();
        let port = ensure_server(&inner).await.unwrap();
        assert_eq!(ensure_server(&inner).await.unwrap(), port, "started once");
        let body = r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#;
        let post = |host: &str, token: &str| {
            format!(
                "POST /mcp HTTP/1.1\r\nHost: {host}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}",
                body.len()
            )
        };

        let ok = roundtrip(port, post(&format!("127.0.0.1:{port}"), &session.token)).await;
        assert!(ok.starts_with("HTTP/1.1 200 OK"), "{ok}");
        assert!(
            ok.ends_with(r#"{"jsonrpc":"2.0","id":1,"result":{}}"#),
            "{ok}"
        );

        let unauthorized = roundtrip(port, post(&format!("127.0.0.1:{port}"), "nope")).await;
        assert!(unauthorized.starts_with("HTTP/1.1 401"), "{unauthorized}");

        let rebound = roundtrip(port, post("attacker.example", &session.token)).await;
        assert!(rebound.starts_with("HTTP/1.1 403"), "{rebound}");

        let get = roundtrip(
            port,
            format!(
                "GET /mcp HTTP/1.1\r\nHost: localhost:{port}\r\nAuthorization: Bearer {}\r\nConnection: close\r\n\r\n",
                session.token
            ),
        )
        .await;
        assert!(get.starts_with("HTTP/1.1 405"), "{get}");

        let note = r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#;
        let accepted = roundtrip(
            port,
            format!(
                "POST /mcp HTTP/1.1\r\nHost: localhost:{port}\r\nAuthorization: Bearer {}\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n{:x}\r\n{note}\r\n0\r\n\r\n",
                session.token,
                note.len()
            ),
        )
        .await;
        assert!(accepted.starts_with("HTTP/1.1 202"), "{accepted}");
    }
}
