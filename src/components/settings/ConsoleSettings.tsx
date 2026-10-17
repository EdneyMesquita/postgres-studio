import { useEffect, type ReactNode } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { CircleAlert, Copy, Lock, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { psqlFound, usePsqlStore } from "../../store/psqlStore";
import { PSQL_TIMEOUTS, useSettingsStore, type ConsoleEngine } from "../../store/settingsStore";
import { Field } from "../connections/Field";
import { SectionTitle } from "../connections/SectionTitle";
import { SwitchField } from "../connections/SwitchField";
import { hostOs, psqlInstallHint } from "../dump/installHint";
import { Aside, Lead } from "./parts";

interface EngineOptionProps {
  checked: boolean;
  disabled?: boolean;
  onSelect: () => void;
  name: string;
  version: ReactNode;
  children: ReactNode;
}

/** A radio card naming an engine, like the Assistant's agent choice. */
function EngineOption({ checked, disabled, onSelect, name, version, children }: EngineOptionProps) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "grid w-full grid-cols-[14px_1fr_auto] items-center gap-x-2.5 gap-y-[3px] rounded-md border border-line bg-editor px-2.5 py-[9px] text-left hover:border-field-line disabled:cursor-default disabled:opacity-70 disabled:hover:border-line",
        checked && "border-accent bg-[color-mix(in_srgb,var(--color-accent)_8%,var(--color-editor))] hover:border-accent",
      )}
    >
      <span className={cn("size-3.5 rounded-full border border-field-line bg-field", checked && "border-4 border-accent bg-white")} />
      <span className="font-medium">{name}</span>
      <span className="font-mono text-xs text-fg-3">{version}</span>
      {children}
    </button>
  );
}

/** What to run to get psql on this OS, with a copy button. */
function InstallPsql() {
  const hint = psqlInstallHint(hostOs());
  function copy() {
    if (!hint.command) return;
    navigator.clipboard.writeText(hint.command).then(
      () => toast("Copied the command"),
      () => toast.error("Couldn't copy the command"),
    );
  }
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-line bg-panel px-3 py-2.5 text-sm text-fg-2">
      <span>
        psql comes with PostgreSQL&apos;s client tools. Postgres Studio doesn&apos;t download it: there&apos;s no official
        build with a published checksum for every platform.
      </span>
      {hint.command && (
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-sm border border-line-soft bg-editor px-2 py-1 font-mono text-xs text-fg">
            {hint.command}
          </code>
          <Button size="icon" variant="ghost" title="Copy" aria-label="Copy the command" onClick={copy}>
            <Copy />
          </Button>
        </div>
      )}
      <span className="text-xs text-fg-3">{hint.text}</span>
    </div>
  );
}

