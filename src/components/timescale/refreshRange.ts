/**
 * The range a continuous aggregate refresh covers, as the user types it:
 * PostgreSQL's timestamp text on both ends, empty for an open bound.
 */

const UNITS: [prefix: string, ms: number][] = [
  ["sec", 1_000],
  ["min", 60_000],
  ["hour", 3_600_000],
  ["hr", 3_600_000],
  ["day", 86_400_000],
  ["week", 604_800_000],
];

/**
 * A timestamp as PostgreSQL writes it: `2026-09-01`, `2026-09-01 00:00+00`,
 * `2026-09-01T10:30:00.5Z`. Milliseconds since the epoch, or null. A time
 * without an offset is taken as UTC; the session's time zone is not known here.
 */
export function parseBound(text: string): number | null {
  const m = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(?:\s*(Z|[+-]\d{2}(?::?\d{2})?))?)?$/i.exec(text.trim());
  if (!m) return null;
  const [, date, time, zone] = m;
  // Date.parse wants `+HH:MM`; PostgreSQL also writes `+HH`
  const offset = !zone || zone.toUpperCase() === "Z" ? "Z" : zone.length === 3 ? `${zone}:00` : zone.replace(/^([+-]\d{2})(\d{2})$/, "$1:$2");
  const ms = Date.parse(`${date}T${time ?? "00:00"}${offset}`);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * An interval as PostgreSQL writes it, for a bucket width: `01:00:00`,
 * `1 hour`, `7 days`, `1 day 02:00:00`. Milliseconds, or null when it is
 * unknown or has months or years, whose length isn't fixed.
 */
export function intervalMs(text: string): number | null {
  let rest = text.trim().toLowerCase();
  if (!rest) return null;
  let total = 0;
  const clock = /(?:^|\s)(-?)(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(rest);
  if (clock) {
    const seconds = Number(clock[2]) * 3600 + Number(clock[3]) * 60 + Number(clock[4]);
    total += (clock[1] === "-" ? -1 : 1) * seconds * 1000;
    rest = rest.slice(0, clock.index);
  }
  const units = /(-?\d+(?:\.\d+)?)\s*([a-z]+)/g;
  for (const m of rest.matchAll(units)) {
    const unit = UNITS.find(([prefix]) => m[2].startsWith(prefix));
    if (!unit) return null;
    total += Number(m[1]) * unit[1];
  }
  if (rest.replace(units, "").trim() !== "") return null;
  return total;
}

/**
 * About how many buckets a refresh over [start, end) touches, partial ones
 * included. Null when a bound is open or unparseable, the width is unknown,
 * or the range is empty.
 */
export function estimateBuckets(start: string, end: string, width: string | null, now: number = Date.now()): number | null {
  const from = parseBound(start);
  // an open end refreshes up to now
  const to = end.trim() === "" ? now : parseBound(end);
  const step = width ? intervalMs(width) : null;
  if (from === null || to === null || step === null || step <= 0 || to <= from) return null;
  return Math.ceil((to - from) / step);
}

/** `2026-09-01 00:00:00+00`, the form the inputs take for a preset. */
export function utcTimestamp(d: Date): string {
  return `${d.toISOString().slice(0, 19).replace("T", " ")}+00`;
}

/** The range a quick preset fills in: the last `days` days up to now, or everything when null. */
export function rangeForDays(days: number | null, now: Date): { start: string; end: string } {
  if (days === null) return { start: "", end: "" };
  return { start: utcTimestamp(new Date(now.getTime() - days * 86_400_000)), end: "" };
}
