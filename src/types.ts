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

// classifier pass (spec §16.5) — .sky-watch/config.json → `classifier`.
// Two backends: the exec hook (`command`) and built-in backends (`builtin`,
// first: OpenRouter's decision-model API — model e.g. typesafe/jev-1.14). `command` wins when both set.
export interface ClassifierConfig {
  command?: string; // exec hook — JSON in/out on stdin/stdout
  builtin?: "openrouter"; // OpenRouter decision-model API (/api/alpha/decisions)
  model?: string; // required for jev (e.g. "typesafe/jev-1.14")
  apiKey?: string; // falls back to OPENROUTER_API_KEY env, then llm defaults
  baseUrl?: string; // default: https://openrouter.ai/api
  instructions?: string; // per-line question instruction override
  criteria?: Record<string, string>; // mark NAME → criteria description; default: rules buckets
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
// custom exec adapter; otherwise `provider` picks openai (default),
// anthropic (raw Messages API), or claude (@anthropic-ai/sdk —
// subscription/OAuth auth supported). A task without model/command resolves
// to undefined = skipped.
export interface LlmTaskConfig {
  provider?: "openai" | "anthropic" | "claude";
  apiKey?: string;
  authToken?: string; // claude adapter: OAuth token (subscriptions); falls back to ANTHROPIC_AUTH_TOKEN / CLAUDE_CODE_OAUTH_TOKEN
  model?: string;
  baseUrl?: string;
  command?: string; // custom adapter: JSON on stdin, { text } on stdout
  timeoutMs?: number; // default 120_000 (narration can be slow on local models)
}

export interface LlmConfig {
  defaults?: LlmTaskConfig;
  tasks?: { narrate?: LlmTaskConfig; classify?: LlmTaskConfig; chunk?: LlmTaskConfig };
}

// one LLM call; adapters return the assistant text (parsing is the caller's
// job — narrate.ts knows the response shapes)
export interface LlmRequest {
  task: "narrate" | "classify" | "chunk";
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
  title?: string; // one-line semantic description from the chunk task (§8a)
  attention: LineMark[];
  viewedFiles?: string[]; // slice paths marked viewed (spec §9.3); absent = nothing viewed
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
