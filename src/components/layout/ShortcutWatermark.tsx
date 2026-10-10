import { Fragment } from "react";
import type { ReactNode } from "react";
import { Kbd } from "@/components/ui/kbd";

const SHORTCUTS: { label: string; keys: ReactNode }[] = [
  {
    label: "Open a table or script",
    keys: (
      <>
        <Kbd>Ctrl</Kbd>
        <Kbd>K</Kbd>
      </>
    ),
  },
  { label: "Open a console on a database", keys: "right-click it in the Explorer" },
  {
    label: "New connection",
    keys: (
      <>
        <Kbd>Ctrl</Kbd>
        <Kbd>N</Kbd>
      </>
    ),
  },
  {
    label: "Toggle the Explorer",
    keys: (
      <>
        <Kbd>Ctrl</Kbd>
        <Kbd>B</Kbd>
      </>
    ),
  },
];

/** Connected with nothing open: the ways to get somewhere, VS Code style. */
export function ShortcutWatermark() {
  return (
    <div className="absolute inset-0 grid place-items-center overflow-auto p-6 text-fg-2">
      <dl className="m-0 grid grid-cols-[auto_auto] items-center gap-x-5 gap-y-2.5">
        {SHORTCUTS.map(({ label, keys }) => (
          <Fragment key={label}>
            <dt className="text-right">{label}</dt>
            <dd className="m-0 flex items-center gap-1">{keys}</dd>
          </Fragment>
        ))}
      </dl>
    </div>
  );
}
