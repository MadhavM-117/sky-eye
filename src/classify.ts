// Rule pass for attention marks (spec §16.4): pure, no LLM needed. Runs at
// every chapter rebuild (session creation, refresh, supersede) — marks are
// machine-owned and always rebuilt, never migrated (spec §9.3).
import type { Chapter, ClassifyRules, FileSlice, LineMark } from "./types.ts";

type Mark = LineMark["mark"];

// One mark per changed line; precedence (documented in plan 007):
// path-safe > comment-only > focus (path or keyword) > glance. Config globs
// (spec §16.4 `classifyRules`) extend the built-in buckets — built-ins are
// tested first, config globs append (so a built-in safe/focus match wins).
function classifyLine(path: string, text: string, rules?: ClassifyRules): Mark {
  if (isSafePath(path, rules)) return "safe";
  const t = text.trim();
  if (isComment(t)) return "safe";
  if (isFocusPath(path, rules) || FOCUS_KEYWORDS.test(text)) return "focus";
  return "glance";
}

// safe paths: tests, lockfiles, docs, generated output
const SAFE_PATH =
  /(^|\/)(__tests__|dist)\/|(^|[/.\w-])(test|spec)[\w.-]*$|\.md$|\.min\.(js|css)$|(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|uv\.lock|poetry\.lock|go\.sum|composer\.lock)$/;

function isSafePath(path: string, rules?: ClassifyRules): boolean {
  return SAFE_PATH.test(path) || matchesGlobs(path, rules?.safePaths);
}

// focus paths: security / money / credential territory
const FOCUS_PATH = /(^|\/)auth\/|payment|token|secret/;

function isFocusPath(path: string, rules?: ClassifyRules): boolean {
  return FOCUS_PATH.test(path) || matchesGlobs(path, rules?.focusPaths);
}

// `*` is the only wildcard (`vendor/*`, `*.min.js`); everything else is
// escaped, and the pattern anchors against the full repo-relative path.
export function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function matchesGlobs(path: string, globs: string[] | undefined): boolean {
  return !!globs?.some((g) => globToRegExp(g).test(path));
}

// focus keywords: async-sensitive, error-flow, crypto/permission/SQL
const FOCUS_KEYWORDS =
  /\b(await|async|try|catch|throw|password|passwd|secret|encrypt|decrypt|crypto|cipher|salt|hash|permission|grant|revoke|select|insert|update|delete|drop)\b/i;

// comment-only line (trimmed): C-style, shell/yaml/py `#`, html
function isComment(t: string): boolean {
  return (
    t.startsWith("//") ||
    t.startsWith("#") ||
    t.startsWith("/*") ||
    t.startsWith("*") ||
    t.startsWith("<!--")
  );
}

// All changed lines of one file slice → LineMarks with the slice's file
// attached (multi-file chapters: marks are per slice, spec §9.3).
export function classifySlice(slice: FileSlice, rules?: ClassifyRules): LineMark[] {
  const marks: LineMark[] = [];
  for (const hunk of slice.hunks)
    for (const line of hunk.lines) {
      if (line.type === "ctx") continue;
      const side = line.type === "add" ? "new" : "old";
      const num = line.type === "add" ? line.newLine : line.oldLine;
      if (num === undefined) continue;
      marks.push({
        file: slice.file,
        side,
        line: num,
        mark: classifyLine(slice.file, line.text, rules),
        markSource: "rules",
      });
    }
  return marks;
}

export function classifyChapter(chapter: Chapter, rules?: ClassifyRules): LineMark[] {
  return chapter.files.flatMap((f) => classifySlice(f, rules));
}

// applied after every `chunk(...)` call so attention is filled wherever
// chapters are rebuilt (creation, refresh, supersede)
export function withAttention<C extends Chapter>(chapter: C, rules?: ClassifyRules): C {
  return { ...chapter, attention: classifyChapter(chapter, rules) };
}
