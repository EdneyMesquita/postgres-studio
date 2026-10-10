import { useMemo, useState } from "react";
import { SquareTerminal } from "lucide-react";
import type { ColumnInfo } from "../../types/pg";
import type { TableTab } from "../../store/sessionsStore";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { INDEX_METHODS, defaultIndexName, newIndexSql } from "@/lib/objectsSql";
import type { IndexMethod } from "@/lib/objectsSql";
import { SqlText } from "../console/SqlText";
import { openSql } from "./openSql";

const METHOD_HINT: Record<IndexMethod, string> = {
  btree: "Equality and range lookups, ordering. The default for almost everything.",
  hash: "Equality lookups only.",
  gin: "Arrays, jsonb, full-text search. Plain scalar columns need the btree_gin extension.",
  gist: "Geometry, ranges, nearest-neighbour. Plain scalar columns need the btree_gist extension.",
  brin: "Very large tables whose values follow the physical order, like timestamps in an append-only log.",
};

/** Picks columns and a method, shows the CREATE INDEX it makes, and opens it in a console. */
export function NewIndexDialog({ tab, columns, onClose }: { tab: TableTab; columns: ColumnInfo[]; onClose: () => void }) {
  const [method, setMethod] = useState<IndexMethod>("btree");
  // in the order picked: the order of columns in a btree index matters
  const [picked, setPicked] = useState<string[]>([]);
  const [unique, setUnique] = useState(false);
  const [name, setName] = useState<string | null>(null);

  const suggested = defaultIndexName(tab.table, picked);
  const finalName = (name ?? suggested).trim();
  const sql = useMemo(
    () => (picked.length > 0 && finalName ? newIndexSql({ schema: tab.schema, table: tab.table, name: finalName, method, columns: picked, unique }) : ""),
    [picked, finalName, method, unique, tab.schema, tab.table],
  );

  function toggle(column: string) {
    setPicked((p) => (p.includes(column) ? p.filter((c) => c !== column) : [...p, column]));
  }
  const single = method === "hash";

  return (
    <Modal
      title={`New index on ${tab.schema}.${tab.table}`}
      onClose={onClose}
      width="max-w-xl"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!sql}
            onClick={() => {
              openSql(tab.connection, tab.database, sql);
              onClose();
            }}
          >
            <SquareTerminal />
            Open in console
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-fg-2">Method</span>
          <SegmentedControl
            aria-label="Index method"
            value={method}
            onChange={(m) => {
              setMethod(m);
              // hash indexes take one column
              if (m === "hash") setPicked((p) => p.slice(0, 1));
            }}
            options={INDEX_METHODS.map((m) => ({ value: m, label: m }))}
          />
          <span className="text-sm text-fg-3">{METHOD_HINT[method]}</span>
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-fg-2">Columns</span>
          <div className="grid max-h-56 grid-cols-2 gap-x-4 overflow-auto rounded-md border border-line-soft p-1.5">
            {columns.map((c) => {
              const at = picked.indexOf(c.name);
              const blocked = single && picked.length >= 1 && at < 0;
              return (
                <label key={c.name} className="flex h-7 cursor-pointer items-center gap-2 rounded-sm px-1.5 hover:bg-hover">
                  <Checkbox checked={at >= 0} disabled={blocked} onCheckedChange={() => toggle(c.name)} />
                  <span className="min-w-0 flex-1 truncate font-data">{c.name}</span>
                  <span className="shrink-0 text-xs text-fg-3">{c.typeName}</span>
                  {at >= 0 && <span className="w-4 shrink-0 text-right text-xs text-accent-text tabular-nums">{at + 1}</span>}
                </label>
              );
            })}
          </div>
        </div>

        <div className="flex items-end gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <span className="text-sm font-medium text-fg-2">Name</span>
            <Input value={name ?? suggested} onChange={(e) => setName(e.target.value)} spellCheck={false} className="font-data" />
          </div>
          <label className="flex h-8 items-center gap-2 text-sm text-fg-2">
            <Checkbox checked={unique} disabled={method !== "btree"} onCheckedChange={(v) => setUnique(v === true)} />
            Unique
          </label>
        </div>

        <div className="rounded-md border border-line-soft bg-panel px-3 py-2">
          {sql ? <SqlText text={sql} className="whitespace-pre-wrap" /> : <span className="text-sm text-fg-3">Pick at least one column.</span>}
        </div>
      </div>
    </Modal>
  );
}
