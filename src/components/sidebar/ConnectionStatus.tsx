import { CircleAlert, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { connectErrorLabel } from "./connectError";

interface ConnectionStatusProps {
  name: string;
  connected: boolean;
  connecting: boolean;
  /** Server version of the live session, for the live dot's hint. */
  serverVersion: string | null;
  /** Why the last connect failed, when it did. */
  error: string | undefined;
  onRetry: () => void;
}

/**
 * The trailing state of a connection row: a live dot, a spinner, or a
 * one-line failure whose short text turns into Retry on hover.
 */
export function ConnectionStatus({
  name,
  connected,
  connecting,
  serverVersion,
  error,
  onRetry,
}: ConnectionStatusProps) {
  if (connecting) {
    return <Loader2 className="size-3 animate-spin text-fg-3" aria-label="Connecting" />;
  }
  if (connected) {
    const hint = serverVersion ? `Connected · PostgreSQL ${serverVersion}` : "Connected";
    return (
      <span
        role="img"
        aria-label={hint}
        title={hint}
        className="size-1.5 rounded-full bg-ok ring-2 ring-ok/25"
      />
    );
  }
  if (!error) return null;
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex items-center gap-1 text-xs text-danger">
            <CircleAlert className="size-3" aria-hidden />
            <span className="group-has-[:focus-visible]:hidden group-hover:hidden">
              {connectErrorLabel(error)}
            </span>
            <span className="sr-only">: {error}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="end" className="max-w-80 break-words text-xs">
          {error}
        </TooltipContent>
      </Tooltip>
      <Button
        variant="ghost"
        size="icon-xs"
        data-no-drag=""
        aria-label={`Retry connecting to ${name}`}
        title="Retry"
        className="hidden text-accent-text group-has-[:focus-visible]:inline-flex group-hover:inline-flex"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onRetry();
        }}
      >
        <RefreshCw />
      </Button>
    </>
  );
}
