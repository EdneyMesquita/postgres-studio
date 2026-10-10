import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { ColumnInfo, CsvPreview } from "@/types/pg";
import { cn } from "@/lib/utils";

const SKIP = "__skip__";

interface CsvMappingGridProps {
  preview: CsvPreview;
  /** The table's loadable columns. */
  columns: ColumnInfo[];
  mapping: (string | null)[];
  duplicates: Set<string>;
  onChange: (fileColumn: number, column: string | null) => void;
}

/** The first rows of the file, under a row of pickers: where each column goes. */
export function CsvMappingGrid({ preview, columns, mapping, duplicates, onChange }: CsvMappingGridProps) {
  const indexes = Array.from({ length: preview.columns }, (_, i) => i);
  return (
    <div className="max-h-[19rem] overflow-auto rounded-md border border-line">
      <table className="w-max min-w-full border-collapse text-sm">
        <thead className="sticky top-0 z-10 bg-editor">
          <tr>
            {indexes.map((i) => {
              const chosen = mapping[i] ?? null;
              const clash = chosen !== null && duplicates.has(chosen);
              return (
                <th key={i} scope="col" className="min-w-40 border-b border-line px-2 py-2 text-left align-top font-normal">
                  <Select value={chosen ?? SKIP} onValueChange={(v) => onChange(i, v === SKIP ? null : v)}>
                    <SelectTrigger
                      size="sm"
                      aria-label={`Table column for file column ${i + 1}`}
                      aria-invalid={clash || undefined}
                      className={cn("w-full font-data", chosen === null && "text-fg-3")}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={SKIP}>Skip this column</SelectItem>
                      {columns.map((c) => (
                        <SelectItem key={c.name} value={c.name} className="font-data">
                          {c.name} <span className="text-fg-3">{c.typeName}</span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {preview.headers && (
                    <div className="mt-1 truncate text-fg-3" title={preview.headers[i]}>
                      {preview.headers[i] ?? ""}
                    </div>
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {preview.rows.map((row, r) => (
            <tr key={r} className="border-b border-line-soft last:border-b-0">
              {indexes.map((i) => {
                const value = row[i];
                return (
                  <td
                    key={i}
                    className={cn("max-w-64 truncate px-2 py-1 font-data", mapping[i] == null && "opacity-45")}
                    title={value ?? undefined}
                  >
                    {value === undefined ? null : value === null ? <span className="text-fg-3">NULL</span> : value}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {preview.rows.length === 0 && <p className="m-0 px-3 py-2 text-fg-3">The file has no rows after the header.</p>}
    </div>
  );
}