export function ConsoleSettings() {
  const engine = useSettingsStore((s) => s.consoleEngine);
  const setEngine = useSettingsStore((s) => s.setConsoleEngine);
  const psql = useSettingsStore((s) => s.psql);
  const setPsql = useSettingsStore((s) => s.setPsql);
  const info = usePsqlStore((s) => s.info);
  const detecting = usePsqlStore((s) => s.detecting);
  const detect = usePsqlStore((s) => s.detect);
  const found = psqlFound(info);

  useEffect(() => {
    void detect();
  }, [detect, psql.path]);

  // Without psql, new consoles fall back to the built-in engine.
  const shown: ConsoleEngine = found ? engine : "builtin";

  async function chooseExecutable() {
    const path = await open({ multiple: false, directory: false });
    if (typeof path === "string") setPsql({ path });
  }

  return (
    <>
      <Lead>
        Runs console tabs and saved scripts. Each console can switch engine from its toolbar; this is what new consoles
        start with.
      </Lead>
      <SectionTitle>Engine</SectionTitle>
      <div role="radiogroup" aria-label="Console engine" className="flex flex-col gap-1.5">
        <EngineOption checked={shown === "builtin"} onSelect={() => setEngine("builtin")} name="Built-in" version="bundled">
          <span className="col-start-2 col-end-4 text-sm leading-[1.45] text-fg-3">
            Starts instantly, nothing to install. Every SQL statement, with Explain and manual transactions that stay open
            between runs; no psql meta-commands like \d, \copy or \set.
          </span>
        </EngineOption>
        <EngineOption
          checked={shown === "psql"}
          disabled={!found}
          onSelect={() => setEngine("psql")}
          name="psql"
          version={info?.version ?? ""}
        >
          <span className="col-start-2 col-end-4 font-mono text-[11px] leading-[1.4] text-fg-3 [font-variant-ligatures:none]">
            {info === null ? "Looking…" : (info.path ?? "Not found on your PATH or in the usual install folders")}
          </span>
          <span className="col-start-2 col-end-4 inline-flex items-center gap-[5px] text-xs text-fg-2">
            {found ? (
              <>
                <span className="size-1.5 shrink-0 rounded-full bg-ok" />
                <span>
                  {info?.custom ? "The executable you picked" : "Found on this computer"} · PostgreSQL&apos;s own client,
                  with \d, \copy, \i, \gexec, \set, \if and your ~/.psqlrc
                </span>
              </>
            ) : info?.error ? (
              <>
                <CircleAlert className="size-3 shrink-0 text-danger" />
                {info.error}
              </>
            ) : info ? (
              <>
                <CircleAlert className="size-3 shrink-0" />
                Install it as below, then Rescan
              </>
            ) : null}
          </span>
        </EngineOption>
      </div>
      {info !== null && !found && !info.custom && <InstallPsql />}
      <div className="flex items-center gap-2 text-xs text-fg-3">
        {detecting
          ? "Looking for psql…"
          : "Looked for psql on your PATH, Homebrew's libpq, Postgres.app and PostgreSQL's install folders"}
        <Button size="sm" variant="ghost" className="ml-auto" disabled={detecting} onClick={() => void detect()}>
          <RefreshCw className={cn(detecting && "animate-spin")} />
          Rescan
        </Button>
      </div>

      <SectionTitle>psql</SectionTitle>
      <Field
        label="Executable"
        help={psql.path ? "Picked by you." : "Found automatically; pick another install to override it. Backup and restore use the same search."}
      >
        <div className="flex gap-1.5">
          <Input
            readOnly
            className="font-data text-fg-2"
            value={psql.path ?? info?.path ?? ""}
            placeholder="Not found"
            aria-label="psql executable"
          />
          {psql.path && (
            <Button variant="ghost" onClick={() => setPsql({ path: null })}>
              Use the one found
            </Button>
          )}
          <Button onClick={() => void chooseExecutable()}>Choose file…</Button>
        </div>
      </Field>
      <div className="grid grid-cols-2 gap-3.5">
        <Field label="Extra arguments" htmlFor="settings-psql-args">
          <Input
            id="settings-psql-args"
            className="font-data"
            placeholder="e.g. -v ON_ERROR_STOP=0"
            value={psql.extraArgs}
            onChange={(e) => setPsql({ extraArgs: e.target.value })}
          />
        </Field>
        <Field label="Stop a run after" htmlFor="settings-psql-timeout">
          <Select
            value={String(psql.timeoutSecs ?? "none")}
            onValueChange={(v) => setPsql({ timeoutSecs: v === "none" ? null : Number(v) })}
          >
            <SelectTrigger id="settings-psql-timeout" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PSQL_TIMEOUTS.map((t) => (
                <SelectItem key={t.label} value={String(t.value ?? "none")}>
                  {t.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>
      <SwitchField
        label="Load ~/.psqlrc"
        description="Your settings and \set variables. Off runs psql with -X, so runs are reproducible."
        checked={psql.loadRc}
        onCheckedChange={(loadRc) => setPsql({ loadRc })}
      />
      <Aside icon={<Lock />}>
        psql runs as a separate process for each run, connected the way the console is. The password goes in through an
        environment variable, <b>never the command line</b>. Its output and messages stream into Messages as they come;
        result sets land in the same grid as the built-in engine&apos;s, though psql doesn&apos;t report column types. Each
        run is its own session, so a transaction ends with the run: put BEGIN … COMMIT in the script. Commands that wait
        for you, like \prompt or \watch, stop at the time limit.
      </Aside>
    </>
  );
}
