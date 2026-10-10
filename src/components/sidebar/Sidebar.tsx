import { useEffect, useState } from "react";
import { ArrowLeftRight, FolderPlus, Plus } from "lucide-react";
import { sessionIdFor, useConnectionsStore } from "../../store/connectionsStore";
import { useSidebarLayoutStore } from "../../store/sidebarLayoutStore";
import { useSessionsStore } from "../../store/sessionsStore";
import { useUiStore } from "../../store/uiStore";
import { Button } from "@/components/ui/button";
import { ConnectionTree } from "./ConnectionTree";
import { ExplorerSearch } from "./ExplorerSearch";
import { PanelHeader } from "./PanelHeader";
import { PanelNotice } from "./PanelNotice";
import { useTableMatches } from "./useTableMatches";
import { TREE_SCROLLER_ATTR } from "./useWindowedRows";

function newConnection() {
  useUiStore.getState().setConnectionDialog({ mode: "new" });
}

/** The Explorer tool window: saved connections, their databases, schemas and objects. */
export function Sidebar() {
  const { profiles, profilesLoaded, refreshProfiles, loadSecretBackendInfo, secretBackend } =
    useConnectionsStore();
  const layoutLoaded = useSidebarLayoutStore((s) => s.loaded);
  const layoutError = useSidebarLayoutStore((s) => s.error);
  const createFolder = useSidebarLayoutStore((s) => s.createFolder);
  const [search, setSearch] = useState("");
  const matches = useTableMatches(search.trim().toLowerCase());

  // Enter opens the first table found, so a few letters and Enter get you
  // to a table without the mouse.
  function openFirstMatch() {
    const first = matches?.first;
    if (!first) return;
    const profile = profiles.find((p) => p.id === first.connectionId);
    const sessionId = sessionIdFor(first.connectionId);
    if (!profile || !sessionId) return;
    void useSessionsStore
      .getState()
      .openTable(
        sessionId,
        { id: profile.id, name: profile.name, summary: profile.summary },
        first.database,
        first.schema,
        first.table,
        first.kind,
      );
  }

  useEffect(() => {
    refreshProfiles();
    loadSecretBackendInfo();
    useSidebarLayoutStore.getState().load();
  }, [refreshProfiles, loadSecretBackendInfo]);

  // Place new connections and drop deleted ones - but only once the list has
  // really loaded: an empty list before that would pull every connection out
  // of its folder.
  const profileIds = profiles.map((p) => p.id).join("\n");
  useEffect(() => {
    if (profilesLoaded && layoutLoaded) {
      useSidebarLayoutStore.getState().sync(profileIds ? profileIds.split("\n") : []);
    }
  }, [profilesLoaded, layoutLoaded, profileIds]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-panel">
      <PanelHeader title="Explorer">
        <Button
          variant="ghost"
          size="icon"
          title="New folder"
          aria-label="New folder"
          onClick={() => createFolder(null)}
        >
          <FolderPlus />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          title="Import / export connections"
          aria-label="Import or export connections"
          onClick={() => useUiStore.getState().setImportExportOpen(true)}
        >
          <ArrowLeftRight />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          title="New connection (Ctrl N)"
          aria-label="New connection"
          onClick={newConnection}
        >
          <Plus />
        </Button>
      </PanelHeader>

      <ExplorerSearch value={search} onChange={setSearch} onSubmit={openFirstMatch} />

      {secretBackend?.warning && <PanelNotice>{secretBackend.warning}</PanelNotice>}
      {layoutError && <PanelNotice>{layoutError}</PanelNotice>}

      <div className="min-h-0 flex-1 overflow-y-auto" {...{ [TREE_SCROLLER_ATTR]: "" }}>
        {profiles.length === 0 && profilesLoaded ? (
          <div className="flex flex-col items-start gap-2 px-3 py-2.5 text-sm text-fg-3">
            <p>No connections yet. Add one to browse its databases.</p>
            <Button size="sm" onClick={newConnection}>
              <Plus />
              New connection
            </Button>
          </div>
        ) : (
          <ConnectionTree search={search} />
        )}
      </div>
    </div>
  );
}
