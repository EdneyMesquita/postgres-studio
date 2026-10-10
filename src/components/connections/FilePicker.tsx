import { open } from "@tauri-apps/plugin-dialog";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface FilePickerProps {
  id: string;
  value: string | null;
  onChange: (path: string | null) => void;
  /** Shown when no file is picked, e.g. "System trust store". */
  placeholder: string;
  disabled?: boolean;
}

/** A read-only path with a native "Choose file..." and a way to clear it. */
export function FilePicker({ id, value, onChange, placeholder, disabled }: FilePickerProps) {
  async function choose() {
    const picked = await open({ multiple: false, directory: false, defaultPath: value ?? undefined });
    if (typeof picked === "string") onChange(picked);
  }

  return (
    <div className="flex items-center gap-1.5">
      <Input
        id={id}
        readOnly
        value={value ?? ""}
        placeholder={placeholder}
        title={value ?? undefined}
        disabled={disabled}
        className="text-fg-3"
      />
      {value && (
        <Button
          variant="ghost"
          size="icon"
          aria-label="Clear file"
          title="Clear"
          disabled={disabled}
          onClick={() => onChange(null)}
        >
          <X />
        </Button>
      )}
      <Button variant="secondary" disabled={disabled} onClick={choose}>
        Choose file...
      </Button>
    </div>
  );
}
