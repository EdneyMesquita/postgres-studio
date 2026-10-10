import { Copy, History, MoreHorizontal, Plus, SlidersHorizontal, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ActionMenuButton } from "@/components/common/ActionMenu";
import type { MenuEntry } from "@/components/common/ActionMenu";
import { selectCurrentSession, useAssistantStore } from "../../store/assistantStore";
import { api } from "../../lib/tauri";

function ago(at: number): string {
  const minutes = Math.round((Date.now() - at) / 60000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(at).toLocaleDateString("en", { month: "short", day: "numeric" });
}

/** A shell-quoted path. */
const quote = (path: string) => `'${path.replace(/'/g, `'\\''`)}'`;

/** Title and the panel's actions: sessions, new session, more, close. */
export function AssistantHeader() {
  const sessions = useAssistantStore((s) => s.sessions);
  const currentId = useAssistantStore((s) => s.currentId);
  const selectSession = useAssistantStore((s) => s.selectSession);
  const newSession = useAssistantStore((s) => s.newSession);
  const closePanel = useAssistantStore((s) => s.closePanel);

  const history = (): MenuEntry[] => [
    { heading: "Sessions" },
    ...sessions.map((s) => ({
      label: s.title,
      shortcut: s.id === currentId ? "now" : `${s.connectionName} · ${ago(s.createdAt)}`,
      onSelect: () => selectSession(s.id),
    })),
  ];

  const more = (): MenuEntry[] => {
    const session = selectCurrentSession(useAssistantStore.getState());
    return [
      { label: "Assistant settings…", icon: SlidersHorizontal, onSelect: () => useAssistantStore.getState().openPanel("setup") },
      {
        label: "Copy resume command",
        icon: Copy,
        disabled: !session?.cliSessionId,
        onSelect: async () => {
          if (!session?.cliSessionId) return;
          const command =
            session.agent === "claude"
              ? `cd ${quote(await api.assistantWorkdir())} && claude --resume ${session.cliSessionId}`
              : `codex resume ${session.cliSessionId}`;
          navigator.clipboard.writeText(command).then(
            () => toast.success(`Copied: ${command}`, { description: "Continue this session in a terminal" }),
            (e) => toast.error("Couldn't copy the command", { description: String(e) }),
          );
        },
      },
      { separator: true },
      { label: "Clear session", icon: Trash2, onSelect: () => useAssistantStore.getState().clearSession() },
    ];
  };

  return (
    <div className="flex h-9 flex-none items-center gap-0.5 pr-1.5 pl-3">
      <h2 className="m-0 flex-1 text-base font-semibold">Assistant</h2>
      <ActionMenuButton
        entries={history}
        label="Sessions"
        align="end"
        trigger={
          <Button variant="ghost" size="icon" title="Sessions" aria-label="Sessions">
            <History className="size-3.5" />
          </Button>
        }
      />
      <Button variant="ghost" size="icon" title="New session" aria-label="New session" onClick={newSession}>
        <Plus className="size-3.5" />
      </Button>
      <ActionMenuButton
        entries={more}
        label="More"
        align="end"
        trigger={
          <Button variant="ghost" size="icon" title="More" aria-label="More">
            <MoreHorizontal className="size-3.5" />
          </Button>
        }
      />
      <Button variant="ghost" size="icon" title="Close (Ctrl L)" aria-label="Close Assistant" onClick={closePanel}>
        <X className="size-3.5" />
      </Button>
    </div>
  );
}
