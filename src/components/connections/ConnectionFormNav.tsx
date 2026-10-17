import type { ReactNode } from "react";
import { Network, Plug, Shield, SlidersHorizontal } from "lucide-react";
import { SideNav } from "@/components/ui/side-nav";
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
  return (
    <SideNav
      aria-label="Connection settings"
      sections={SECTIONS.map((s) => ({ ...s, state: states[s.id] }))}
      value={value}
      onChange={onChange}
      idPrefix={idPrefix}
    />
  );
}
