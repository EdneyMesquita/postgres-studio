import type { CSSProperties } from "react";
import { ConnectionChip } from "@/components/ui/ConnectionChip";
import { useConnectionColor } from "@/lib/connectionColor";
import { useEditorLayoutStore } from "../../store/editorLayoutStore";
import { useScriptsStore } from "../../store/scriptsStore";
import { useSessionsStore } from "../../store/sessionsStore";
import type { Tab } from "../../store/sessionsStore";
import { LayoutIcon } from "../tabs/LayoutPicker";
import { tabIcon, tabName } from "../tabs/tabName";

/** How many open tabs an empty pane offers to show. */
const SUGGESTED = 5;

/** A pane with no tab yet: how to fill it, and the open tabs no pane shows. */
export function EmptyPane({ pane, focused, style }: { pane: number; focused: boolean; style: CSSProperties }) {
  const tabs = useSessionsStore((s) => s.tabs);
  const panes = useEditorLayoutStore((s) => s.panes);
  const layout = useEditorLayoutStore((s) => s.layout);
  const free = tabs.filter((t) => !panes.includes(t.id)).slice(0, SUGGESTED);

  return (
    <div
      style={style}
      onPointerDown={() => useEditorLayoutStore.getState().focusPane(pane)}
      className="grid min-h-0 place-content-center justify-items-center gap-2 overflow-auto bg-editor px-4 py-6 text-center text-fg-2"
    >
      <span className="grid size-10 place-items-center rounded-lg bg-row-hover text-fg-3">
        <LayoutIcon layout={layout} className="size-5" />
      </span>
      <b className="text-base font-semibold text-fg">Nothing in pane {pane + 1} yet</b>
      <p className="m-0 max-w-[290px] text-sm leading-normal">
        {focused
          ? "Click a tab above and it opens here, or drag one in."
          : "Drag a tab here, or click this pane and then a tab."}
      </p>
      {free.length > 0 && (
        <div className="mt-1.5 flex w-[min(320px,100%)] flex-col gap-px text-left">
          <div className="px-2 pb-1 text-xs font-medium text-fg-3">Open here</div>
          {free.map((t) => (
            <SuggestedTab key={t.id} tab={t} onOpen={() => useEditorLayoutStore.getState().openInPane(t.id, pane)} />
          ))}
        </div>
      )}
    </div>
  );
}

function SuggestedTab({ tab, onOpen }: { tab: Tab; onOpen: () => void }) {
  const color = useConnectionColor(tab.connection.id);
  const Icon = tabIcon(tab);
  // a console saved to a file goes by the file's name, as on its tab
  const fileName = useScriptsStore((s) => (tab.kind === "console" ? s.files[tab.id]?.name : undefined));
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex h-7 min-w-0 items-center gap-[7px] rounded-md px-2 text-fg hover:bg-row-hover"
    >
      <ConnectionChip name={tab.connection.name} color={color} size="dot" />
      <Icon className="size-3.5 shrink-0 text-fg-2" aria-hidden />
      <span className="min-w-0 truncate">{fileName ?? tabName(tab)}</span>
      <span className="ml-auto shrink-0 pl-2 text-xs text-fg-3">{tab.connection.name}</span>
    </button>
  );
}
