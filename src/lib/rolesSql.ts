import type { RoleInfo } from "../types/objects";
import { quote, stringLiteral } from "./objectsSql";

/** The attributes of a role as CREATE ROLE writes them, each spelled out so the script means the same wherever it runs. */
function attributes(r: RoleInfo): string[] {
  const out = [
    r.superuser ? "SUPERUSER" : "NOSUPERUSER",
    r.createDb ? "CREATEDB" : "NOCREATEDB",
    r.createRole ? "CREATEROLE" : "NOCREATEROLE",
    r.inherit ? "INHERIT" : "NOINHERIT",
    r.canLogin ? "LOGIN" : "NOLOGIN",
    r.replication ? "REPLICATION" : "NOREPLICATION",
    r.bypassRls ? "BYPASSRLS" : "NOBYPASSRLS",
    `CONNECTION LIMIT ${r.connectionLimit}`,
  ];
  if (r.validUntil) out.push(`VALID UNTIL ${stringLiteral(r.validUntil)}`);
  return out;
}

/**
 * CREATE ROLE statements for `roles`, then the GRANTs of the memberships
 * among the roles the script creates or that exist already. Passwords are
 * not in the catalog's reach, so a login role gets a reminder instead.
 */
export function rolesScript(roles: RoleInfo[]): string {
  if (roles.length === 0) return "";
  const lines = ["-- Roles of the server. Passwords are not readable from the catalog: set them with ALTER ROLE ... PASSWORD.", ""];
  for (const r of roles) {
    lines.push(`CREATE ROLE ${quote(r.name)} WITH\n  ${attributes(r).join("\n  ")};`);
    if (r.comment) lines.push(`COMMENT ON ROLE ${quote(r.name)} IS ${stringLiteral(r.comment)};`);
    if (r.canLogin) lines.push(`-- ALTER ROLE ${quote(r.name)} PASSWORD '...';`);
    lines.push("");
  }
  const grants = roles.flatMap((r) => r.memberOf.map((group) => `GRANT ${quote(group)} TO ${quote(r.name)};`));
  if (grants.length > 0) lines.push("-- Memberships", ...grants, "");
  return lines.join("\n");
}
