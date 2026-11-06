// Minimal declarations for the plain-JS frontend adapter (public/ is vanilla
// ES modules per spec §18; these types exist so TS tests can import it).
import type { Chapter, FileDiff } from "../types.ts";

// `file` is {path, status}; app.js passes {path: chapter.file, status: chapter.status}.
type DiffFile = Pick<FileDiff, "path" | "status">;

// Structural slice of pierre's FileDiffMetadata (full type lives in
// @pierre/diffs; the adapter stays loosely typed, fixtures assert these).
type PierreFileDiffMetadata = {
  name: string;
  type: "change" | "rename-pure" | "rename-changed" | "new" | "deleted";
  isPartial: boolean;
  additionLines: string[];
  deletionLines: string[];
  splitLineCount: number;
  unifiedLineCount: number;
  hunks: Record<string, unknown>[];
};

export declare function patchText(file: DiffFile, hunks: Chapter["hunks"]): string;
export declare function fileDiffMetadata(
  file: DiffFile,
  hunks: Chapter["hunks"],
): PierreFileDiffMetadata | null;
export declare function createFileDiff(
  file: DiffFile,
  hunks: Chapter["hunks"],
  opts?: { onSelectionChange?: (range: unknown) => void },
): { el: HTMLElement; fileDiff: unknown; dispose: () => void } | null;
export declare function createFileView(
  path: string,
  contents: string,
): { el: HTMLElement; dispose: () => void };
export declare function createFileTree(opts: {
  paths: string[];
  changed?: Pick<Chapter, "file" | "status">[];
  onOpen?: (path: string) => void;
}): {
  el: HTMLElement;
  tree: { scrollToPath: (p: string, o?: unknown) => void };
  dispose: () => void;
};
export declare function selectionSide(
  range: { start: number; end: number; side?: "deletions" | "additions" } | null,
): "old" | "new";
