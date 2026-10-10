//! Just enough HTTP/1.1 for the MCP server: request heads, bodies sent
//! with Content-Length or chunked, and plain responses. The only clients are
//! the agent CLIs on this machine, so this favors being small and strict
//! over being general; a framework would be a lot of code for one route.

use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt};

/// Largest request body accepted; tool arguments are small.
pub(crate) const MAX_BODY: usize = 1024 * 1024;
const MAX_HEAD: u64 = 32 * 1024;

#[derive(Debug)]
pub(crate) struct Head {
    pub method: String,
    pub path: String,
    headers: Vec<(String, String)>,
}

impl Head {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(n, _)| n.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    fn has_token(&self, name: &str, token: &str) -> bool {
        self.header(name).is_some_and(|v| {
            v.split(',')
                .any(|part| part.trim().eq_ignore_ascii_case(token))
        })
    }

    pub fn keep_alive(&self) -> bool {
        !self.has_token("connection", "close")
    }

    pub fn expects_continue(&self) -> bool {
        self.has_token("expect", "100-continue")
    }
}

#[derive(Debug)]
pub(crate) enum ReadError {
    /// The peer closed the connection between requests.
    Closed,
    TooLarge,
    Malformed(&'static str),
    /// The connection failed; nothing can be answered on it.
    Io,
}

impl From<std::io::Error> for ReadError {
    fn from(e: std::io::Error) -> Self {
        if e.kind() == std::io::ErrorKind::UnexpectedEof {
            ReadError::Malformed("unexpected end of request")
        } else {
            ReadError::Io
        }
    }
}

/// Reads one line, CRLF or LF terminated, without its terminator.
async fn read_line<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    budget: &mut u64,
) -> Result<Option<String>, ReadError> {
    let mut buf = Vec::new();
    let n = (&mut *reader)
        .take(*budget)
        .read_until(b'\n', &mut buf)
        .await?;
    if n == 0 {
        return Ok(None);
    }
    *budget = budget.saturating_sub(n as u64);
    if buf.last() != Some(&b'\n') {
        return Err(if *budget == 0 {
            ReadError::TooLarge
        } else {
            ReadError::Malformed("unexpected end of request")
        });
    }
    buf.pop();
    if buf.last() == Some(&b'\r') {
        buf.pop();
    }
    String::from_utf8(buf)
        .map(Some)
        .map_err(|_| ReadError::Malformed("request head is not UTF-8"))
}

/// Reads the request line and headers.
pub(crate) async fn read_head<R: AsyncBufRead + Unpin>(reader: &mut R) -> Result<Head, ReadError> {
    let mut budget = MAX_HEAD;
    // Tolerate stray blank lines between keep-alive requests (RFC 9112 2.2).
    let request_line = loop {
        match read_line(reader, &mut budget).await? {
            None => return Err(ReadError::Closed),
            Some(line) if line.is_empty() => continue,
            Some(line) => break line,
        }
    };
    let mut parts = request_line.split(' ');
    let (Some(method), Some(target), Some(version), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(ReadError::Malformed("bad request line"));
    };
    if !version.starts_with("HTTP/1.") || method.is_empty() || target.is_empty() {
        return Err(ReadError::Malformed("bad request line"));
    }
    let mut headers = Vec::new();
    loop {
        let Some(line) = read_line(reader, &mut budget).await? else {
            return Err(ReadError::Malformed("unexpected end of request"));
        };
        if line.is_empty() {
            break;
        }
        let Some((name, value)) = line.split_once(':') else {
            return Err(ReadError::Malformed("bad header line"));
        };
        if name.is_empty() || name.ends_with(char::is_whitespace) {
            return Err(ReadError::Malformed("bad header line"));
        }
        headers.push((name.to_string(), value.trim().to_string()));
    }
    let path = target.split('?').next().unwrap_or(target).to_string();
    Ok(Head {
        method: method.to_string(),
        path,
        headers,
    })
}

