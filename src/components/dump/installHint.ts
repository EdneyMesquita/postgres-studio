export type HostOs = "linux" | "mac" | "windows";

export interface InstallHint {
  /** What to do, in a sentence. */
  text: string;
  /** A command to copy, when there is one. */
  command: string | null;
}

/** The machine this runs on, from the webview's user agent. */
export function hostOs(userAgent = navigator.userAgent): HostOs {
  if (/Windows/i.test(userAgent)) return "windows";
  if (/Mac OS X|Macintosh/i.test(userAgent)) return "mac";
  return "linux";
}

/**
 * How to get the PostgreSQL client tools (pg_dump, pg_restore, psql) of at
 * least `major` on this OS. They're installed apart from the app: their
 * version has to keep up with the servers, not with Postgres Studio.
 */
export function installHint(os: HostOs, major: number): InstallHint {
  switch (os) {
    case "linux":
      return {
        text: `Install postgresql-client-${major} (Debian and Ubuntu ship older versions; the PostgreSQL apt repository at apt.postgresql.org has every one), or your distribution's postgresql${major} package.`,
        command: `sudo apt install postgresql-client-${major}`,
      };
    case "mac":
      return {
        text: "Install libpq with Homebrew (the newest client tools), or use Postgres.app, which Postgres Studio also finds.",
        command: "brew install libpq",
      };
    case "windows":
      return {
        text: `Run the PostgreSQL ${major} installer from postgresql.org and keep its "Command Line Tools" component; the server itself isn't needed.`,
        command: null,
      };
  }
}
