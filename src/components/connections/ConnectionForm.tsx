import { useId } from "react";
import { CircleAlert, Info, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { connectionColor } from "@/lib/connectionColor";
import { useConnectionsStore } from "@/store/connectionsStore";
import type { ConnectionProfile, ConnectionProfileInput } from "@/types/connection";
import { AdvancedSection } from "./AdvancedSection";
import { ConnectionFormNav } from "./ConnectionFormNav";
import type { ConnectionSection } from "./connectionFormTypes";
import { GeneralSection } from "./GeneralSection";
import { SshSection } from "./SshSection";
import { TestResult } from "./TestResult";
import { TlsSection } from "./TlsSection";
import { useConnectionForm } from "./useConnectionForm";

interface ConnectionFormProps {
  /** A saved profile to edit; a new connection when absent. */
  editing?: ConnectionProfile;
  onSaved: () => void;
  onCancel: () => void;
}

// Sections hide their fields, so the nav says which ones hold settings.
function sectionStates(input: ConnectionProfileInput): Partial<Record<ConnectionSection, string>> {
  const advancedSet = Object.values(input.advanced).filter((v) => v !== null).length;
  return {
    tls: input.tls.sslMode,
    ssh: input.sshTunnel?.enabled ? "On" : "Off",
    advanced: advancedSet > 0 ? `${advancedSet} set` : undefined,
  };
}

export function ConnectionForm({ editing, onSaved, onCancel }: ConnectionFormProps) {
  const form = useConnectionForm(editing, onSaved);
  const { input, update, section, loading } = form;
  const idPrefix = useId();
  const editingActive = useConnectionsStore(
    (s) => editing !== undefined && s.sessions[editing.id] !== undefined,
  );
  const sectionProps = { input, update, editing };

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent
        aria-describedby={undefined}
        // start in Name, not on the first nav tab
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          document.getElementById("conn-name")?.focus();
        }}
        className="grid h-[min(600px,calc(100%-2rem))] w-[min(780px,calc(100%-2rem))] max-w-none grid-cols-[196px_minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-none"
      >
        <DialogHeader className="col-span-full">
          <DialogTitle>
            {editing ? `Edit connection · ${editing.name}` : "New connection"}
          </DialogTitle>
        </DialogHeader>

        <ConnectionFormNav
          value={section}
          onChange={form.setSection}
          states={sectionStates(input)}
          idPrefix={idPrefix}
        />

        <DialogBody
          role="tabpanel"
          id={`${idPrefix}-panel`}
          aria-labelledby={`${idPrefix}-tab-${section}`}
          className="flex flex-col gap-4 pb-[22px]"
        >
          {editingActive && (
            <p className="flex items-start gap-2 rounded-md bg-fg/6 px-3 py-2 text-sm text-fg-2">
              <Info className="mt-px size-3.5 shrink-0" />
              You're connected with this connection. Changes apply the next time you connect.
            </p>
          )}
          {form.error && (
            <p
              role="alert"
              className="flex items-start gap-2 rounded-md bg-danger/10 px-3 py-2 text-sm break-words text-danger"
            >
              <CircleAlert className="mt-px size-3.5 shrink-0" />
              {form.error}
            </p>
          )}
          {section === "general" && (
            <GeneralSection
              {...sectionProps}
              folder={form.folder}
              onFolderChange={form.setFolder}
              autoColor={connectionColor(form.id)}
            />
          )}
          {section === "tls" && <TlsSection {...sectionProps} />}
          {section === "ssh" && <SshSection {...sectionProps} />}
          {section === "advanced" && <AdvancedSection {...sectionProps} />}
        </DialogBody>

        <DialogFooter className="col-span-full">
          <Button variant="secondary" disabled={loading} onClick={form.test}>
            <Zap className="size-3.5" />
            Test connection
          </Button>
          <div className="flex min-w-0 flex-1 items-center pl-1">
            <TestResult testing={form.testing} result={form.lastTestResult} />
          </div>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="secondary" disabled={loading || !input.name} onClick={() => form.save(false)}>
            Save
          </Button>
          <Button variant="primary" disabled={loading || !input.name} onClick={() => form.save(true)}>
            Save and connect
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
