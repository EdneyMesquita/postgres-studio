import { useRef, type CSSProperties, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { CONNECTION_COLORS } from "@/lib/connectionColor";
import { cn } from "@/lib/utils";

interface ColorSwatchesProps {
  /** The chosen color, or null for automatic. */
  value: string | null;
  onChange: (color: string | null) => void;
  /** The color automatic resolves to (picked from the connection id). */
  autoColor: string;
}

/**
 * The connection palette as a radio group. Automatic shows the color it
 * resolves to as checked; clicking a chosen swatch again goes back to it.
 */
export function ColorSwatches({ value, onChange, autoColor }: ColorSwatchesProps) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const shown = (value ?? autoColor).toUpperCase();
  // a color from outside the palette checks nothing; the first one takes focus
  const focusIndex = Math.max(0, CONNECTION_COLORS.findIndex((c) => c === shown));

  function pick(color: string) {
    onChange(value !== null && color === value.toUpperCase() ? null : color);
  }

  // Arrow keys move and select, like any radio group.
  function onKeyDown(e: KeyboardEvent, index: number) {
    const step =
      e.key === "ArrowRight" || e.key === "ArrowDown" ? 1
      : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1
      : 0;
    if (!step) return;
    e.preventDefault();
    const next = (index + step + CONNECTION_COLORS.length) % CONNECTION_COLORS.length;
    onChange(CONNECTION_COLORS[next]);
    refs.current[next]?.focus();
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <div role="radiogroup" aria-label="Connection color" className="flex flex-wrap gap-1.5">
        {CONNECTION_COLORS.map((color, i) => (
          <button
            key={color}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={color === shown}
            aria-label={`Color ${color}`}
            title={color}
            tabIndex={i === focusIndex ? 0 : -1}
            onClick={() => pick(color)}
            onKeyDown={(e) => onKeyDown(e, i)}
            style={{ "--c": color } as CSSProperties}
            className={cn(
              "size-[22px] rounded-[5px] bg-(--c) outline-none",
              "focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring",
              "aria-checked:ring-2 aria-checked:ring-(--c) aria-checked:ring-offset-2 aria-checked:ring-offset-editor",
            )}
          />
        ))}
      </div>
      {value === null ? (
        <span className="ml-1.5 text-xs text-fg-3">Automatic</span>
      ) : (
        <Button
          variant="link"
          size="sm"
          className="ml-1.5 h-auto text-xs text-fg-3 hover:text-fg"
          onClick={() => onChange(null)}
        >
          Use automatic
        </Button>
      )}
    </div>
  );
}
