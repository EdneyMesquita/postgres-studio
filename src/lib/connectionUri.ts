/** One fact read out of a connection string, shown as a chip under it. */
export interface UriFact {
  label: string;
  value?: string;
  suffix?: string;
}

function decode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * What a postgres:// URI or a libpq key=value string says, for a quick
 * visual check. Never shows the password. Returns [] for anything it can't
 * read - the backend is the one that validates.
 */
export function describeConnectionUri(uri: string): UriFact[] {
  const text = uri.trim();
  const match = /^(postgres(?:ql)?):\/\/([^/?#]*)(?:\/([^?#]*))?(?:\?([^#]*))?/.exec(text);
  if (match) {
    const [, , authority, path, query] = match;
    const at = authority.lastIndexOf("@");
    const userinfo = at >= 0 ? authority.slice(0, at) : "";
    const hosts = (at >= 0 ? authority.slice(at + 1) : authority).split(",").filter(Boolean);
    const params = new URLSearchParams(query ?? "");
    const facts: UriFact[] = [];
    if (hosts.length) facts.push({ label: hosts.length > 1 ? "hosts" : "host", value: hosts.map(decode).join(", ") });
    const user = userinfo.split(":")[0] || params.get("user");
    if (user) facts.push({ label: "user", value: decode(user) });
    const database = decode(path ?? "") || params.get("dbname");
    if (database) facts.push({ label: "database", value: database });
    const sslmode = params.get("sslmode");
    if (sslmode) facts.push({ label: "sslmode", value: sslmode });
    if (userinfo.includes(":") || params.has("password")) facts.push({ label: "password", suffix: "moves to the keychain" });
    return facts;
  }
  // key=value form
  const pairs = [...text.matchAll(/(\w+)\s*=\s*('(?:[^'\\]|\\.)*'|\S+)/g)].map(([, k, v]) => [k, v.replace(/^'|'$/g, "")]);
  if (pairs.length === 0) return [];
  const get = (key: string) => pairs.find(([k]) => k === key)?.[1];
  const facts: UriFact[] = [];
  const host = get("host") ?? get("hostaddr");
  if (host) facts.push({ label: "host", value: get("port") ? `${host}:${get("port")}` : host });
  if (get("user")) facts.push({ label: "user", value: get("user") });
  if (get("dbname")) facts.push({ label: "database", value: get("dbname") });
  if (get("sslmode")) facts.push({ label: "sslmode", value: get("sslmode") });
  if (get("password")) facts.push({ label: "password", suffix: "moves to the keychain" });
  return facts;
}
