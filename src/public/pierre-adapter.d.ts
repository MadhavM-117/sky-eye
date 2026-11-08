// Minimal declarations for the plain-JS frontend adapter (public/ is vanilla
// ES modules per spec §18; these types exist so TS tests can import it).
import type { Chapter, Comment, FileDiff, LineMark } from "../types.ts";

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

// Full-file mode (task 023, spec §18): stored hunks padded into ONE hunk
// covering the whole file — gap lines are ctx from the head file content.
export declare function fullFileHunks(
  hunks: Chapter["hunks"],
  fileLines: string[],
): Chapter["hunks"];
export declare function fileDiffMetadata(
  file: DiffFile,
  hunks: Chapter["hunks"],
): PierreFileDiffMetadata | null;
export declare function createFileDiff(
  file: DiffFile,
  hunks: Chapter["hunks"],
  opts?: {
    onSelectionChange?: (range: unknown) => void;
    onSelectionEnd?: (range: { start: number; end: number; side?: string } | null) => void;
    onLineNumberClick?: (props: { lineNumber: number; annotationSide: string }) => void;
    onGutterUtilityClick?: (range: { start: number; side?: string }) => void;
    renderAnnotation?: (annotation: unknown) => HTMLElement;
    annotations?: unknown[];
    marks?: LineMark[];
  },
): { el: HTMLElement; fileDiff: unknown; dispose: () => void } | null;

export declare function updateAnnotations(
  diff: { el: HTMLElement; fileDiff: unknown },
  annotations: unknown[],
): void;

// Comment projection: comments grouped per (side, line) into side-aware
// annotation rows; an open composer joins its line as a marker entry.
// Attention marks do not ride this projection (gutter column, task 009).
export declare function commentAnnotations(
  comments: Comment[],
  composer?: { side: "old" | "new"; line: number } | null,
): {
  side: "deletions" | "additions";
  lineNumber: number;
  metadata: {
    comments: (Comment | { composer: true })[];
    composer: null;
  };
}[];

// Pure part of the marks gutter glyph (task 009): canonical mark names →
// glyph + color var; custom classifier names → neutral muted dot (§16.5).
export declare function markGlyphSpec(mark: LineMark): {
  cls: string;
  glyph: string;
  color: string;
  title: string;
};

// Deep-link targets inside pierre's shadow DOM.
export declare function queryRow(
  diff: { el: HTMLElement } | null | undefined,
  side: "old" | "new",
  line: number,
): Element | null;
export declare function queryComment(
  diff: { el: HTMLElement } | null | undefined,
  commentId: string,
): Element | null;
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
  range:
    | { start: number; end: number; side?: "deletions" | "additions" }
    | { annotationSide: "deletions" | "additions" }
    | null,
): "old" | "new";
