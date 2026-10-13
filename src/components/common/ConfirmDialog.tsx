import { useState } from "react";
import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/Modal";
import { useConfirmStore } from "../../store/confirmStore";
import { SqlText } from "../console/SqlText";

/** The open `confirm()` question, if any. Escape and outside clicks cancel. */
export function ConfirmDialog() {
  const pending = useConfirmStore((s) => s.pending);
  const answer = useConfirmStore((s) => s.answer);
  const [typed, setTyped] = useState("");
  const [asked, setAsked] = useState(pending);
  // a new question can replace an open one without closing it: its input starts empty
  if (asked !== pending) {
    setAsked(pending);
    setTyped("");
  }
  if (!pending) return null;

  const typing = !!pending.typeToConfirm;
  // strict: the text must match exactly, so a stray space keeps the button off
  const ready = !pending.typeToConfirm || typed === pending.typeToConfirm;

  return (
    <Modal
      title={pending.title}
      onClose={() => answer(false)}
      footer={
        <>
          <span className="flex-1" />
          {/* with a typed answer the input takes the focus, not a button */}
          <Button autoFocus={pending.danger && !typing} onClick={() => answer(false)}>
            {pending.cancelLabel ?? "Cancel"}
          </Button>
          <Button
            variant={pending.danger ? "destructive" : "primary"}
            autoFocus={!pending.danger && !typing}
            disabled={!ready}
            onClick={() => answer(true)}
          >
            {pending.confirmLabel}
          </Button>
        </>
      }
    >
      <div className="flex items-start gap-3">
        {pending.danger && <TriangleAlert className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />}
        <p className="m-0 whitespace-pre-wrap text-fg-2">{pending.message}</p>
      </div>
      {pending.sql && (
        <div className="mt-4 max-h-60 overflow-auto rounded-md border border-line-soft bg-panel px-3 py-2">
          <SqlText text={pending.sql} className="whitespace-pre-wrap" />
        </div>
      )}
      {pending.typeToConfirm && (
        <label className="mt-4 flex flex-col gap-1.5 text-sm text-fg-2">
          <span>
            Type <b className="font-data text-fg">{pending.typeToConfirm}</b> to confirm
          </span>
          <Input
            autoFocus
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing && ready) answer(true);
            }}
            spellCheck={false}
            className="font-data"
          />
        </label>
      )}
    </Modal>
  );
}
