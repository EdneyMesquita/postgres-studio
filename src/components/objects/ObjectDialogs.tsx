import { lazy, Suspense } from "react";
import { useObjectDialogsStore } from "../../store/objectDialogsStore";

// Loaded on first use, keeping them out of the startup bundle.
const ManageExtensionsDialog = lazy(() =>
  import("./ManageExtensionsDialog").then((m) => ({ default: m.ManageExtensionsDialog })),
);

const RolesDialog = lazy(() => import("./RolesDialog").then((m) => ({ default: m.RolesDialog })));

/** The dialogs of the object tools that are open. */
export function ObjectDialogs() {
  const extensions = useObjectDialogsStore((s) => s.extensions);
  const closeExtensions = useObjectDialogsStore((s) => s.closeExtensions);
  const roles = useObjectDialogsStore((s) => s.roles);
  const closeRoles = useObjectDialogsStore((s) => s.closeRoles);
  return (
    <Suspense fallback={null}>
      {extensions && <ManageExtensionsDialog target={extensions} onClose={closeExtensions} />}
      {roles && <RolesDialog target={roles} onClose={closeRoles} />}
    </Suspense>
  );
}
