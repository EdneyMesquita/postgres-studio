import { connectionInitials } from "../../lib/connectionColor";

interface ConnectionChipProps {
  name: string;
  color: string;
  /** md: 18px (toolbar), sm: 14px (tree, lists), dot: 8px square, no text. */
  size?: "md" | "sm" | "dot";
}

/** A connection's identity: its initials on its color. */
export function ConnectionChip({ name, color, size = "sm" }: ConnectionChipProps) {
  if (size === "dot") {
    return (
      <span
        aria-hidden
        className="inline-block h-2 w-2 shrink-0 rounded-[2px]"
        style={{ backgroundColor: color }}
      />
    );
  }
  const box = size === "md" ? "h-[18px] w-[18px] text-[9px] rounded-sm" : "h-3.5 w-3.5 text-[7.5px] rounded-[3px]";
  return (
    <span
      aria-hidden
      className={`inline-grid shrink-0 place-items-center font-semibold leading-none tracking-wide text-[#15161A] ${box}`}
      style={{ backgroundColor: color }}
    >
      {connectionInitials(name)}
    </span>
  );
}
