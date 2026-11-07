// Hunks → chapters (spec §8): file boundary, funcname boundaries (§8.2),
// keep-together up to maxLines (§8.4), distance fallback when no header context.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Chapter, FileDiff, Hunk, ReviewConfig } from "./types.ts";

const DEFAULT_CONFIG: ReviewConfig = { targetLines: 75, maxLines: 200 };

export function loadConfig(root: string): ReviewConfig {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(root, ".sky-watch", "config.json"), "utf8"),
    ) as { review?: Partial<ReviewConfig> };
    return { ...DEFAULT_CONFIG, ...parsed.review };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export const changedLines = (hunk: Hunk) =>
  hunk.lines.filter((l) => l.type !== "ctx").length;

// funcname context from the raw header (git and jj both emit it, spec §22.1):
// "@@ -1,9 +1,10 @@ fn a() {" → "fn a() {". Git truncates long contexts — the
// trimmed string is still a stable identity for equality.
export function funcOf(hunk: Hunk): string | null {
  const m = hunk.header?.match(/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@ ?(.*)$/);
  return m && m[1] ? m[1] : null;
}

// §8.2: a new chapter starts when the function context changes, or (with no
// context available — rebuilt/fixture hunks) on size or >30 unchanged lines
// between hunks. §8.4: with the SAME context, keep-together wins — hunks stay
// together past targetLines, up to the maxLines hard max.
function shouldSplit(
  prev: Hunk,
  next: Hunk,
  projected: number,
  config: ReviewConfig,
): boolean {
  const a = funcOf(prev);
  const b = funcOf(next);
  if (a !== null && a === b) return projected > config.maxLines;
  if (a !== null && b !== null) return true; // different funcnames
  return (
    projected > config.targetLines ||
    next.newStart - (prev.newStart + prev.newLines) > 30
  );
}

export function chunk(
  files: FileDiff[],
  config: ReviewConfig = DEFAULT_CONFIG,
): Chapter[] {
  const chapters: Chapter[] = [];
  // rule 1: alphabetical path order, positional order within a file
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  for (const file of sorted) {
    if (file.binary) continue;
    let current: { hunks: Hunk[]; lines: number } | null = null;
    const flush = () => {
      if (!current) return;
      const first = current.hunks[0];
      const id = chapterId(file.path, first);
      chapters.push({
        id,
        file: file.path,
        status: file.status,
        hunks: current.hunks,
        narrative: "unanalyzed",
        attention: [],
      });
      current = null;
    };
    for (const hunk of file.hunks) {
      const size = changedLines(hunk);
      if (
        current &&
        shouldSplit(
          current.hunks.at(-1)!,
          hunk,
          current.lines + size,
          config,
        )
      ) {
        flush();
      }
      if (!current) current = { hunks: [], lines: 0 };
      // rule 3: an unbreakable hunk larger than maxLines stays one chapter
      current.hunks.push(hunk);
      current.lines += size;
    }
    flush();
  }
  return chapters;
}

// rule 5: sha256 of file + first hunk's old/new ranges, first 12 hex (spec §8.5)
export function chapterId(file: string, first: Hunk): string {
  const key = `${file}:${first.oldStart},${first.oldLines}->${first.newStart},${first.newLines}`;
  return createHash("sha256").update(key).digest("hex").slice(0, 12);
}
