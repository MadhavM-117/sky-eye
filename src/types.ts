// Single schema source (process.md foundations): every shared type lives here.
export type DiffLineType = "ctx" | "add" | "del";

export interface DiffLine {
  type: DiffLineType;
  oldLine?: number;
  newLine?: number;
  text: string;
}

export interface Hunk {
  header?: string;
  oldStart: number;
  newStart: number;
  oldLines: number;
  newLines: number;
  lines: DiffLine[];
}

export interface FileDiff {
  path: string;
  oldPath: string;
  status: "modified" | "added" | "deleted";
  hunks: Hunk[];
  binary: boolean;
}

export type LineMark = {
  side: "old" | "new";
  line: number;
  mark: "focus" | "glance" | "safe";
  markSource: "rules" | "llm";
};

export interface Anchor {
  file: string;
  side: "old" | "new";
  line: number;
  text: string;
  before: string[];
  after: string[];
  chapterId: string;
}

export interface Comment {
  id: string;
  chapterId: string;
  file: string;
  side: "old" | "new";
  line: number;
  text: string;
  createdAt: number;
  updatedAt: number;
  author: { name: string; email: string } | null;
  resolved: boolean;
  resolvedAt?: number;
  priority?: "nit" | "must-fix";
  orphaned?: boolean;
  anchor: Anchor;
}

export interface Chapter {
  id: string;
  file: string;
  status: "modified" | "added" | "deleted";
  hunks: Hunk[];
  narrative: string;
  narrativeEdited?: boolean;
  attention: LineMark[];
}

export interface Session {
  id: string;
  base: string;
  head: string;
  baseRef?: string;
  headRef?: string;
  diffDigest: string;
  aliases: string[];
  createdAt: number;
  updatedAt: number;
  lastWriteAt: number;
  meta: { repo: string; exportedBy?: string };
  label?: string;
  reviewed: boolean;
  chapters: Chapter[];
  comments: Comment[];
  supersededBy?: string;
}

export interface Refs {
  root: string;
  kind: "git" | "jj";
  head: { id: string; label: string | null };
  defaultBase: { id: string; label: string } | null;
  branches: { id: string; name: string }[];
  commits: { id: string; subject: string }[];
}

export interface ReviewConfig {
  targetLines: number;
  maxLines: number;
}
