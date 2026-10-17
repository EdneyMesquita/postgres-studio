import { Server } from "lucide-react";
import { cn } from "@/lib/utils";
import { useMcpStore } from "../../store/mcpStore";
import { useSettingsStore } from "../../store/settingsStore";
import { useUiStore } from "../../store/uiStore";

/** The status bar's note of the MCP server: its clients, a request waiting, or a port in use. */
export function McpStatusItem() {
  const enabled = useSettingsStore((s) => s.mcp.enabled);
  const port = useSettingsStore((s) => s.mcp.port);
  const status = useMcpStore((s) => s.status);
  const waiting = useMcpStore((s) => s.requests.length);
  if (!enabled) return null;
  const clients = status?.clients.length ?? 0;
  const tone = waiting > 0 ? "text-warn hover:text-warn" : status?.error ? "text-danger hover:text-danger" : null;
  const note =
    waiting > 0 ? `${waiting} request${waiting === 1 ? "" : "s"} waiting`
    : status?.error ? `port ${status.port || port} in use`
    : `${clients} client${clients === 1 ? "" : "s"}`;
  return (
    <button
      type="button"
      onClick={() => useUiStore.getState().setSettingsSection("mcp")}
      title={status?.error ?? "MCP server settings"}
      className={cn(
        "inline-flex h-[22px] items-center gap-1.5 rounded-sm px-[7px] whitespace-nowrap hover:bg-hover hover:text-fg",
        tone,
      )}
    >
      <Server className="size-3" />
      <span>MCP</span>
      <span className={cn(!tone && "text-fg-3")}>· {note}</span>
    </button>
  );
}
