import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { useUiStore } from "../../store/uiStore";

/** The toolbar's quick-open field; it opens the palette. Icon-only when narrow. */
export function SearchButton() {
  const setPaletteOpen = useUiStore((s) => s.setPaletteOpen);
  return (
    <Button
      variant="secondary"
      aria-label="Search tables, scripts and actions"
      className="w-[min(320px,28vw)] cursor-text justify-start gap-2 border-line bg-editor pr-1.5 pl-2.5 font-normal text-fg-3 hover:border-field-line hover:bg-editor max-[640px]:w-9 max-[640px]:justify-center max-[640px]:p-0"
      onClick={() => setPaletteOpen(true)}
    >
      <Search className="size-3.5" />
      <span className="flex-1 truncate text-left max-[640px]:hidden">
        Search tables, scripts, actions
      </span>
      <Kbd className="max-[640px]:hidden">Ctrl K</Kbd>
    </Button>
  );
}
