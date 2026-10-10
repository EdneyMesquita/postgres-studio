import { useId } from "react";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

interface SwitchFieldProps {
  label: string;
  description?: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
}

/** A switch with a bold label and a faint line saying what it does. */
export function SwitchField({ label, description, checked, onCheckedChange, disabled }: SwitchFieldProps) {
  const id = useId();
  const descriptionId = useId();
  return (
    <div className="flex items-start gap-2.5">
      <Switch
        id={id}
        className="mt-px"
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        aria-describedby={description ? descriptionId : undefined}
      />
      <div className="flex min-w-0 flex-col">
        <Label htmlFor={id} className="text-base leading-[1.45] font-medium">
          {label}
        </Label>
        {description && (
          <p id={descriptionId} className="text-sm text-fg-3">
            {description}
          </p>
        )}
      </div>
    </div>
  );
}
