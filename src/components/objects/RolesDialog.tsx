import { useEffect, useMemo, useState } from "react";
import { Check, FileCode, Search } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { rolesScript } from "@/lib/rolesSql";
import { objectsApi } from "../../lib/objectsApi";
import type { RolesTarget } from "../../store/objectDialogsStore";
import type { RoleInfo } from "../../types/objects";
import { openSql } from "./openSql";

const th = "sticky top-0 z-[2] h-[30px] bg-panel px-3 text-left text-sm font-medium whitespace-nowrap text-fg-2 border-b border-line";
const td = "h-[30px] border-b border-line-soft px-3 align-middle whitespace-nowrap";

function Flag({ on }: { on: boolean }) {
  return on ? <Check className="size-3.5 text-fg-2" aria-label="yes" /> : <span className="text-fg-3">·</span>;
}

/** The server's roles, read-only, with a script that recreates the ones picked. */
export function RolesDialog({ target, onClose }: { target: RolesTarget; onClose: () => void }) {
  const { connection, sessionId, database } = target;
  const [roles, setRoles] = useState<RoleInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [showSystem, setShowSystem] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());

  useEffect(() => {
    let current = true;
    objectsApi.listRoles(sessionId, database).then(
      (list) => current && setRoles(list),
      (e) => current && setError(String(e)),
    );
    return () => {
      current = false;
    };
  }, [sessionId, database]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (roles ?? []).filter((r) => (showSystem || !r.system) && (q === "" || r.name.toLowerCase().includes(q)));
  }, [roles, query, showSystem]);

  // with nothing ticked, the script covers every role listed
  const chosen = picked.size > 0 ? shown.filter((r) => picked.has(r.name)) : shown;
  const allPicked = shown.length > 0 && shown.every((r) => picked.has(r.name));

  function toggle(name: string) {
    setPicked((p) => {
      const next = new Set(p);
      if (!next.delete(name)) next.add(name);
      return next;
    });
  }

  return (
    <Modal
      title={`Roles on ${connection.name}`}
      onClose={onClose}
      width="max-w-5xl"
      bodyClassName="p-0"
      subheader={
        <div className="flex items-center gap-3 px-4 py-2.5">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute top-2 left-2.5 size-4 text-fg-3" aria-hidden />
            <Input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search roles" aria-label="Search roles" className="pl-8" />
          </div>
          <label className="flex cursor-pointer items-center gap-1.5 text-sm text-fg-2">
            <Switch size="sm" checked={showSystem} onCheckedChange={setShowSystem} />
            <span className="whitespace-nowrap">Predefined pg_* roles</span>
          </label>
        </div>
      }
      footer={
        <>
          <span className="flex-1 text-sm text-fg-3">
            {roles ? (picked.size > 0 ? `${chosen.length} selected` : `${shown.length} roles`) : ""} · passwords are not readable from the catalog
          </span>
          <Button onClick={onClose}>Close</Button>
          <Button
            variant="primary"
            disabled={chosen.length === 0}
            title="Open CREATE ROLE and GRANT statements for the selected roles (all listed, if none are selected) in a console"
            onClick={() => {
              openSql(connection, database, rolesScript(chosen));
              onClose();
            }}
          >
            <FileCode />
            Generate CREATE ROLE / GRANT script
          </Button>
        </>
      }
    >
      {error ? (
        <p className="m-0 p-4 text-sm text-danger">{error}</p>
      ) : !roles ? (
        <p className="m-0 p-4 text-sm text-fg-3">Loading…</p>
      ) : shown.length === 0 ? (
        <p className="m-0 p-4 text-sm text-fg-3">No role matches.</p>
      ) : (
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th className={cn(th, "w-9")}>
                <Checkbox
                  checked={allPicked}
                  aria-label="Select all listed roles"
                  onCheckedChange={(v) => setPicked(v === true ? new Set(shown.map((r) => r.name)) : new Set())}
                />
              </th>
              <th className={th}>Role</th>
              <th className={cn(th, "text-center")}>Login</th>
              <th className={cn(th, "text-center")}>Superuser</th>
              <th className={cn(th, "text-center")}>Create DB</th>
              <th className={cn(th, "text-center")}>Create role</th>
              <th className={cn(th, "text-center")}>Replication</th>
              <th className={cn(th, "text-right")}>Conn. limit</th>
              <th className={th}>Valid until</th>
              <th className={cn(th, "w-full")}>Member of</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.name} className="hover:bg-row-hover" title={r.comment ?? undefined}>
                <td className={td}>
                  <Checkbox checked={picked.has(r.name)} aria-label={`Select ${r.name}`} onCheckedChange={() => toggle(r.name)} />
                </td>
                <td className={cn(td, "font-data font-medium")}>{r.name}</td>
                <td className={cn(td, "text-center")}>
                  <Flag on={r.canLogin} />
                </td>
                <td className={cn(td, "text-center", r.superuser && "text-warn")}>
                  <Flag on={r.superuser} />
                </td>
                <td className={cn(td, "text-center")}>
                  <Flag on={r.createDb} />
                </td>
                <td className={cn(td, "text-center")}>
                  <Flag on={r.createRole} />
                </td>
                <td className={cn(td, "text-center")}>
                  <Flag on={r.replication} />
                </td>
                <td className={cn(td, "text-right tabular-nums text-fg-2")}>{r.connectionLimit < 0 ? "∞" : r.connectionLimit}</td>
                <td className={cn(td, "text-fg-2")}>{r.validUntil ? r.validUntil.slice(0, 16) : <span className="text-fg-3">never</span>}</td>
                <td className={cn(td, "max-w-0 truncate font-data text-fg-2")} title={r.memberOf.join(", ")}>
                  {r.memberOf.join(", ")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}
