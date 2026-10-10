import { PanelRight, Rows3 } from "lucide-react";
import { SegmentedControl } from "@/components/ui/segmented-control";
import type { SegmentOption } from "@/components/ui/segmented-control";
import { useUiStore } from "../../store/uiStore";
import type { ConsoleLayout } from "../../store/uiStore";

const options: SegmentOption<ConsoleLayout>[] = [
  { value: "stacked", label: "Stacked", title: "Editor above output", icon: <Rows3 /> },
  { value: "side", label: "Side by side", title: "Editor and output side by side", icon: <PanelRight /> },
];

/** Switches the console between side-by-side and stacked panes. */
export function ConsoleLayoutToggle() {
  const layout = useUiStore((s) => s.consoleLayout);
  const setLayout = useUiStore((s) => s.setConsoleLayout);

  return (
    <SegmentedControl
      aria-label="Console layout"
      iconOnly
      value={layout}
      onChange={setLayout}
      options={options}
    />
  );
}
