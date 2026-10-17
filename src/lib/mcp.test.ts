import { describe, expect, it } from "vitest";
import { formatCountdown, maskToken, mcpSnippet } from "./mcp";

const URL = "http://127.0.0.1:47432/mcp";

describe("mcpSnippet", () => {
  it("puts Claude Code's header after the name and url", () => {
    const lines = mcpSnippet("claude", URL, "tok").split("\n");
    expect(lines[1]).toBe(`claude mcp add --transport http --scope user postgres-studio ${URL} \\`);
    expect(lines[2]).toBe('  --header "Authorization: Bearer tok"');
  });

  it("writes the token as a Codex http header", () => {
    const text = mcpSnippet("codex", URL, "tok");
    expect(text).toContain("[mcp_servers.postgres-studio]");
    expect(text).toContain(`url = "${URL}"`);
    expect(text).toContain("[mcp_servers.postgres-studio.http_headers]");
    expect(text).toContain('Authorization = "Bearer tok"');
    expect(text).not.toContain("bearer_token_env_var");
  });

  it("uses mcpServers for Cursor and servers with a type for VS Code", () => {
    const cursor = JSON.parse(mcpSnippet("cursor", URL, "tok").split("\n").slice(1).join("\n"));
    expect(cursor).toEqual({ mcpServers: { "postgres-studio": { url: URL, headers: { Authorization: "Bearer tok" } } } });
    const vscode = JSON.parse(mcpSnippet("vscode", URL, "tok").split("\n").slice(1).join("\n"));
    expect(vscode).toEqual({
      servers: { "postgres-studio": { type: "http", url: URL, headers: { Authorization: "Bearer tok" } } },
    });
  });

  it("falls back to plain JSON", () => {
    expect(JSON.parse(mcpSnippet("json", URL, "tok"))).toEqual({
      type: "http",
      url: URL,
      headers: { Authorization: "Bearer tok" },
    });
  });
});

describe("maskToken", () => {
  it("keeps the ends", () => {
    expect(maskToken("abcd1234wxyz")).toBe("abcd••••••••wxyz");
    expect(maskToken("")).toBe("");
  });
});

describe("formatCountdown", () => {
  it("shows m:ss", () => {
    expect(formatCountdown(120_000)).toBe("2:00");
    expect(formatCountdown(119_000)).toBe("1:59");
    expect(formatCountdown(65_400)).toBe("1:06");
    expect(formatCountdown(9_000)).toBe("0:09");
  });

  it("stops at 0:00", () => {
    expect(formatCountdown(0)).toBe("0:00");
    expect(formatCountdown(-5_000)).toBe("0:00");
  });
});
