import { createContext, useContext } from "react";

export interface PaneInfo {
  /** Shown in a pane of a split rather than the single view. */
  inPane: boolean;
  /**
   * A pane of three columns or of the grid: too narrow for the document
   * inspector, so a document opens under its row instead.
   */
  compact: boolean;
}

export const PaneContext = createContext<PaneInfo>({ inPane: false, compact: false });

export const usePane = () => useContext(PaneContext);
