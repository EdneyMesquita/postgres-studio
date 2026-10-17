import { useEffect } from "react";
import { Download, Monitor, Moon, PanelRight, Rows3, Sun, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { ThemePreference } from "@/lib/themes";
import { useAssistantStore } from "../../store/assistantStore";
import { CONSOLE_ROW_LIMITS, PAGE_SIZES, useSettingsStore } from "../../store/settingsStore";
import { useThemeStore } from "../../store/themeStore";
import { useUiStore, type ConsoleLayout } from "../../store/uiStore";
import { AssistantSetupBody } from "../assistant/AssistantSetup";
import { Field } from "../connections/Field";
import { SwitchField } from "../connections/SwitchField";
import { Lead, SettingRow } from "./parts";

export function GeneralSettings() {
  const preference = useThemeStore((s) => s.preference);
  const setPreference = useThemeStore((s) => s.setPreference);
  const reopenTabs = useSettingsStore((s) => s.reopenTabs);
  const setReopenTabs = useSettingsStore((s) => s.setReopenTabs);
  return (
    <>
      <Field label="Theme">
        <SegmentedControl<ThemePreference>
          aria-label="Theme"
          className="self-start"
          value={preference}
          onChange={setPreference}
          options={[
            { value: "dark", label: "Dark", icon: <Moon /> },
            { value: "light", label: "Light", icon: <Sun /> },
            { value: "system", label: "Match system", icon: <Monitor /> },
          ]}
        />
      </Field>
      <SwitchField
        label="Reopen last session's tabs on launch"
        description="Tables, consoles and their SQL come back as they were. A connection reconnects when you open one of its tabs, not before."
        checked={reopenTabs}
        onCheckedChange={setReopenTabs}
      />
    </>
  );
}

function NumberSelect({ id, value, options, onChange }: { id: string; value: number; options: readonly number[]; onChange: (n: number) => void }) {
  // A value saved by hand outside the list still shows.
  const all = options.includes(value) ? options : [...options, value].sort((a, b) => a - b);
  return (
    <Select value={String(value)} onValueChange={(v) => onChange(Number(v))}>
      <SelectTrigger id={id} className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {all.map((n) => (
          <SelectItem key={n} value={String(n)}>
            {n.toLocaleString("en")}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function ResultsSettings() {
  const layout = useUiStore((s) => s.consoleLayout);
  const setLayout = useUiStore((s) => s.setConsoleLayout);
  const pageSize = useSettingsStore((s) => s.pageSize);
  const setPageSize = useSettingsStore((s) => s.setPageSize);
  const rowLimit = useSettingsStore((s) => s.consoleRowLimit);
  const setRowLimit = useSettingsStore((s) => s.setConsoleRowLimit);
  return (
    <>
      <div className="grid grid-cols-2 gap-3.5">
        <Field label="Rows per page" htmlFor="settings-page-size" help="The limit a new table tab starts with.">
          <NumberSelect id="settings-page-size" value={pageSize} options={PAGE_SIZES} onChange={setPageSize} />
        </Field>
        <Field
          label="Rows kept per console result"
          htmlFor="settings-console-rows"
          help="A result with more says so; export it to get every row."
        >
          <NumberSelect id="settings-console-rows" value={rowLimit} options={CONSOLE_ROW_LIMITS} onChange={setRowLimit} />
        </Field>
      </div>
      <Field label="Console layout" help="For new consoles; each console can switch from its toolbar.">
        <SegmentedControl<ConsoleLayout>
          aria-label="Console layout"
          className="self-start"
          value={layout}
          onChange={setLayout}
          options={[
            { value: "stacked", label: "Stacked", icon: <Rows3 /> },
            { value: "side", label: "Side by side", icon: <PanelRight /> },
          ]}
        />
      </Field>
    </>
  );
}

export function ConnectionsSettings() {
  const openTransfer = useUiStore((s) => s.openTransfer);
  return (
    <>
      <Lead>Saved connections stay on this computer; their passwords stay in the system keychain.</Lead>
      <div>
        <SettingRow
          title="Import connections"
          description="From another Postgres Studio, or pgAdmin 4's servers.json. Pick which ones, and the folder they go in, before anything is saved."
        >
          <Button onClick={() => openTransfer("import")}>
            <Upload className="size-3.5" />
            Import…
          </Button>
        </SettingRow>
        <SettingRow
          title="Export connections"
          description="Choose which ones go in the file, in Postgres Studio's own format. Passwords stay out unless you include them."
        >
          <Button onClick={() => openTransfer("export")}>
            <Download className="size-3.5" />
            Export…
          </Button>
        </SettingRow>
      </div>
    </>
  );
}

export function AssistantSettings() {
  const enabled = useAssistantStore((s) => s.enabled);
  const agent = useAssistantStore((s) => s.agent);
  const agents = useAssistantStore((s) => s.agents);
  useEffect(() => {
    if (useAssistantStore.getState().agents === null) void useAssistantStore.getState().detect();
  }, []);
  const found = agents?.some((a) => a.id === agent && a.path) ?? false;
  return (
    <>
      <SwitchField
        label="Turn on the Assistant"
        description={
          found || enabled
            ? "Adds the Assistant tool window (Ctrl L) and Ctrl I in the filter bar and the console."
            : "Install Claude Code or Codex and sign in once in a terminal, then Rescan below."
        }
        checked={enabled}
        disabled={!enabled && !found}
        onCheckedChange={(on) => (on ? useAssistantStore.getState().enable() : useAssistantStore.getState().disable())}
      />
      <div className={cn("flex flex-col gap-3.5", !enabled && "opacity-60")}>
        <AssistantSetupBody />
      </div>
    </>
  );
}
