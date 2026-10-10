import { ThemeSwitcher } from "../sidebar/ThemeSwitcher";
import { AssistantToggle } from "../assistant/AssistantToggle";
import { AppLogo } from "./AppLogo";
import { Breadcrumb } from "./Breadcrumb";
import { ConnectionWidget } from "./ConnectionWidget";
import { SearchButton } from "./SearchButton";
import { useActiveConnection } from "./useActiveConnection";

/**
 * The 40px bar under the OS title bar: connection and place on the left,
 * quick open in the middle, theme on the right. Its leading edge takes the
 * active connection's color, so production never looks like local.
 */
export function MainToolbar() {
  const active = useActiveConnection();
  const tint = active
    ? {
        background: `linear-gradient(90deg, color-mix(in srgb, ${active.color} 26%, var(--color-panel)) 0, var(--color-panel) 360px)`,
      }
    : undefined;

  return (
    <header
      className="grid h-10 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-3 border-b border-seam bg-panel pr-1.5 pl-2.5"
      style={tint}
    >
      <div className="flex min-w-0 items-center gap-1">
        <AppLogo className="mr-1.5 size-[18px]" />
        <ConnectionWidget active={active} />
        {active && <Breadcrumb tab={active.tab} />}
      </div>
      <SearchButton />
      <div className="flex min-w-0 items-center justify-end gap-1">
        <AssistantToggle />
        <ThemeSwitcher />
      </div>
    </header>
  );
}
