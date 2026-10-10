import { useEffect } from "react";
import type { ReactNode } from "react";
import { useUiStore } from "../../store/uiStore";
import { SidebarResizer, clampSidebarWidth } from "./SidebarResizer";

interface AppShellProps {
  /** The main toolbar across the top. */
  toolbar: ReactNode;
  /** The tool stripe on the left edge. */
  stripe: ReactNode;
  /** The side panel's content; its box hides when no tool window is open. */
  sidePanel: ReactNode;
  statusBar: ReactNode;
  /** A tool window docked right of the editor: the Assistant. */
  rightPanel?: ReactNode;
  /** The editor area. */
  children: ReactNode;
}

/**
 * The IDE frame (DESIGN.md Layout): toolbar, tool stripe, resizable side
 * panel, editor and status bar. Under 960px the side panel floats over the
 * editor instead of pushing it aside.
 */
export function AppShell({ toolbar, stripe, sidePanel, statusBar, rightPanel, children }: AppShellProps) {
  const sidebarWidth = useUiStore((s) => s.sidebarWidth);
  const panelOpen = useUiStore((s) => s.sidePanel !== null);

  // A width saved on a bigger screen, or a window shrunk since, mustn't
  // leave the sidebar taking over the main area.
  useEffect(() => {
    function fit() {
      const { sidebarWidth: width, setSidebarWidth } = useUiStore.getState();
      const fitted = clampSidebarWidth(width);
      if (fitted !== width) setSidebarWidth(fitted);
    }
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-editor text-fg">
      {toolbar}
      <div className="relative flex min-h-0 flex-1">
        {stripe}
        {/* Kept mounted while hidden, so the panels keep their state. */}
        <aside
          className={`relative flex shrink-0 flex-col border-r border-seam bg-panel max-[960px]:absolute max-[960px]:inset-y-0 max-[960px]:left-10 max-[960px]:z-30 max-[960px]:shadow-overlay ${
            panelOpen ? "" : "hidden"
          }`}
          style={{ width: sidebarWidth }}
        >
          <div className="min-h-0 flex-1 overflow-y-auto">{sidePanel}</div>
          <SidebarResizer />
        </aside>
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-editor">{children}</main>
        {rightPanel}
      </div>
      {statusBar}
    </div>
  );
}
