import type { CSSProperties } from "react";
import { Maximize2, Minimize2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConnectionChip } from "@/components/ui/ConnectionChip";
import { useConnectionColor } from "@/lib/connectionColor";
import { cn } from "@/lib/utils";
import { useEditorLayoutStore } from "../../store/editorLayoutStore";
import type { Tab } from "../../store/sessionsStore";
import { useScriptsStore } from "../../store/scriptsStore";
import { PaneNumber } from "../tabs/PaneNumber";
import { tabName } from "../tabs/tabName";

interface EditorPaneHeaderProps {
  pane: number;
  tab: Tab | null;
  focused: boolean;
  maximized: boolean;
  style: CSSProperties;
}

/**
 * The strip over a pane: its number, what it shows and on which
 * connection, and maximize / close. The focused pane's carries a blue top
 * edge - the one blue mark of focus.
 */
export function EditorPaneHeader({ pane, tab, focused, maximized, style }: EditorPaneHeaderProps) {
  const focusPane = useEditorLayoutStore((s) => s.focusPane);
  const toggleMaximize = useEditorLayoutStore((s) => s.toggleMaximize);
  const closePane = useEditorLayoutStore((s) => s.closePane);
  const color = useConnectionColor(tab?.connection.id ?? "");
  const fileName = useScriptsStore((s) => (tab?.kind === "console" ? s.files[tab.id]?.name : undefined));
  const title = tab ? (fileName ?? tabName(tab)) : "Empty";

  return (
    <div
      style={style}
      onPointerDown={() => focusPane(pane)}
      className={cn(
        "relative flex min-w-0 items-center gap-[7px] border-b border-line bg-panel pr-1 pl-2 text-sm",
        focused ? "text-fg" : "text-fg-2",
      )}
    >
      {focused && <span aria-hidden className="absolute inset-x-0 top-0 h-0.5 bg-accent" />}
      <PaneNumber pane={pane} focused={focused} />
      {tab && <ConnectionChip name={tab.connection.name} color={color} size="sm" />}
      <span className="min-w-0 truncate font-medium" title={title}>
        {title}
      </span>
      {tab && <span className="min-w-0 truncate text-fg-3 max-[1100px]:hidden">{tab.connection.name}</span>}
      <span className="flex-1" />
      {tab && (
        <Button
          variant="ghost"
          size="icon-xs"
          title={maximized ? "Back to the split" : "Show only this pane"}
          aria-label={maximized ? "Restore the split" : `Maximize pane ${pane + 1}`}
          onClick={() => toggleMaximize(pane)}
          className="text-fg-3"
        >
          {maximized ? <Minimize2 /> : <Maximize2 />}
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon-xs"
        title="Close pane"
        aria-label={`Close pane ${pane + 1}`}
        onClick={(e) => {
          e.stopPropagation();
          closePane(pane);
        }}
        className="text-fg-3"
      >
        <X />
      </Button>
    </div>
  );
}
