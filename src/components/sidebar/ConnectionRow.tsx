import { useEffect, useState } from "react";
import { Lock } from "lucide-react";
import type { HTMLAttributes } from "react";
import { confirm } from "../../store/confirmStore";
import { useConnectionsStore } from "../../store/connectionsStore";
import { useUiStore } from "../../store/uiStore";
import type { ConnectionProfileMeta } from "../../types/connection";
import { RowContextMenu } from "@/components/common/ActionMenu";
import { ConnectionChip } from "@/components/ui/ConnectionChip";
import { connectionColor } from "@/lib/connectionColor";
import { ConnectionStatus } from "./ConnectionStatus";
import { DatabaseRow } from "./DatabaseRow";
import { Highlighted } from "./Highlighted";
import { RowMenuButton } from "./RowMenuButton";
import { TreeRow } from "./TreeRow";
import { useObjectDialogsStore } from "../../store/objectDialogsStore";
import { connectionMenuEntries } from "./treeMenus";

interface ConnectionRowProps {
  profile: ConnectionProfileMeta;
  /** Nesting depth in the folder tree. */
  depth?: number;
  /** Extra props for the row itself: drag handlers, data attributes. */
  rowProps?: HTMLAttributes<HTMLDivElement> & Record<`data-${string}`, string>;
  /** The sidebar search, lowercased. */
  query?: string;
  /** Whether tables under it match the sidebar search. */
  hasMatches?: boolean;
}

export function ConnectionRow({
  profile,
  depth = 0,
  rowProps,
  query = "",
  hasMatches = false,
}: ConnectionRowProps) {
  const session = useConnectionsStore((s) => s.sessions[profile.id]);
  const connecting = useConnectionsStore((s) => s.connecting[profile.id] ?? false);
  const connectError = useConnectionsStore((s) => s.connectErrors[profile.id]);
  const connect = useConnectionsStore((s) => s.connect);
  const disconnect = useConnectionsStore((s) => s.disconnect);
  const deleteProfile = useConnectionsStore((s) => s.deleteProfile);
  const [expanded, setExpanded] = useState(false);

  const isActive = session !== undefined;
  // a search that found tables here shows them, even if collapsed
  const showChildren = expanded || hasMatches;

  useEffect(() => {
    if (isActive) setExpanded(true);
  }, [isActive]);

  async function handleDelete() {
    const confirmed = await confirm({
      title: "Delete connection",
      message: `Delete the connection "${profile.name}"? Its saved passwords are removed too.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (confirmed) await deleteProfile(profile.id);
  }

  function handleToggle() {
    if (isActive) {
      setExpanded((e) => !e);
    } else {
      connect(profile.id);
    }
  }

  const entries = () =>
    connectionMenuEntries({
      connected: isActive,
      onConnect: () => connect(profile.id),
      onDisconnect: () => disconnect(profile.id),
      onEdit: () => useUiStore.getState().setConnectionDialog({ mode: "edit", id: profile.id }),
      onDelete: handleDelete,
      onRoles: session
        ? () =>
            useObjectDialogsStore.getState().openRoles({
              connection: { id: profile.id, name: profile.name, summary: profile.summary },
              sessionId: session.sessionId,
              database: session.defaultDatabase,
            })
        : undefined,
    });

  return (
    <>
      <RowContextMenu entries={entries}>
        <TreeRow
          {...rowProps}
          depth={depth}
          expanded={isActive ? showChildren : undefined}
          icon={
            <ConnectionChip name={profile.name} color={connectionColor(profile.id, profile.color)} />
          }
          labelClassName="font-medium"
          label={<Highlighted name={profile.name} query={query} />}
          trailing={
            <>
              {profile.readOnly && (
                <span className="grid place-items-center text-fg-3" title="Read-only: every session starts with default_transaction_read_only">
                  <Lock className="size-3" aria-label="Read-only" />
                </span>
              )}
              <ConnectionStatus
                name={profile.name}
                connected={isActive}
                connecting={connecting}
                serverVersion={session?.serverVersion ?? null}
                error={isActive ? undefined : connectError}
                onRetry={() => connect(profile.id)}
              />
              <RowMenuButton entries={entries} label={`Actions for ${profile.name}`} />
            </>
          }
          onActivate={handleToggle}
        />
      </RowContextMenu>
      {isActive && showChildren && (
        <div role="group">
          {session.databases.map((db) => (
            <DatabaseRow
              key={db.name}
              db={db}
              sessionId={session.sessionId}
              connection={{ id: profile.id, name: profile.name, summary: profile.summary }}
              depth={depth + 1}
              query={query}
            />
          ))}
        </div>
      )}
    </>
  );
}
