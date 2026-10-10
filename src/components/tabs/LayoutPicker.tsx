import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { SPLIT_LAYOUT_ORDER, SPLIT_LAYOUTS, type SplitLayout } from "../../lib/editorLayout";
import { useEditorLayoutStore } from "../../store/editorLayoutStore";

/** Rectangles of a layout on a 16px icon grid. */
const ICON_RECTS: Record<SplitLayout, [number, number, number, number][]> = {
  single: [[2, 2, 12, 12]],
  cols2: [[2, 2, 5.5, 12], [8.5, 2, 5.5, 12]],
  cols3: [[2, 2, 3.33, 12], [6.33, 2, 3.33, 12], [10.67, 2, 3.33, 12]],
  grid: [[2, 2, 5.5, 5.5], [8.5, 2, 5.5, 5.5], [2, 8.5, 5.5, 5.5], [8.5, 8.5, 5.5, 5.5]],
};

/** A layout drawn as its panes. */
export function LayoutIcon({ layout, className }: { layout: SplitLayout; className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.3} aria-hidden className={cn("size-4", className)}>
      {ICON_RECTS[layout].map(([x, y, w, h], i) => (
        <rect key={i} x={x} y={y} width={w} height={h} rx={1.2} />
      ))}
    </svg>
  );
}

/** The tab strip's button for splitting the editor into up to four panes. */
export function LayoutPicker() {
  const layout = useEditorLayoutStore((s) => s.layout);
  const setLayout = useEditorLayoutStore((s) => s.setLayout);
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Split the editor"
          title={`Split the editor: ${SPLIT_LAYOUTS[layout].label}`}
          className={cn(layout !== "single" && "text-accent-text")}
        >
          <LayoutIcon layout={layout} />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[316px]">
        <h3 className="mb-2.5 text-sm font-semibold text-fg">Split the editor</h3>
        <div className="grid grid-cols-4 gap-1.5" role="radiogroup" aria-label="Layout">
          {SPLIT_LAYOUT_ORDER.map((kind, i) => {
            const info = SPLIT_LAYOUTS[kind];
            const on = kind === layout;
            return (
              <button
                key={kind}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => {
                  setLayout(kind);
                  setOpen(false);
                }}
                className={cn(
                  "group/opt flex flex-col items-center gap-1.5 rounded-md border px-0.5 pt-2 pb-[7px] text-xs",
                  on
                    ? "border-accent bg-accent/10 text-fg"
                    : "border-transparent text-fg-2 hover:bg-row-hover hover:text-fg",
                )}
              >
                <span
                  aria-hidden
                  className="grid h-8 w-[46px] gap-0.5 rounded-sm border border-field-line p-0.5"
                  style={{ gridTemplateColumns: `repeat(${info.cols}, 1fr)`, gridTemplateRows: `repeat(${info.rows}, 1fr)` }}
                >
                  {Array.from({ length: info.panes }, (_, p) => (
                    <i
                      key={p}
                      className={cn(
                        "rounded-[2px] bg-hover",
                        p === 0 && (on ? "bg-accent" : "group-hover/opt:bg-accent"),
                      )}
                    />
                  ))}
                </span>
                {info.label}
                <Kbd className="text-[10px]">{`Ctrl Alt ${i + 1}`}</Kbd>
              </button>
            );
          })}
        </div>
        <p className="mt-2.5 px-0.5 text-xs leading-normal text-fg-3">
          Up to four panes. The tab you click opens in the focused pane, the one with the blue edge; drag a tab onto any
          pane to put it there.
        </p>
      </PopoverContent>
    </Popover>
  );
}
