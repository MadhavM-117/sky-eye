// Server-side anchor capture (spec §12): the pinned line's exact text plus up
// to 3 lines before/after. Read from the VCS file (caller passes the lines)
// so context is full even at hunk boundaries; chapter hunks are the fallback.
import type { Anchor, Hunk } from "./types.ts";

// capture from full file lines (line is 1-based, clamped to the file);
// pure, fixture-tested
export function captureAnchor(
  fileLines: string[],
  file: string,
  side: "old" | "new",
  line: number,
  chapterId: string,
): Anchor {
  const last = Math.max(fileLines.length - 1, 0);
  const i = Math.min(Math.max(line - 1, 0), last);
  return {
    file,
    side,
    line,
    text: fileLines[i] ?? "",
    before: fileLines.slice(Math.max(i - 3, 0), i),
    after: fileLines.slice(i + 1, i + 4),
    chapterId,
  };
}

// fallback when the VCS read fails (spec §12): rebuild the side's lines from
// the chapter's hunks — sparse (only hunk coverage), so context lines outside
// hunks come back empty
export function captureAnchorFromHunks(
  hunks: Hunk[],
  file: string,
  side: "old" | "new",
  line: number,
  chapterId: string,
): Anchor {
  const byLine = new Map<number, string>();
  for (const h of hunks)
    for (const l of h.lines) {
      const n = side === "new" ? l.newLine : l.oldLine;
      if (n != null) byLine.set(n, l.text);
    }
  const lines: string[] = [];
  for (let n = 1; n <= Math.max(line, ...byLine.keys()); n++)
    lines.push(byLine.get(n) ?? "");
  return captureAnchor(lines, file, side, line, chapterId);
}
