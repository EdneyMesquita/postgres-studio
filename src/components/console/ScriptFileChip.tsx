import { FileCode, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ConsoleFile } from "../../store/scriptsStore";

interface ScriptFileChipProps {
  file: ConsoleFile | undefined;
  dirty: boolean;
  /** Unlinks the console from its file. */
  onDetach: () => void;
}

/** The file a console saves to, "untitled.sql" until its first save. */
export function ScriptFileChip({ file, dirty, onDetach }: ScriptFileChipProps) {
  return (
    <span
      className="inline-flex min-w-0 shrink items-center gap-1.5 text-fg-2"
      title={file?.path ?? "Not saved yet"}
    >
      <FileCode className="size-3.5 shrink-0" aria-hidden />
      <span className="truncate font-data text-sm">{file?.name ?? "untitled.sql"}</span>
      {dirty && (
        <span
          className="size-[7px] shrink-0 rounded-full bg-warn"
          role="img"
          aria-label="Unsaved changes"
        />
      )}
      {file && (
        <Button
          variant="ghost"
          size="icon-xs"
          title={`Stop saving to ${file.name} - the next save asks for a file`}
          aria-label={`Stop saving to ${file.name}`}
          onClick={onDetach}
        >
          <X />
        </Button>
      )}
    </span>
  );
}
