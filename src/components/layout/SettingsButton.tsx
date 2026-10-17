import { Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useUiStore } from "../../store/uiStore";

/** Opens Settings (Ctrl ,). */
export function SettingsButton() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Settings"
          onClick={() => useUiStore.getState().setSettingsSection("general")}
        >
          <Settings />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={4}>
        Settings (Ctrl ,)
      </TooltipContent>
    </Tooltip>
  );
}
