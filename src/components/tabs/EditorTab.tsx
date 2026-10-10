import { useEffect, useRef } from "react";
import { Loader2, X } from "lucide-react";
import { useEditorLayoutStore } from "../../store/editorLayoutStore";
import { useSessionsStore } from "../../store/sessionsStore";
import type { Tab } from "../../store/sessionsStore";
import { useScriptsStore } from "../../store/scriptsStore";
import { RowContextMenu } from "@/components/common/ActionMenu";
import type { MenuEntry } from "@/components/common/ActionMenu";
import { Button } from "@/components/ui/button";
import { ConnectionChip } from "@/components/ui/ConnectionChip";
import { useConnectionColor } from "@/lib/connectionColor";
import { cn } from "@/lib/utils";
import { tabIcon, tabName } from "./tabName";
import { useConsoleDirty } from "./useConsoleDirty";
import { startTabDrag } from "./useTabDrag";
import { PaneNumber } from "./PaneNumber";

interface EditorTabProps {
  tab: Tab;
  active: boolean;
  /** The tab's right-click menu, built when it opens. */
  entries: () => MenuEntry[];
  /** In its connection's group, whose header already names the connection. */
  bare?: boolean;
  /** The pane showing it in a split, from 0; null when it's in none. */
  pane?: number | null;
  /** Whether that pane is the focused one. */
  paneFocused?: boolean;
}

/** One tab of the editor strip, underlined in its connection's color when active. */
export function EditorTab({ tab, active, entries, bare = false, pane = null, paneFocused = false }: EditorTabProps) {
  const showTab = useEditorLayoutStore((s) => s.showTab);
  const closeTab = useSessionsStore((s) => s.closeTab);
  const ref = useRef<HTMLDivElement>(null);
  const fileName = useScriptsStore((s) =>
    tab.kind === "console" ? s.files[tab.id]?.name : undefined,
  );
  const dirty = useConsoleDirty(tab);
  const color = useConnectionColor(tab.connection.id);

  // A tab opened from the sidebar may land past the strip's visible edge.
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active]);

  // a console shows the script it's editing, once it has a file
  const name = tab.kind === "console" ? (fileName ?? tabName(tab)) : tabName(tab);
  const Icon = tab.kind === "table" && tab.loading ? Loader2 : tabIcon(tab);

  return (
    <RowContextMenu entries={entries}>
      <div
        ref={ref}
        role="tab"
        aria-selected={active}
        tabIndex={0}
        title={`${tabName(tab)}${fileName ? ` · ${fileName}` : ""}\n${tab.connection.name} · ${tab.connection.summary}${pane !== null ? `\nIn pane ${pane + 1}` : ""}`}
        className={cn(
          "group relative flex max-w-[280px] shrink-0 select-none items-center gap-[7px] whitespace-nowrap pl-3 pr-1.5 text-base",
          active ? "text-fg" : "text-fg-2 hover:bg-row-hover hover:text-fg",
        )}
        onClick={() => showTab(tab.id)}
        onPointerDown={(e) => startTabDrag(e, tab.id, name)}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            showTab(tab.id);
          }
        }}
        // Middle-click closes, as in a browser. Swallow the mousedown too, or
        // it starts autoscroll on Linux/Windows.
        onMouseDown={(e) => {
          if (e.button === 1) e.preventDefault();
        }}
        onAuxClick={(e) => {
          if (e.button === 1) closeTab(tab.id);
        }}
      >
        <ConnectionChip name={tab.connection.name} color={color} size="dot" />
        <Icon
          className={cn(
            "size-3.5 shrink-0 text-fg-2",
            tab.kind === "table" && tab.loading && "animate-spin text-fg-3",
          )}
          aria-hidden
        />
        <span className="min-w-0 truncate">{name}</span>
        {/* Names the connection too, so tabs stay unambiguous when two
            servers hold the same namespace - unless its group already does. */}
        {!bare && <span className="shrink-0 text-sm text-fg-3">{tab.connection.name}</span>}
        {pane !== null && <PaneNumber pane={pane} focused={paneFocused} />}
        {dirty && (
          <span
            role="img"
            aria-label="Unsaved changes"
            className="size-[7px] shrink-0 rounded-full bg-fg-2"
          />
        )}
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`Close ${name} on ${tab.connection.name}`}
          title="Close (middle-click)"
          data-no-drag=""
          className={cn(
            "text-fg-3",
            active ? "opacity-100" : "opacity-0 group-has-[:focus-visible]:opacity-100 group-hover:opacity-100",
          )}
          onClick={(e) => {
            e.stopPropagation();
            closeTab(tab.id);
          }}
        >
          <X />
        </Button>
        {active && (
          <span
            aria-hidden
            className="absolute inset-x-1.5 bottom-0 h-0.5 rounded-t-[2px]"
            style={{ backgroundColor: color }}
          />
        )}
      </div>
    </RowContextMenu>
  );
}
