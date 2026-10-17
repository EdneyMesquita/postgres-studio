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

/**
 * How to get psql for the console. Postgres Studio doesn't download it:
 * no official build comes with a published checksum for every platform.
 */
export function psqlInstallHint(os: HostOs): InstallHint {
  switch (os) {
    case "linux":
      return {
        text: "Debian and Ubuntu. Fedora: sudo dnf install postgresql · Arch: sudo pacman -S postgresql-libs · apt.postgresql.org has every version.",
        command: "sudo apt install postgresql-client",
      };
    case "mac":
      return {
        text: "Homebrew keeps libpq off the PATH; Postgres Studio looks in its folder anyway. Postgres.app works too.",
        command: "brew install libpq",
      };
    case "windows":
      return {
        text: "Or run the installer from postgresql.org and keep its Command Line Tools; the server itself isn't needed.",
        command: "winget install PostgreSQL.PostgreSQL.18",
      };
  }
}
