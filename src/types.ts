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

// canonical v1 vocabulary; custom classifiers (§16.5) may emit other names —
// the `(string & {})` keeps autocomplete while allowing them, the real
// validation boundary is the classifier protocol's mark regex (§16.5).
// Unknown names render as a neutral chip (frontend).
export type MarkName = "focus" | "glance" | "safe" | (string & {});

export type LineMark = {
  file: string; // multi-file chapters: marks are per file slice (spec §9.3)
  side: "old" | "new";
  line: number;
  mark: MarkName;
  markSource: "rules" | "llm" | "custom";
};

// custom classifier command (spec §16.5) — .sky-watch/config.json → `classifier`
export interface ClassifierConfig {
  command: string;
  timeoutMs?: number; // default 30_000
  fallback?: boolean; // default true: rules marks survive a failed run
  debug?: boolean; // full request/response into classifier.log
}

// config globs extending the built-in rule buckets (spec §16.4)
export interface ClassifyRules {
  safePaths?: string[];
  focusPaths?: string[];
}

// LLM task config (spec §16.1, §22.2): `defaults` in .sky-watch/config.json
// plus per-task overrides for narrate/classify. `command` switches to the
// custom exec adapter; otherwise `provider` picks openai (default) or
// anthropic. A task without model/command resolves to undefined = skipped.
export interface LlmTaskConfig {
  provider?: "openai" | "anthropic";
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  command?: string; // custom adapter: JSON on stdin, { text } on stdout
  timeoutMs?: number; // default 120_000 (narration can be slow on local models)
}

export interface LlmConfig {
  defaults?: LlmTaskConfig;
  tasks?: { narrate?: LlmTaskConfig; classify?: LlmTaskConfig };
}

// one LLM call; adapters return the assistant text (parsing is the caller's
// job — narrate.ts knows the response shapes)
export interface LlmRequest {
  task: "narrate" | "classify";
  model?: string;
  system: string;
  prompt: string;
}

export interface LlmAdapter {
  // identity for the shared-call check (§16.3): equal ids → one request
  id: string;
  call(req: LlmRequest): Promise<string>;
}

// one file's part of a chapter (spec §8: a chapter may span files, one
// contiguous slice per file, in path order)
export interface FileSlice {
  file: string;
  status: FileDiff["status"];
  hunks: Hunk[];
}

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
  files: FileSlice[];
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
