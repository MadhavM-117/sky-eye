// Hunks → chapters (spec §8): funcname boundaries within a file (§8.2),
// keep-together up to maxLines (§8.4), distance fallback when no header
// context; chapters may span files — no file-boundary split (task 009).
import { createHash } from "node:crypto";
import { loadConfigObject } from "./config.ts";
import type { Chapter, FileDiff, FileSlice, Hunk, ReviewConfig } from "./types.ts";

const DEFAULT_CONFIG: ReviewConfig = { targetLines: 75, maxLines: 200 };

export function loadConfig(root: string): ReviewConfig {
  const parsed = loadConfigObject(root) as { review?: Partial<ReviewConfig> } | undefined;
  return { ...DEFAULT_CONFIG, ...parsed?.review };
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

// §8.2/§8.4 split rules between consecutive hunks. Same (file, funcname)
// keeps together past targetLines up to maxLines; different funcnames in the
// same file always split; a different FILE never splits by itself — only size
// or (within a file, §8.2 fallback) distance starts a new chapter. `projected`
// is the chapter size if the next hunk joined.
function shouldSplit(
  prevFile: string,
  prev: Hunk,
  nextFile: string,
  next: Hunk,
  projected: number,
  config: ReviewConfig,
): boolean {
  if (prevFile === nextFile) {
    const a = funcOf(prev);
    const b = funcOf(next);
    if (a !== null && a === b) return projected > config.maxLines;
    if (a !== null && b !== null) return true; // different funcnames
    return (
      projected > config.targetLines ||
      next.newStart - (prev.newStart + prev.newLines) > 30
    );
  }
  return projected > config.targetLines;
}

interface Pending {
  slices: FileSlice[];
  lines: number;
}

export function chunk(
  files: FileDiff[],
  config: ReviewConfig = DEFAULT_CONFIG,
): Chapter[] {
  const chapters: Chapter[] = [];
  // rule 1: alphabetical path order, positional order within a file — so a
  // file's hunks stay contiguous and a chapter holds at most one slice/file
  const hunks: { file: string; status: FileDiff["status"]; hunk: Hunk }[] = [];
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    if (file.binary) continue;
    for (const hunk of file.hunks)
      hunks.push({ file: file.path, status: file.status, hunk });
  }

  let current: Pending | null = null;
  const flush = () => {
    if (!current) return;
    const id = chapterId(current.slices);
    chapters.push({
      id,
      files: current.slices,
      narrative: "unanalyzed",
      attention: [],
    });
    current = null;
  };

  for (const { file, status, hunk } of hunks) {
    const size = changedLines(hunk);
    const prevSlice = current?.slices.at(-1);
    const prev = prevSlice?.hunks.at(-1);
    if (
      current &&
      prev &&
      prevSlice &&
      shouldSplit(
        prevSlice.file,
        prev,
        file,
        hunk,
        current.lines + size,
        config,
      )
    ) {
      flush();
    }
    if (!current) current = { slices: [], lines: 0 };
    const tail = current.slices.at(-1);
    if (!tail || tail.file !== file) {
      current.slices.push({ file, status, hunks: [hunk] });
    } else {
      tail.hunks.push(hunk);
    }
    current.lines += size;
  }
  flush();
  return chapters;
}

// rule 5: sha256 over ALL file slices (first hunk's old/new ranges each),
// first 12 hex (spec §8.5)
export function chapterId(slices: { file: string; hunks: Hunk[] }[]): string {
  const key = slices
    .map(
      (s) =>
        `${s.file}:${s.hunks[0].oldStart},${s.hunks[0].oldLines}->${s.hunks[0].newStart},${s.hunks[0].newLines}`,
    )
    .join("|");
  return createHash("sha256").update(key).digest("hex").slice(0, 12);
}
