import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { Network, Plug, Shield, SlidersHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ConnectionSection } from "./connectionFormTypes";

interface ConnectionFormNavProps {
  value: ConnectionSection;
  onChange: (section: ConnectionSection) => void;
  /** Faint trailing text per section, e.g. "On" / "Off". */
  states: Partial<Record<ConnectionSection, string>>;
  /** id prefix tying each tab to its panel. */
  idPrefix: string;
}

const SECTIONS: { id: ConnectionSection; label: string; icon: ReactNode }[] = [
  { id: "general", label: "General", icon: <Plug /> },
  { id: "tls", label: "TLS", icon: <Shield /> },
  { id: "ssh", label: "SSH tunnel", icon: <Network /> },
  { id: "advanced", label: "Advanced", icon: <SlidersHorizontal /> },
];

/** The dialog's left column: one vertical tab per settings section. */
export function ConnectionFormNav({ value, onChange, states, idPrefix }: ConnectionFormNavProps) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  function onKeyDown(e: KeyboardEvent, index: number) {
    const next =
      e.key === "ArrowDown" ? index + 1
      : e.key === "ArrowUp" ? index - 1
      : e.key === "Home" ? 0
      : e.key === "End" ? SECTIONS.length - 1
      : null;
    if (next === null) return;
    e.preventDefault();
    const wrapped = (next + SECTIONS.length) % SECTIONS.length;
    onChange(SECTIONS[wrapped].id);
    refs.current[wrapped]?.focus();
  }

  return (
    <nav
      role="tablist"
      aria-orientation="vertical"
      aria-label="Connection settings"
      className="flex flex-col gap-0.5 border-r border-line bg-panel px-2 py-2.5"
    >
      {SECTIONS.map((section, i) => {
        const selected = section.id === value;
        return (
          <button
            key={section.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${section.id}`}
            aria-selected={selected}
            aria-controls={`${idPrefix}-panel`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(section.id)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={cn(
              "flex h-8 items-center gap-2.5 rounded-md px-2.5 text-left text-base text-fg-2 outline-none transition-colors duration-100 hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-ring [&_svg]:size-3.5 [&_svg]:shrink-0",
              selected && "bg-sel text-fg hover:bg-sel",
            )}
          >
            {section.icon}
            {section.label}
            {states[section.id] && (
              <span className="ml-auto text-xs text-fg-3">{states[section.id]}</span>
            )}
          </button>
        );
      })}
    </nav>
  );
}
