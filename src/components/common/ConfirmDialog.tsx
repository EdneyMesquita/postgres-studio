import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/Modal";
import { useConfirmStore } from "../../store/confirmStore";

/** The open `confirm()` question, if any. Escape and outside clicks cancel. */
export function ConfirmDialog() {
  const pending = useConfirmStore((s) => s.pending);
  const answer = useConfirmStore((s) => s.answer);
  if (!pending) return null;

  return (
    <Modal
      title={pending.title}
      onClose={() => answer(false)}
      footer={
        <>
          <span className="flex-1" />
          <Button autoFocus={pending.danger} onClick={() => answer(false)}>
            {pending.cancelLabel ?? "Cancel"}
          </Button>
          <Button
            variant={pending.danger ? "destructive" : "primary"}
            autoFocus={!pending.danger}
            onClick={() => answer(true)}
          >
            {pending.confirmLabel}
          </Button>
        </>
      }
    >
      <div className="flex items-start gap-3">
        {pending.danger && <TriangleAlert className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />}
        <p className="m-0 text-fg-2">{pending.message}</p>
      </div>
    </Modal>
  );
}
