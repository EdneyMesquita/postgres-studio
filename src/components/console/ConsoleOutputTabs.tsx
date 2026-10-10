import { useRef } from "react";
import type { KeyboardEvent } from "react";
import { cn } from "@/lib/utils";

export type OutputTab = string;

export interface OutputTabOption {
  id: OutputTab;
  label: string;
  /** Shown faint after the label; omitted when undefined. */
  count?: number;
}

interface ConsoleOutputTabsProps {
  tabs: OutputTabOption[];
  value: OutputTab;
  onChange: (tab: OutputTab) => void;
  /** Id prefix tying each tab to its panel. */
  idPrefix: string;
}

/** Result / Logs tabs of the console output, underlined when active. */
export function ConsoleOutputTabs({ tabs, value, onChange, idPrefix }: ConsoleOutputTabsProps) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const index = tabs.findIndex((t) => t.id === value);
    let next = -1;
    if (e.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (e.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    if (next < 0) return;
    e.preventDefault();
    onChange(tabs[next].id);
    refs.current[next]?.focus();
  }

  return (
    <div role="tablist" aria-label="Output" className="flex h-full items-stretch" onKeyDown={onKeyDown}>
      {tabs.map((tab, i) => {
        const selected = tab.id === value;
        return (
          <button
            key={tab.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${tab.id}`}
            aria-selected={selected}
            aria-controls={`${idPrefix}-panel`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab.id)}
            className={cn(
              "relative inline-flex items-center gap-1.5 px-2.5 text-base outline-none transition-colors duration-150 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
              selected
                ? "text-fg after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-t-sm after:bg-accent"
                : "text-fg-2 hover:text-fg",
            )}
          >
            {tab.label}
            {tab.count !== undefined && (
              <span className="text-xs text-fg-3 tabular-nums">{tab.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
