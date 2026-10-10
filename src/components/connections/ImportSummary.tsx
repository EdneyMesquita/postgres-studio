import { CircleCheck } from "lucide-react";
import type { ConnectionsImportSummary } from "@/types/connection";

/** How an import went: the count, then anything that needs a look. */
export function ImportSummary({ result }: { result: ConnectionsImportSummary }) {
  return (
    <div role="status" className="flex flex-col gap-1 text-sm">
      <p className="flex items-center gap-1.5 text-ok">
        <CircleCheck className="size-3.5" />
        Imported {result.imported.toLocaleString()} connection{result.imported === 1 ? "" : "s"}.
      </p>
      {result.warnings.length > 0 && (
        <ul className="list-disc pl-5 text-warn">
          {result.warnings.map((message, i) => (
            <li key={i}>{message}</li>
          ))}
        </ul>
      )}
      {result.errors.length > 0 && (
        <ul className="list-disc pl-5 text-danger">
          {result.errors.map((message, i) => (
            <li key={i}>{message}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
