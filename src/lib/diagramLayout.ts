import type { DiagramColumn, DiagramForeignKey, DiagramTable } from "../types/pg";

/**
 * Where the schema diagram puts each table and how each foreign key runs.
 * Pure: the same tables and keys always give the same picture, and the
 * "around a table" scope is a filter followed by another layout.
 *
 * Tables go in layers by foreign-key depth, the tables others point to on
 * the left; each layer is ordered by where its neighbours sit, to keep
 * lines from crossing. Tables with no keys at all go in a grid at the end.
 */

export const BOX_W = 220;
export const HEAD_H = 30;
export const ROW_H = 22;
/** Columns shown per table; the keys always make it in. */
export const MAX_COLUMNS = 12;
const GAP_X = 90;
const GAP_Y = 28;
const MARGIN = 24;
/** A layer taller than this wraps into another column. */
const MAX_LAYER_H = 1500;

export interface LaidColumn extends DiagramColumn {
  /** Row index inside the box. */
  row: number;
}

export interface Box {
  name: string;
  /** A table of another schema, drawn only as the end of a key. */
  stub: boolean;
  /** `schema.table` for a stub, the name otherwise. */
  label: string;
  rowEstimate: number | null;
  x: number;
  y: number;
  h: number;
  /** The columns drawn, in table order. */
  columns: LaidColumn[];
  /** Columns left out for space. */
  hidden: number;
  /** Every column, for the inspector. */
  allColumns: DiagramColumn[];
}

export interface Edge {
  key: DiagramForeignKey;
  /** The table holding the key (the "many" end). */
  from: string;
  /** The table it points to (the "one" end). */
  to: string;
  d: string;
}

export interface Layout {
  boxes: Box[];
  edges: Edge[];
  width: number;
  height: number;
}

/** Shorter spellings of the common types, as psql's \d doesn't but people do. */
const SHORT_TYPES: [RegExp, string][] = [
  [/^timestamp\((\d)\) with time zone$/, "timestamptz($1)"],
  [/^timestamp with time zone$/, "timestamptz"],
  [/^timestamp\((\d)\) without time zone$/, "timestamp($1)"],
  [/^timestamp without time zone$/, "timestamp"],
  [/^time with time zone$/, "timetz"],
  [/^time without time zone$/, "time"],
  [/^character varying/, "varchar"],
  [/^character\b/, "char"],
  [/^bigint$/, "int8"],
  [/^integer$/, "int4"],
  [/^smallint$/, "int2"],
  [/^boolean$/, "bool"],
  [/^double precision$/, "float8"],
  [/^real$/, "float4"],
];

export function shortType(type: string): string {
  for (const [re, short] of SHORT_TYPES) if (re.test(type)) return type.replace(re, short);
  return type;
}

/** Stubs are keyed `schema.table`, which no table name of the schema can clash with... */
const stubKey = (fk: DiagramForeignKey) => `${fk.refSchema}.${fk.refTable}`;

/**
 * The foreign keys of `tables` that the diagram can draw: both ends among
 * `tables`, or the far end in another schema (as a stub).
 */
function drawable(tables: DiagramTable[], keys: DiagramForeignKey[], schema: string) {
  const names = new Set(tables.map((t) => t.name));
  return keys.filter((k) => names.has(k.table) && (k.refSchema !== schema || names.has(k.refTable)));
}

/** The columns a box shows: all of them, or the keys first and then the rest in order, up to the cap. */
function shownColumns(columns: DiagramColumn[]): { columns: LaidColumn[]; hidden: number } {
  if (columns.length <= MAX_COLUMNS) return { columns: columns.map((c, row) => ({ ...c, row })), hidden: 0 };
  const keep = new Set<string>();
  for (const c of columns) if ((c.pk || c.fk) && keep.size < MAX_COLUMNS - 1) keep.add(c.name);
  for (const c of columns) if (keep.size < MAX_COLUMNS - 1) keep.add(c.name);
  const shown = columns.filter((c) => keep.has(c.name)).map((c, row) => ({ ...c, row }));
  return { columns: shown, hidden: columns.length - shown.length };
}

