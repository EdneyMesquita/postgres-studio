import { create } from "zustand";

export interface ConfirmOptions {
  title: string;
  message: string;
  /** The confirming button, e.g. "Delete". */
  confirmLabel: string;
  cancelLabel?: string;
  /** Destructive: the confirming button turns red and Cancel takes the focus. */
  danger?: boolean;
}

interface Pending extends ConfirmOptions {
  resolve: (confirmed: boolean) => void;
}

interface ConfirmState {
  pending: Pending | null;
  /** Answers the open question and closes it. */
  answer: (confirmed: boolean) => void;
}

export const useConfirmStore = create<ConfirmState>((set, get) => ({
  pending: null,
  answer: (confirmed) => {
    get().pending?.resolve(confirmed);
    set({ pending: null });
  },
}));

/**
 * Asks in the app's own dialog, not the system's: true when confirmed,
 * false when cancelled or dismissed. A second question while one is open
 * dismisses the first.
 */
export function confirm(options: ConfirmOptions): Promise<boolean> {
  useConfirmStore.getState().pending?.resolve(false);
  return new Promise((resolve) => useConfirmStore.setState({ pending: { ...options, resolve } }));
}
