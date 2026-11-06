// Hunks → chapters (spec §8). M1: file boundary + size rules; funcname context
// and keep-together tuning arrive in task 004 via the shouldSplit predicate.
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

// M1 splits on file change and size only. Task 004 adds function-context and
// keep-together rules here.
function shouldSplit(
  _prev: Hunk,
  _next: Hunk,
  _sameFile: boolean,
): boolean {
  return false;
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
        (current.lines + size > config.targetLines ||
          shouldSplit(current.hunks.at(-1)!, hunk, true))
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