/// Reads the body the head announces: chunked, Content-Length, or none.
pub(crate) async fn read_body<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    head: &Head,
) -> Result<Vec<u8>, ReadError> {
    if let Some(te) = head.header("transfer-encoding") {
        if !te.trim().eq_ignore_ascii_case("chunked") {
            return Err(ReadError::Malformed("unsupported transfer encoding"));
        }
        return read_chunked(reader).await;
    }
    let Some(length) = head.header("content-length") else {
        return Ok(Vec::new());
    };
    let length: usize = length
        .trim()
        .parse()
        .map_err(|_| ReadError::Malformed("bad content-length"))?;
    if length > MAX_BODY {
        return Err(ReadError::TooLarge);
    }
    let mut body = vec![0; length];
    reader.read_exact(&mut body).await?;
    Ok(body)
}

async fn read_chunked<R: AsyncBufRead + Unpin>(reader: &mut R) -> Result<Vec<u8>, ReadError> {
    let mut body = Vec::new();
    let mut budget = MAX_HEAD;
    loop {
        let Some(line) = read_line(reader, &mut budget).await? else {
            return Err(ReadError::Malformed("unexpected end of request"));
        };
        let size = line.split(';').next().unwrap_or("").trim();
        let size =
            usize::from_str_radix(size, 16).map_err(|_| ReadError::Malformed("bad chunk size"))?;
        if size == 0 {
            // Trailers, up to the blank line.
            loop {
                match read_line(reader, &mut budget).await? {
                    None => return Err(ReadError::Malformed("unexpected end of request")),
                    Some(line) if line.is_empty() => return Ok(body),
                    Some(_) => {}
                }
            }
        }
        if size > MAX_BODY - body.len() {
            return Err(ReadError::TooLarge);
        }
        let start = body.len();
        body.resize(start + size, 0);
        reader.read_exact(&mut body[start..]).await?;
        match read_line(reader, &mut budget).await? {
            Some(line) if line.is_empty() => {}
            _ => return Err(ReadError::Malformed("bad chunk terminator")),
        }
    }
}

pub(crate) struct Response {
    pub status: u16,
    pub content_type: Option<&'static str>,
    pub headers: Vec<(&'static str, String)>,
    pub body: Vec<u8>,
}

impl Response {
    pub fn empty(status: u16) -> Self {
        Self {
            status,
            content_type: None,
            headers: Vec::new(),
            body: Vec::new(),
        }
    }

    pub fn json(status: u16, value: &serde_json::Value) -> Self {
        Self {
            status,
            content_type: Some("application/json"),
            headers: Vec::new(),
            body: serde_json::to_vec(value).unwrap_or_default(),
        }
    }

    pub fn text(status: u16, text: &str) -> Self {
        Self {
            status,
            content_type: Some("text/plain; charset=utf-8"),
            headers: Vec::new(),
            body: text.as_bytes().to_vec(),
        }
    }

    pub fn with_header(mut self, name: &'static str, value: impl Into<String>) -> Self {
        self.headers.push((name, value.into()));
        self
    }

    pub fn to_bytes(&self, keep_alive: bool) -> Vec<u8> {
        let mut out = format!("HTTP/1.1 {} {}\r\n", self.status, reason(self.status));
        if let Some(ct) = self.content_type {
            out.push_str(&format!("Content-Type: {ct}\r\n"));
        }
        for (name, value) in &self.headers {
            out.push_str(&format!("{name}: {value}\r\n"));
        }
        out.push_str(&format!("Content-Length: {}\r\n", self.body.len()));
        out.push_str(if keep_alive {
            "Connection: keep-alive\r\n\r\n"
        } else {
            "Connection: close\r\n\r\n"
        });
        let mut bytes = out.into_bytes();
        bytes.extend_from_slice(&self.body);
        bytes
    }
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        202 => "Accepted",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        413 => "Content Too Large",
        415 => "Unsupported Media Type",
        _ => "Internal Server Error",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::BufReader;

