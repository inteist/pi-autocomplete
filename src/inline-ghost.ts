import {
  CURSOR_MARKER,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { SOFTWARE_CURSOR_RESETS, SOFTWARE_CURSOR_START } from "./constants.js";

export function injectGhostAfterCursor(
  lines: string[],
  ghost: string,
  width: number,
  dim: (text: string) => string,
): string[] {
  const oneLineGhost = ghost.split("\n")[0] ?? "";
  if (!oneLineGhost) return lines;

  const markerLine = lines.findIndex((line) => line.includes(CURSOR_MARKER));
  if (markerLine === -1) return lines;

  const styledGhost = dim(oneLineGhost);
  const line = lines[markerLine]!;
  const markerIndex = line.indexOf(CURSOR_MARKER);
  const insertAt = findGhostInsertIndex(line, markerIndex);
  const injected = line.slice(0, insertAt) + styledGhost + line.slice(insertAt);
  const fitted =
    visibleWidth(injected.replaceAll(CURSOR_MARKER, "")) > width
      ? truncateToWidth(injected, width, "")
      : injected;

  return [
    ...lines.slice(0, markerLine),
    fitted,
    ...lines.slice(markerLine + 1),
  ];
}

function findGhostInsertIndex(line: string, markerIndex: number): number {
  const afterMarker = markerIndex + CURSOR_MARKER.length;

  if (line.startsWith(SOFTWARE_CURSOR_START, afterMarker)) {
    const contentStart = afterMarker + SOFTWARE_CURSOR_START.length;
    const reset = findFirstReset(line, contentStart);
    if (reset) return reset.index + reset.sequence.length;
  }

  return afterMarker;
}

function findFirstReset(
  line: string,
  startIndex: number,
): { index: number; sequence: (typeof SOFTWARE_CURSOR_RESETS)[number] } | null {
  let first: { index: number; sequence: (typeof SOFTWARE_CURSOR_RESETS)[number] } | null =
    null;

  for (const sequence of SOFTWARE_CURSOR_RESETS) {
    const index = line.indexOf(sequence, startIndex);
    if (index === -1) continue;
    if (!first || index < first.index) first = { index, sequence };
  }

  return first;
}
