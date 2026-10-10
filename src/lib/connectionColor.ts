import { useConnectionsStore } from "../store/connectionsStore";

/**
 * A connection's identity colors, in picker order (DESIGN.md: connection
 * palette). They mark where a query runs - chip, tab underline, toolbar
 * edge, status bar - and nothing else.
 */
export const CONNECTION_COLORS = [
  "#4FA25A",
  "#3574F0",
  "#C9912C",
  "#D6453D",
  "#B4448F",
  "#1E9AA6",
  "#7B61D1",
  "#6E7380",
] as const;

function hash(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** The connection's own color, or a stable one picked from its id. */
export function connectionColor(id: string, color?: string | null): string {
  return color || CONNECTION_COLORS[hash(id) % CONNECTION_COLORS.length];
}

/** Up to two letters for the connection chip: "Local dev" -> "LD". */
export function connectionInitials(name: string): string {
  const words = name.trim().split(/[\s._-]+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/** Live color for a connection id, following edits to the profile. */
export function useConnectionColor(id: string): string {
  const color = useConnectionsStore((s) => s.profiles.find((p) => p.id === id)?.color);
  return connectionColor(id, color);
}