    async fn parse(raw: &[u8]) -> Result<(Head, Vec<u8>), ReadError> {
        let mut reader = BufReader::new(raw);
        let head = read_head(&mut reader).await?;
        let body = read_body(&mut reader, &head).await?;
        Ok((head, body))
    }

    #[tokio::test]
    async fn reads_a_content_length_request() {
        let raw = b"POST /mcp?x=1 HTTP/1.1\r\nHost: 127.0.0.1:5000\r\nAuthorization: Bearer abc\r\ncontent-length: 7\r\n\r\n{\"a\":1}";
        let (head, body) = parse(raw).await.unwrap();
        assert_eq!(head.method, "POST");
        assert_eq!(head.path, "/mcp");
        assert_eq!(head.header("host"), Some("127.0.0.1:5000"));
        assert_eq!(head.header("AUTHORIZATION"), Some("Bearer abc"));
        assert!(head.keep_alive());
        assert_eq!(body, b"{\"a\":1}");
    }

    #[tokio::test]
    async fn reads_a_chunked_request_with_extensions_and_trailers() {
        let raw = b"POST /mcp HTTP/1.1\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n4;ext=1\r\n{\"a\"\r\n3\r\n:1}\r\n0\r\nX-Trailer: y\r\n\r\n";
        let (head, body) = parse(raw).await.unwrap();
        assert!(!head.keep_alive());
        assert_eq!(body, b"{\"a\":1}");
    }

    #[tokio::test]
    async fn two_requests_on_one_connection() {
        let raw = b"POST /mcp HTTP/1.1\r\nContent-Length: 2\r\n\r\n{}GET /mcp HTTP/1.1\r\n\r\n";
        let mut reader = BufReader::new(&raw[..]);
        let first = read_head(&mut reader).await.unwrap();
        assert_eq!(read_body(&mut reader, &first).await.unwrap(), b"{}");
        let second = read_head(&mut reader).await.unwrap();
        assert_eq!(second.method, "GET");
        assert!(read_body(&mut reader, &second).await.unwrap().is_empty());
        assert!(matches!(
            read_head(&mut reader).await,
            Err(ReadError::Closed)
        ));
    }

    #[tokio::test]
    async fn rejects_oversized_and_malformed_requests() {
        let raw = format!(
            "POST /mcp HTTP/1.1\r\nContent-Length: {}\r\n\r\n",
            MAX_BODY + 1
        );
        assert!(matches!(
            parse(raw.as_bytes()).await,
            Err(ReadError::TooLarge)
        ));

        let big_chunk = format!(
            "POST /mcp HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n{:x}\r\n",
            MAX_BODY + 1
        );
        assert!(matches!(
            parse(big_chunk.as_bytes()).await,
            Err(ReadError::TooLarge)
        ));

        assert!(matches!(
            parse(b"POST /mcp HTTP/1.1\r\nContent-Length: 10\r\n\r\n{}").await,
            Err(ReadError::Malformed(_))
        ));
        assert!(matches!(
            parse(b"garbage\r\n\r\n").await,
            Err(ReadError::Malformed(_))
        ));
        assert!(matches!(
            parse(b"POST /mcp HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\n").await,
            Err(ReadError::Malformed(_))
        ));
    }

    #[test]
    fn writes_a_response() {
        let bytes = Response::json(200, &serde_json::json!({ "ok": true }))
            .with_header("X-Test", "1")
            .to_bytes(true);
        let text = String::from_utf8(bytes).unwrap();
        assert!(text.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(text.contains("Content-Type: application/json\r\n"));
        assert!(text.contains("X-Test: 1\r\n"));
        assert!(text.contains("Content-Length: 11\r\n"));
        assert!(text.ends_with("\r\n\r\n{\"ok\":true}"));
    }
}
