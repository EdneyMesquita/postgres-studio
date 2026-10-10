import { useId } from "react";
import type { KeyboardEvent } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { QueryField } from "./QueryField";

interface QueryNumberFieldProps {
  label: string;
  value: number;
  onChange: (value: number) => void;
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
  className?: string;
}

/** A numeric query field (limit, skip): right-aligned mono digits. */
export function QueryNumberField({ label, value, onChange, onKeyDown, className }: QueryNumberFieldProps) {
  const id = useId();
  return (
    <QueryField label={label} htmlFor={id} className={cn("w-[92px] shrink-0", className)}>
      <Input
        id={id}
        type="number"
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        onKeyDown={onKeyDown}
        className={cn(
          "h-full rounded-none border-0 bg-transparent pr-2 pl-0 text-right font-data text-data",
          "focus-visible:ring-0 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none",
        )}
      />
    </QueryField>
  );
}
