import { useState } from "react";
import { Check, FileCode, Undo2 } from "lucide-react";
import { useConnectionsStore } from "../../store/connectionsStore";
import { pendingCount, useSessionsStore } from "../../store/sessionsStore";
import type { TableTab } from "../../store/sessionsStore";
import { previewEdits } from "../../lib/editSql";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { SqlText } from "../console/SqlText";

/**
 * Uncommitted edits wait here: how many, the SQL they become, and
 * Rollback / Commit. Commit is the bar's one primary while it shows.
 */
export function PendingBar({ tab }: { tab: TableTab }) {
  const session = useConnectionsStore((s) => s.sessions[tab.connection.id]);
  const discard = useSessionsStore((s) => s.discardEdits);
  const commit = useSessionsStore((s) => s.commitEdits);
  const [review, setReview] = useState(false);
  const count = pendingCount(tab);
  if (!session) return null;

  return (
    <div className="flex-none border-b border-line">
      <div className="flex min-h-9 flex-wrap items-center gap-2 bg-warn/9 py-1 pr-2 pl-3 text-sm text-fg-2" role="status">
        <span className="size-[7px] shrink-0 rounded-full bg-warn" aria-hidden />
        <b className="font-medium text-fg">
          {count} uncommitted {count === 1 ? "change" : "changes"}
        </b>
        <span>
          in <span className="font-mono">{tab.schema}.{tab.table}</span>
          {session.readOnly && <span className="text-warn"> · the connection is read-only</span>}
        </span>
        {tab.commitError && (
          <span className="min-w-0 truncate text-danger" title={tab.commitError}>
            {tab.commitError}
          </span>
        )}
        <span className="flex-1" />
        <Button variant="ghost" size="sm" aria-expanded={review} onClick={() => setReview((r) => !r)}>
          <FileCode />
          {review ? "Hide SQL" : "Review SQL"}
        </Button>
        <Button variant="secondary" size="sm" disabled={tab.committing} onClick={() => discard(tab.id)}>
          <Undo2 />
          Discard
        </Button>
        <Button
          variant="primary"
          size="sm"
          disabled={tab.committing}
          onClick={() => void commit(session.sessionId, tab.id)}
          title="Write every change in one transaction (Ctrl S)"
        >
          <Check />
          {tab.committing ? "Committing…" : "Commit"}
          <Kbd>Ctrl S</Kbd>
        </Button>
      </div>
      {review && (
        <div className="max-h-44 overflow-auto bg-panel">
          <SqlText text={previewEdits(tab)} className="px-3 py-2" />
          <p className="px-3 pb-2 text-xs text-fg-3">
            Runs as one transaction; nothing is written until you commit, and a row changed meanwhile rolls everything back.
          </p>
        </div>
      )}
    </div>
  );
}
