import { describe, expect, it } from "vitest";
import type { RoleInfo } from "../types/objects";
import { rolesScript } from "./rolesSql";

const role = (name: string, extra: Partial<RoleInfo> = {}): RoleInfo => ({
  name,
  canLogin: false,
  superuser: false,
  createDb: false,
  createRole: false,
  replication: false,
  bypassRls: false,
  inherit: true,
  connectionLimit: -1,
  validUntil: null,
  memberOf: [],
  comment: null,
  system: false,
  ...extra,
});

describe("rolesScript", () => {
  it("writes nothing for no roles", () => {
    expect(rolesScript([])).toBe("");
  });

  it("spells out every attribute", () => {
    const sql = rolesScript([role("app", { canLogin: true, createDb: true, connectionLimit: 10 })]);
    expect(sql).toContain("CREATE ROLE app WITH\n  NOSUPERUSER\n  CREATEDB\n  NOCREATEROLE\n  INHERIT\n  LOGIN\n  NOREPLICATION\n  NOBYPASSRLS\n  CONNECTION LIMIT 10;");
    expect(sql).toContain("-- ALTER ROLE app PASSWORD '...';");
  });

  it("quotes names and escapes literals", () => {
    const sql = rolesScript([role("Report User", { validUntil: "2099-01-01 00:00:00+00", comment: "it's ok" }), role("user")]);
    expect(sql).toContain('CREATE ROLE "Report User" WITH');
    expect(sql).toContain("VALID UNTIL '2099-01-01 00:00:00+00'");
    expect(sql).toContain(`COMMENT ON ROLE "Report User" IS 'it''s ok';`);
    expect(sql).toContain('CREATE ROLE "user" WITH');
  });

  it("grants memberships after all the roles", () => {
    const sql = rolesScript([role("alice", { memberOf: ["readers", "Admin Group"] }), role("readers")]);
    expect(sql.indexOf("CREATE ROLE readers")).toBeLessThan(sql.indexOf("GRANT"));
    expect(sql).toContain('GRANT readers TO alice;\nGRANT "Admin Group" TO alice;');
  });
});
