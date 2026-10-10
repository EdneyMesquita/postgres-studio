import { Eye } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AGENT_NAMES, useAssistantStore } from "../../store/assistantStore";
import type { AssistantApproval } from "../../store/assistantStore";
import type { AgentKind } from "../../types/assistant";

interface ApprovalCardProps {
  approval: AssistantApproval;
  agent: AgentKind;
  connectionName: string;
}

/**
 * The agent wants row values and the user hasn't allowed them: once,
 * always on this connection, or not at all. The tool call waits for it.
 */
export function ApprovalCard({ approval, agent, connectionName }: ApprovalCardProps) {
  const answer = useAssistantStore((s) => s.answerApproval);
  return (
    <div role="group" aria-label="Permission request" className="flex flex-col gap-2 rounded-md border border-line bg-editor p-2.5 text-sm text-fg-2">
      <div className="flex items-start gap-2">
        <Eye className="mt-0.5 size-3.5 shrink-0 text-accent-text" />
        <div>
          <b className="font-medium text-fg">
            {AGENT_NAMES[agent]} wants to read {approval.limit} {approval.limit === 1 ? "row" : "rows"} from{" "}
            {approval.database}
            {approval.table ? `.${approval.table}` : ""}
          </b>
          . Their values will be sent to {approval.provider}.
        </div>
      </div>
      <div className="flex flex-wrap gap-1 pl-[22px]">
        <Button size="sm" variant="primary" onClick={() => answer(approval.requestId, "once")}>
          Allow once
        </Button>
        <Button size="sm" onClick={() => answer(approval.requestId, "always")}>
          Always on {connectionName}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => answer(approval.requestId, "deny")}>
          Deny
        </Button>
      </div>
    </div>
  );
}
