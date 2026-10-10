import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useThemeStore } from "../../store/themeStore";

/** Switches between the dark and the light version. */
export function ThemeSwitcher() {
  const themeId = useThemeStore((s) => s.themeId);
  const toggleTheme = useThemeStore((s) => s.toggleTheme);
  const label = themeId === "dark" ? "Switch to light theme" : "Switch to dark theme";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" onClick={toggleTheme} aria-label={label}>
          {themeId === "dark" ? <Sun /> : <Moon />}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}
