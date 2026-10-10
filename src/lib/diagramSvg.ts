import { BOX_W, HEAD_H, ROW_H, shortType } from "./diagramLayout";
import type { Layout } from "./diagramLayout";

const esc = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The theme's colors right now, so the file looks like the screen without the app's CSS. */
function themeColors() {
  const css = getComputedStyle(document.documentElement);
  const get = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    bg: get("--color-editor", "#1e1e1e"),
    panel: get("--color-panel", "#252526"),
    line: get("--color-line", "#3c3c3c"),
    edge: get("--color-field-line", "#5a5a5a"),
    fg: get("--color-fg", "#e6e6e6"),
    fg2: get("--color-fg-2", "#b4b4b4"),
    fg3: get("--color-fg-3", "#8a8a8a"),
    pk: get("--color-json-keyword", "#c586c0"),
    fk: get("--color-accent-text", "#4fc1ff"),
  };
}

/**
 * The laid-out diagram as a standalone SVG document: every color resolved,
 * keys marked PK / FK in text, nothing selected or dimmed.
 */
export function diagramToSvg(layout: Layout, title: string): string {
  const c = themeColors();
  const mono = `'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace`;
  const sans = `Inter, system-ui, -apple-system, 'Segoe UI', sans-serif`;
  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${layout.width}" height="${layout.height}" viewBox="0 0 ${layout.width} ${layout.height}">`,
    `<title>${esc(title)}</title>`,
    `<rect width="100%" height="100%" fill="${c.bg}"/>`,
  );
  for (const e of layout.edges) {
    parts.push(`<path d="${e.d}" fill="none" stroke="${c.edge}" stroke-width="1.25"/>`);
  }
  for (const b of layout.boxes) {
    parts.push(`<g transform="translate(${b.x},${b.y})">`);
    parts.push(
      `<rect width="${BOX_W}" height="${b.h}" rx="6" fill="${c.panel}" stroke="${c.line}"${b.stub ? ` stroke-dasharray="4 3"` : ""}/>`,
      `<line x1="0" x2="${BOX_W}" y1="${HEAD_H}" y2="${HEAD_H}" stroke="${c.line}"/>`,
      `<text x="12" y="19.5" font-family="${sans}" font-size="12.5" font-weight="600" fill="${b.stub ? c.fg2 : c.fg}">${esc(b.label)}</text>`,
    );
    if (b.rowEstimate !== null) {
      parts.push(
        `<text x="${BOX_W - 12}" y="19.5" text-anchor="end" font-family="${sans}" font-size="11" fill="${c.fg3}">~${b.rowEstimate.toLocaleString("en")}</text>`,
      );
    }
    for (const col of b.columns) {
      const y = HEAD_H + col.row * ROW_H + 15;
      if (col.pk || col.fk) {
        parts.push(
          `<text x="8" y="${y}" font-family="${sans}" font-size="8.5" font-weight="700" fill="${col.pk ? c.pk : c.fk}">${col.pk ? "PK" : "FK"}</text>`,
        );
      }
      parts.push(
        `<text x="28" y="${y}" font-family="${mono}" font-size="11.5" fill="${col.pk || col.fk ? c.fg : c.fg2}">${esc(col.name)}</text>`,
        `<text x="${BOX_W - 12}" y="${y}" text-anchor="end" font-family="${mono}" font-size="10.5" fill="${c.fg3}">${esc(shortType(col.type))}</text>`,
      );
    }
    if (b.hidden > 0) {
      parts.push(
        `<text x="28" y="${HEAD_H + b.columns.length * ROW_H + 15}" font-family="${sans}" font-size="11" font-style="italic" fill="${c.fg3}">+${b.hidden} more</text>`,
      );
    }
    parts.push(`</g>`);
  }
  parts.push(`</svg>`);
  return parts.join("\n");
}
