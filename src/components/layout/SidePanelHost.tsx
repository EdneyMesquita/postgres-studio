import { useState } from "react";
import { useUiStore } from "../../store/uiStore";
import { SavedScriptsPanel } from "../sidebar/SavedScriptsPanel";
import { Sidebar } from "../sidebar/Sidebar";

/**
 * The side panel's tool windows. The Explorer stays mounted even while
 * hidden: it loads the connection list the rest of the app reads, and keeps
 * its search and scroll. Saved scripts mounts the first time it's shown.
 */
export function SidePanelHost() {
  const panel = useUiStore((s) => s.sidePanel);
  const [scriptsShown, setScriptsShown] = useState(panel === "scripts");
  if (panel === "scripts" && !scriptsShown) setScriptsShown(true);

  return (
    <>
      <div className={panel === "explorer" ? "h-full" : "hidden"}>
        <Sidebar />
      </div>
      {scriptsShown && (
        <div className={panel === "scripts" ? "h-full" : "hidden"}>
          <SavedScriptsPanel />
        </div>
      )}
    </>
  );
}
