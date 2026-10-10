import { useEffect } from "react";
import { Copy, Folder, FolderOpen, Puzzle, RefreshCw, Settings2 } from "lucide-react";
import { toast } from "sonner";
import { RowContextMenu } from "@/components/common/ActionMenu";
import type { MenuEntry } from "@/components/common/ActionMenu";
import { databaseKey } from "../../store/explorerStore";
import { useExtensionsStore } from "../../store/extensionsStore";
import { useObjectDialogsStore } from "../../store/objectDialogsStore";
import type { TabConnection } from "../../store/sessionsStore";
import { TreeNote } from "../sidebar/TreeNote";
import { TreeRow } from "../sidebar/TreeRow";

interface ExtensionsGroupProps {
  database: string;
  sessionId: string;
  connection: TabConnection;
  depth: number;
}

/** "Extensions" under a database, beside its schemas: what is installed, and a way to manage it. */
export function ExtensionsGroup({ database, sessionId, connection, depth }: ExtensionsGroupProps) {
  const key = databaseKey(connection.id, database);
  const node = useExtensionsStore((s) => s.nodes[key]);
  const toggle = useExtensionsStore((s) => s.toggle);
  const ensure = useExtensionsStore((s) => s.ensure);
  const load = useExtensionsStore((s) => s.load);

  // the database is open: read its extensions once per session
  useEffect(() => {
    void ensure(connection.id, sessionId, database);
  }, [ensure, connection.id, sessionId, database]);

  const stale = node !== undefined && node.sessionId !== sessionId;
  const items = stale ? [] : (node?.items ?? []);
  const open = node?.expanded ?? false;
  const manage = () => useObjectDialogsStore.getState().openExtensions({ connection, sessionId, database });
  const groupMenu = (): MenuEntry[] => [
    { heading: `Extensions of ${database}` },
    { label: "Manage extensions…", icon: Settings2, onSelect: manage },
    { label: "Refresh", icon: RefreshCw, onSelect: () => void load(connection.id, sessionId, database) },
  ];

  return (
    <>
      <RowContextMenu entries={groupMenu}>
        <TreeRow
          depth={depth}
          expanded={open}
          icon={open ? <FolderOpen className="size-3.5 shrink-0 text-fg-2" aria-hidden /> : <Folder className="size-3.5 shrink-0 text-fg-2" aria-hidden />}
          label="Extensions"
          trailing={node?.loaded && !stale ? <span>{items.length}</span> : undefined}
          onActivate={() => toggle(connection.id, database)}
        />
      </RowContextMenu>
      {open && (
        <div role="group">
          {node?.error ? (
            <TreeNote depth={depth + 1} tone="danger">
              {node.error}
            </TreeNote>
          ) : !node?.loaded || stale ? (
            <TreeNote depth={depth + 1}>Loading…</TreeNote>
          ) : items.length === 0 ? (
            <TreeNote depth={depth + 1}>None installed</TreeNote>
          ) : null}
          {items.map((e) => (
            <RowContextMenu
              key={e.name}
              entries={() => [
                { heading: e.name },
                { label: "Manage extensions…", icon: Settings2, onSelect: manage },
                {
                  label: "Copy name",
                  icon: Copy,
                  onSelect: () =>
                    void navigator.clipboard.writeText(e.name).then(
                      () => toast.success(`Copied ${e.name}`),
                      (err) => toast.error("Couldn't copy the name", { description: String(err) }),
                    ),
                },
              ]}
            >
              <TreeRow
                depth={depth + 1}
                title={[`${e.name} ${e.version} in ${e.schema}`, e.comment].filter(Boolean).join(": ")}
                icon={<Puzzle className="size-3.5 shrink-0 text-fg-2" aria-hidden />}
                label={e.name}
                trailing={<span>{e.version}</span>}
                onActivate={manage}
              />
            </RowContextMenu>
          ))}
        </div>
      )}
    </>
  );
}
