import { describe, expect, it } from "vitest";
import { hostOs, installHint } from "./installHint";

describe("installHint", () => {
  it("names the version the server needs", () => {
    expect(installHint("linux", 18).command).toBe("sudo apt install postgresql-client-18");
    expect(installHint("windows", 17).text).toContain("PostgreSQL 17 installer");
    expect(installHint("mac", 18).command).toBe("brew install libpq");
  });

  it("tells the OS from the user agent", () => {
    expect(hostOs("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("windows");
    expect(hostOs("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)")).toBe("mac");
    expect(hostOs("Mozilla/5.0 (X11; Linux x86_64)")).toBe("linux");
  });
});
