import { Copy } from "lucide-react";
import { toast } from "sonner";
import { vectorBlock, vectorType } from "../../lib/pgvector";
import { Button } from "@/components/ui/button";

/**
 * A pgvector value for the row inspector: all of it in a scrollable mono
 * block (a vector can run to 16000 numbers), its dimension count, and a
 * button copying it as the server prints it.
 */
export function VectorValue({ typeName, value }: { typeName: string; value: string }) {
  const type = vectorType(typeName);
  const block = type && vectorBlock(type.type, value);
  if (!block) return <span className="text-json-number">{value}</span>;
  return (
    <div className="min-w-0 rounded-[3px] border border-line-soft bg-field">
      <div className="flex h-6 items-center gap-1 border-b border-line-soft pr-0.5 pl-2 font-sans text-[10px] text-fg-3">
        <span className="min-w-0 flex-1 truncate">{block.tag}</span>
        <Button
          variant="ghost"
          size="icon"
          className="size-5"
          title="Copy the vector"
          aria-label="Copy the vector"
          onClick={() =>
            void navigator.clipboard.writeText(value).then(
              () => toast.success("Copied the vector"),
              (e) => toast.error("Couldn't copy the vector", { description: String(e) }),
            )
          }
        >
          <Copy className="size-3" />
        </Button>
      </div>
      <div className="max-h-40 overflow-auto px-2 py-1 break-all whitespace-pre-wrap text-json-number select-text">{block.text}</div>
    </div>
  );
}