function boxHeight(columns: number, hidden: number): number {
  return HEAD_H + (columns + (hidden > 0 ? 1 : 0)) * ROW_H;
}

/**
 * Lays out `tables` of `schema` and their keys. `keys` may hold keys of
 * tables not given (they are skipped), which is how a scope is applied.
 */
export function layoutDiagram(schema: string, tables: DiagramTable[], keys: DiagramForeignKey[]): Layout {
  const fks = drawable(tables, keys, schema);
  const byName = new Map(tables.map((t) => [t.name, t]));

  // parents: the in-schema tables a table points to
  const parents = new Map<string, Set<string>>();
  const children = new Map<string, Set<string>>();
  for (const t of tables) {
    parents.set(t.name, new Set());
    children.set(t.name, new Set());
  }
  for (const k of fks) {
    if (k.refSchema !== schema || k.refTable === k.table) continue;
    parents.get(k.table)!.add(k.refTable);
    children.get(k.refTable)!.add(k.table);
  }

  // rank = 1 + the deepest parent; a cycle is cut where it closes
  const rank = new Map<string, number>();
  const visiting = new Set<string>();
  const rankOf = (name: string): number => {
    const known = rank.get(name);
    if (known !== undefined) return known;
    if (visiting.has(name)) return 0;
    visiting.add(name);
    let r = 0;
    for (const p of parents.get(name) ?? []) r = Math.max(r, rankOf(p) + 1);
    visiting.delete(name);
    rank.set(name, r);
    return r;
  };

  const linked = tables.filter((t) => parents.get(t.name)!.size > 0 || children.get(t.name)!.size > 0);
  const loose = tables.filter((t) => !linked.includes(t));
  const layers: string[][] = [];
  for (const t of [...linked].sort((a, b) => a.name.localeCompare(b.name))) {
    const r = rankOf(t.name);
    (layers[r] ??= []).push(t.name);
  }

  // barycenter ordering, two sweeps each way
  const indexIn = (layer: string[]) => new Map(layer.map((n, i) => [n, i]));
  const sortBy = (layer: string[], neighbours: (n: string) => Set<string>, positions: Map<string, number>) => {
    const score = (n: string) => {
      const near = [...neighbours(n)].map((m) => positions.get(m)).filter((p): p is number => p !== undefined);
      return near.length ? near.reduce((a, b) => a + b, 0) / near.length : Number.POSITIVE_INFINITY;
    };
    const scored = layer.map((n, i) => ({ n, s: score(n), i }));
    scored.sort((a, b) => (a.s === b.s ? a.i - b.i : a.s - b.s));
    return scored.map((x) => x.n);
  };
  for (let sweep = 0; sweep < 2; sweep++) {
    for (let i = 1; i < layers.length; i++) {
      const positions = new Map<string, number>();
      for (let j = 0; j < i; j++) for (const [n, p] of indexIn(layers[j] ?? [])) positions.set(n, p);
      layers[i] = sortBy(layers[i] ?? [], (n) => parents.get(n)!, positions);
    }
    for (let i = layers.length - 2; i >= 0; i--) {
      const positions = new Map<string, number>();
      for (let j = i + 1; j < layers.length; j++) for (const [n, p] of indexIn(layers[j] ?? [])) positions.set(n, p);
      layers[i] = sortBy(layers[i] ?? [], (n) => children.get(n)!, positions);
    }
  }

  // stubs for keys into other schemas, in the column after the last layer
  const stubs = new Map<string, Box>();
  for (const k of fks) {
    if (k.refSchema === schema) continue;
    const key = stubKey(k);
    const stub = stubs.get(key) ?? {
      name: key,
      stub: true,
      label: key,
      rowEstimate: null,
      x: 0,
      y: 0,
      h: 0,
      columns: [],
      hidden: 0,
      allColumns: [],
    };
    for (const c of k.refColumns) {
      if (!stub.allColumns.some((x) => x.name === c)) {
        stub.allColumns.push({ name: c, type: "", notNull: true, pk: true, fk: false });
      }
    }
    stubs.set(key, stub);
  }

  const boxes: Box[] = [];
  let x = MARGIN;
  let height = 0;
  /** Stacks names into columns from `x`, wrapping tall ones; returns the next free x. */
  const place = (names: string[], startX: number): number => {
    let colX = startX;
    let y = MARGIN;
    let used = false;
    for (const name of names) {
      const t = byName.get(name)!;
      const { columns, hidden } = shownColumns(t.columns);
      const h = boxHeight(columns.length, hidden);
      if (used && y + h > MAX_LAYER_H) {
        colX += BOX_W + GAP_X;
        y = MARGIN;
      }
      boxes.push({ name, stub: false, label: name, rowEstimate: t.rowEstimate, x: colX, y, h, columns, hidden, allColumns: t.columns });
      y += h + GAP_Y;
      height = Math.max(height, y);
      used = true;
    }
    return used ? colX + BOX_W + GAP_X : startX;
  };
  for (const layer of layers) if (layer?.length) x = place(layer, x);
  if (stubs.size) {
    let y = MARGIN;
    for (const stub of stubs.values()) {
      stub.columns = stub.allColumns.map((c, row) => ({ ...c, row }));
      stub.h = boxHeight(stub.columns.length, 0);
      stub.x = x;
      stub.y = y;
      y += stub.h + GAP_Y;
      height = Math.max(height, y);
      boxes.push(stub);
    }
    x += BOX_W + GAP_X;
  }
  if (loose.length) x = place([...loose].sort((a, b) => a.name.localeCompare(b.name)).map((t) => t.name), x);

  const box = new Map(boxes.map((b) => [b.name, b]));
  const rowY = (b: Box, column: string | undefined) => {
    const c = b.columns.find((x) => x.name === column);
    return c ? b.y + HEAD_H + c.row * ROW_H + ROW_H / 2 : b.y + HEAD_H / 2;
  };

  // keys sharing the gap between two columns get their own lane
  const lanes = new Map<number, number>();
  const lane = (gapX: number) => {
    const n = lanes.get(gapX) ?? 0;
    lanes.set(gapX, n + 1);
    return 14 + (n % 8) * 8;
  };

  const edges: Edge[] = fks.map((k) => {
    const a = box.get(k.table)!;
    const b = box.get(k.refSchema === schema ? k.refTable : stubKey(k))!;
    const y1 = rowY(a, k.columns[0]);
    const y2 = rowY(b, k.refColumns[0]);
    let x1: number, x2: number, s1: number, s2: number, mid: number;
    if (b.x + BOX_W <= a.x) {
      // the usual: the referenced table on the left
      x1 = a.x;
      x2 = b.x + BOX_W;
      s1 = -1;
      s2 = 1;
      mid = x2 + lane(x2);
    } else if (a.x + BOX_W <= b.x) {
      x1 = a.x + BOX_W;
      x2 = b.x;
      s1 = 1;
      s2 = -1;
      mid = x1 + lane(x1);
    } else {
      // same column, or a table pointing at itself: loop out on the right
      x1 = a.x + BOX_W;
      x2 = b.x + BOX_W;
      s1 = 1;
      s2 = 1;
      mid = x1 + lane(x1);
    }
    // the many end is a crow's foot at the key, the one end a bar at what it points to
    const foot = `M ${x1 + s1 * 10} ${y1} L ${x1} ${y1 - 5} M ${x1 + s1 * 10} ${y1} L ${x1} ${y1 + 5}`;
    const bar = `M ${x2 + s2 * 8} ${y2 - 5} L ${x2 + s2 * 8} ${y2 + 5}`;
    return { key: k, from: a.name, to: b.name, d: `M ${x1} ${y1} H ${mid} V ${y2} H ${x2} ${foot} ${bar}` };
  });

  return { boxes, edges, width: Math.max(x - GAP_X + MARGIN, BOX_W + 2 * MARGIN), height: Math.max(height, HEAD_H + 2 * MARGIN) };
}

/** The tables a table touches through its keys, either way, and itself. */
export function neighbourhood(name: string, keys: DiagramForeignKey[], schema: string): Set<string> {
  const near = new Set([name]);
  for (const k of keys) {
    if (k.refSchema !== schema) continue;
    if (k.table === name) near.add(k.refTable);
    if (k.refTable === name) near.add(k.table);
  }
  return near;
}
