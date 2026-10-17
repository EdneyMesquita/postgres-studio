import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/Modal";
import { defaultAccess, useAssistantStore } from "../../store/assistantStore";
import {
  CheckboxConnectionTree,
  ConnectionPickerHeader,
  ConnectionTreeEmpty,
  groupState,
  useConnectionTree,
} from "../connections/ConnectionTreePicker";

/**
 * Picks the connections the Assistant may read, laid out in the sidebar's
 * folders: a box per folder ticks everything in it, one at the top ticks
 * everything shown, and the filter narrows by name, address or folder.
 * Changes apply as they're made.
 */
export function AssistantAccessDialog({ onClose }: { onClose: () => void }) {
  const access = useAssistantStore((s) => s.access);
  const setAccess = useAssistantStore((s) => s.setAccess);
  const [query, setQuery] = useState("");
  const { profiles, byId, shown, shownIds, filtered } = useConnectionTree(query);

  const allowed = (id: string) => access[id] ?? defaultAccess(byId.get(id)?.summary);
  const allowedCount = profiles.filter((p) => allowed(p.id)).length;

  return (
    <Modal
      title="Connections the Assistant may read"
      onClose={onClose}
      width="max-w-2xl"
      bodyClassName="px-2.5 py-2"
      subheader={
        <div className="px-[18px] py-2.5">
          <ConnectionPickerHeader
            autoFocus
            query={query}
            onQueryChange={setQuery}
            selectAll={{
              state: shownIds.length === 0 ? false : groupState(shownIds, allowed),
              disabled: shownIds.length === 0,
              onToggle: () => setAccess(shownIds, groupState(shownIds, allowed) !== true),
              filtered,
            }}
            count={`${allowedCount} of ${profiles.length} allowed`}
          />
        </div>
      }
      footer={
        <>
          <p className="m-0 flex-1 text-xs leading-normal text-fg-3">
            Connection strings and passwords never reach the agent.
          </p>
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </>
      }
    >
      {shown.length === 0 ? (
        <ConnectionTreeEmpty hasProfiles={profiles.length > 0} query={query} />
      ) : (
        <CheckboxConnectionTree
          nodes={shown}
          byId={byId}
          isChecked={allowed}
          setChecked={setAccess}
          connectionTrailing={(p) =>
            defaultAccess(p.summary) ? <span className="text-xs text-fg-3">This computer</span> : null
          }
          aria-label="Connections the Assistant may read"
        />
      )}
    </Modal>
  );
}
