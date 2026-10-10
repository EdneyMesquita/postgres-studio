import { FileCode } from "lucide-react";
import type { SavedScript } from "../../types/script";
import { cn } from "@/lib/utils";
import { scriptFolder } from "./scriptFolder";

interface SavedScriptRowProps {
  script: SavedScript;
  /** Open in the console on screen. */
  current: boolean;
  onOpen: () => void;
}

/** A saved script: its name, and the folder it's in at the right. */
export function SavedScriptRow({ script, current, onOpen }: SavedScriptRowProps) {
  return (
    <button
      type="button"
      title={script.path}
      aria-current={current || undefined}
      className={cn(
        "flex h-7 w-full items-center gap-2 px-3 text-left text-fg outline-none hover:bg-row-hover",
        current && "bg-sel hover:bg-sel",
      )}
      onClick={onOpen}
    >
      <FileCode className="size-3.5 shrink-0 text-fg-2" aria-hidden />
      {/* The name first: the folder gets what width is left, if any. */}
      <span className="max-w-full flex-none truncate font-data">{script.name}</span>
      <span className="ml-auto min-w-0 flex-1 truncate pl-2 text-right text-xs text-fg-3">
        {scriptFolder(script.path)}
      </span>
    </button>
  );
}
