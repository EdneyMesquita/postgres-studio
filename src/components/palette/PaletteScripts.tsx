import { FileCode } from "lucide-react";
import { toast } from "sonner";
import { CommandGroup, CommandItem } from "@/components/ui/command";
import { useScriptsStore } from "../../store/scriptsStore";
import type { SavedScript } from "../../types/script";
import { HighlightMatch } from "./HighlightMatch";

interface PaletteScriptsProps {
  search: string;
  /** Closes the palette, then runs the choice. */
  run: (action: () => void) => void;
}

async function open(script: SavedScript) {
  const scripts = useScriptsStore.getState();
  const before = scripts.listError;
  await scripts.open(script);
  // open() reports through the Saved scripts panel, which may be hidden
  const error = useScriptsStore.getState().listError;
  if (error && error !== before) toast.error(error);
}

/** The palette's saved scripts. */
export function PaletteScripts({ search, run }: PaletteScriptsProps) {
  const saved = useScriptsStore((s) => s.saved);
  if (saved.length === 0) return null;
  return (
    <CommandGroup heading="Saved scripts">
      {saved.map((script) => (
        <CommandItem
          key={script.path}
          value={`script:${script.path}`}
          keywords={[script.name]}
          onSelect={() => run(() => void open(script))}
        >
          <FileCode />
          <span className="min-w-0 truncate font-data">
            <HighlightMatch text={script.name} query={search} />
          </span>
          <span className="ml-auto min-w-0 truncate pl-3 text-sm text-fg-3" title={script.path}>
            {script.path}
          </span>
        </CommandItem>
      ))}
    </CommandGroup>
  );
}
