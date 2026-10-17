/** The name the server goes by in a client's config. */
export const MCP_SERVER_NAME = "postgres-studio";

/** How long a request set to Ask waits before the server refuses it. */
export const MCP_REQUEST_TIMEOUT_MS = 2 * 60_000;

/** A client's config for the server, as text: "claude", "cursor", "codex", "vscode", or plain JSON. */
export function mcpSnippet(client: string, url: string, token: string): string {
  const auth = `Bearer ${token}`;
  const name = MCP_SERVER_NAME;
  switch (client) {
    case "claude":
      return `# in a terminal\nclaude mcp add --transport http --scope user ${name} ${url} \\\n  --header "Authorization: ${auth}"`;
    case "cursor":
      return `// ~/.cursor/mcp.json\n${JSON.stringify({ mcpServers: { [name]: { url, headers: { Authorization: auth } } } }, null, 2)}`;
    case "codex":
      return `# ~/.codex/config.toml\n[mcp_servers.${name}]\nurl = "${url}"\n\n[mcp_servers.${name}.http_headers]\nAuthorization = "${auth}"`;
    case "vscode":
      return `// VS Code: MCP: Open User Configuration\n${JSON.stringify({ servers: { [name]: { type: "http", url, headers: { Authorization: auth } } } }, null, 2)}`;
    default:
      return JSON.stringify({ type: "http", url, headers: { Authorization: auth } }, null, 2);
  }
}

/** The token with all but its ends hidden. */
export function maskToken(token: string): string {
  return token ? `${token.slice(0, 4)}••••••••${token.slice(-4)}` : "";
}

/** Time left as "m:ss", never below 0:00. */
export function formatCountdown(ms: number): string {
  const secs = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
}
