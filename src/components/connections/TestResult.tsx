import { CircleAlert, CircleCheck, RefreshCw } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ConnectionTestResult } from "@/types/connection";

interface TestResultProps {
  testing: boolean;
  result: ConnectionTestResult | null;
}

/** The outcome of "Test connection", inline in the dialog footer. */
export function TestResult({ testing, result }: TestResultProps) {
  if (testing) {
    return (
      <span role="status" className="inline-flex items-center gap-[7px] text-sm text-fg-2">
        <RefreshCw className="size-3.5 animate-spin" />
        Testing...
      </span>
    );
  }
  if (!result) return null;
  if (result.success) {
    return (
      <span role="status" className="inline-flex min-w-0 items-center gap-[7px] text-sm text-ok">
        <CircleCheck className="size-3.5 shrink-0" />
        Connected
        {result.serverVersion && (
          <span className="truncate text-fg-2">· PostgreSQL {result.serverVersion}</span>
        )}
      </span>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="status"
          tabIndex={0}
          className="inline-flex min-w-0 items-center gap-[7px] rounded-sm text-sm text-danger outline-none focus-visible:outline-2 focus-visible:outline-ring"
        >
          <CircleAlert className="size-3.5 shrink-0" />
          <span className="truncate">{result.message}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-md break-words">
        {result.message}
      </TooltipContent>
    </Tooltip>
  );
}
