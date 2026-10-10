import { useEffect, useState } from "react";
import { useConnectionsStore } from "@/store/connectionsStore";
import {
  newProfileInput,
  profileToInput,
  type ConnectionProfile,
  type ConnectionProfileInput,
} from "@/types/connection";
import { folderOf, placeInFolder } from "./connectionFolder";
import type { ConnectionSection, UpdateInput } from "./connectionFormTypes";

/** The connection form's state and its test / save actions. */
export function useConnectionForm(editing: ConnectionProfile | undefined, onSaved: () => void) {
  const [input, setInput] = useState<ConnectionProfileInput>(() =>
    editing ? profileToInput(editing) : newProfileInput(),
  );
  const [section, setSection] = useState<ConnectionSection>("general");
  const [initialFolder] = useState(() => (editing ? folderOf(editing.id) : null));
  const [folder, setFolder] = useState(initialFolder);
  // A new connection's id is picked here, so "Save and connect" knows what
  // to connect to; the backend keeps a non-empty id as given.
  const [newId] = useState(() => crypto.randomUUID());
  const [testing, setTesting] = useState(false);
  const { saveProfile, testConnection, connect, lastTestResult, loading, error } =
    useConnectionsStore();

  // Test result and error live in the store, so clear whatever a previous
  // visit left behind instead of reopening the dialog with a stale banner.
  useEffect(() => {
    useConnectionsStore.setState({ lastTestResult: null, error: null });
  }, []);

  const update: UpdateInput = (key, value) => setInput((prev) => ({ ...prev, [key]: value }));

  async function test() {
    setTesting(true);
    try {
      await testConnection(input);
    } finally {
      setTesting(false);
    }
  }

  async function save(andConnect: boolean) {
    const id = editing?.id ?? newId;
    try {
      await saveProfile({ ...input, id });
    } catch {
      // saveProfile already put the message in the store; keep the dialog open
      return;
    }
    if (folder !== initialFolder) {
      placeInFolder(id, folder, useConnectionsStore.getState().profiles.map((p) => p.id));
    }
    // connect reports its own failure on the connection's row
    if (andConnect) void connect(id);
    onSaved();
  }

  return {
    /** The connection's id, picked up front for a new one. */
    id: editing?.id ?? newId,
    input,
    update,
    section,
    setSection,
    folder,
    setFolder,
    testing,
    test,
    save,
    lastTestResult,
    loading,
    error,
  };
}
