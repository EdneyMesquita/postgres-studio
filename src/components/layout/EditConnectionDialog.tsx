import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "../../lib/tauri";
import type { ConnectionProfile } from "../../types/connection";
import { ConnectionForm } from "../connections/ConnectionForm";

interface EditConnectionDialogProps {
  id: string;
  onClose: () => void;
}

/** Loads a saved connection, secrets included, then shows it in the form. */
export function EditConnectionDialog({ id, onClose }: EditConnectionDialogProps) {
  const [profile, setProfile] = useState<ConnectionProfile | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.getConnectionProfile(id).then(
      (loaded) => {
        if (!cancelled) setProfile(loaded);
      },
      (e) => {
        if (cancelled) return;
        toast.error("Couldn't open the connection", { description: String(e) });
        onClose();
      },
    );
    return () => {
      cancelled = true;
    };
    // onClose is a fresh closure every render; the load depends on id alone
  }, [id]);

  if (!profile) return null;
  return <ConnectionForm editing={profile} onSaved={onClose} onCancel={onClose} />;
}
