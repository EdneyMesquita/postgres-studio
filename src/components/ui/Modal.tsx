import type { ReactNode } from "react";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Rendered in a fixed strip between the header and the body, e.g. tabs. */
  subheader?: ReactNode;
  /** Rendered in a fixed bar below the scrollable body. */
  footer?: ReactNode;
  /** Tailwind max-width class for the panel. */
  width?: string;
  /** Extra classes for the scrolling body, e.g. tighter padding for a list. */
  bodyClassName?: string;
}

/**
 * A dialog that is open while mounted: header, optional subheader, a
 * scrolling body and an optional footer. Built on the Radix dialog, so it
 * traps focus, closes on Escape and outside click, and restores focus.
 */
export function Modal({
  title,
  onClose,
  children,
  subheader,
  footer,
  width = "max-w-md",
  bodyClassName,
}: ModalProps) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className={cn(width)} aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {subheader && <div className="shrink-0 border-b border-line">{subheader}</div>}
        <DialogBody className={bodyClassName}>{children}</DialogBody>
        {footer && <DialogFooter>{footer}</DialogFooter>}
      </DialogContent>
    </Dialog>
  );
}
