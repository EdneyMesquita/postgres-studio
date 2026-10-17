import { useEffect } from "react";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppShell } from "./components/layout/AppShell";
import { AssistantHost } from "./components/assistant/AssistantHost";
import { DialogHost } from "./components/layout/DialogHost";
import { EditorArea } from "./components/layout/EditorArea";
import { MainToolbar } from "./components/layout/MainToolbar";
import { SidePanelHost } from "./components/layout/SidePanelHost";
import { StatusBar } from "./components/layout/StatusBar";
import { ToolStripe } from "./components/layout/ToolStripe";
import { useGlobalShortcuts } from "./components/layout/useGlobalShortcuts";
import { LazyQuickOpenPalette } from "./components/palette/LazyQuickOpenPalette";
import { McpRequestCard } from "./components/mcp/McpRequestCard";
import { startMcp } from "./store/mcpStore";
import { useSuppressNativeContextMenu } from "./lib/useSuppressNativeContextMenu";

function App() {
  useSuppressNativeContextMenu();
  useGlobalShortcuts();
  // After mount: event listeners can't register at import time.
  useEffect(startMcp, []);

  return (
    <TooltipProvider delayDuration={400}>
      <AppShell
        toolbar={<MainToolbar />}
        stripe={<ToolStripe />}
        sidePanel={<SidePanelHost />}
        statusBar={<StatusBar />}
        rightPanel={<AssistantHost />}
      >
        <EditorArea />
      </AppShell>
      <LazyQuickOpenPalette />
      <DialogHost />
      <McpRequestCard />
      <Toaster />
    </TooltipProvider>
  );
}

export default App;
