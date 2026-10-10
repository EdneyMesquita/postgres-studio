import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";

interface ExplorerSearchProps {
  value: string;
  onChange: (value: string) => void;
  /** Enter: open the first table found. */
  onSubmit: () => void;
}

/** The explorer's filter field. Escape clears it. */
export function ExplorerSearch({ value, onChange, onSubmit }: ExplorerSearchProps) {
  return (
    <div className="relative mx-2 mb-2 shrink-0">
      <Search
        className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-fg-3"
        aria-hidden
      />
      <Input
        className="h-7 pl-7"
        placeholder="Search connections and tables"
        aria-label="Search connections and tables"
        spellCheck={false}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onSubmit();
          if (e.key === "Escape") onChange("");
        }}
      />
    </div>
  );
}
