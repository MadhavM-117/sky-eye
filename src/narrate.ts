// Narrative generation + LLM mark refinement (spec §16.2, §16.3, D§6a).
// Prompt building is pure; `rerunChapter` is the one orchestration point
// behind POST /api/sessions/:id/rerun — lazy first generation and re-run
// share it. Degradation rule (§16.1/§16.3): no adapter or a failed/malformed
// call never blocks the session — rules marks stay, narrative stays as-is.
import { ApiError } from "./cli.ts";
import { classifyChapter } from "./classify.ts";
import { resolveTask } from "./llm.ts";
import { applyClassifier, loadClassifyRules } from "./custom-classifier.ts";
import { persistSession } from "./store.ts";
import { readFileAt } from "./tree.ts";
import { MARK_NAME } from "./types.ts";
import type { Chapter, LlmAdapter, LlmRequest, LineMark, Session } from "./types.ts";

const CONTEXT_LINES = 10; // new-side context around each hunk (§16.2)

export interface RawMark {
  file: string;
  side: "old" | "new";
  line: number;
  mark: string;
}

// ---- prompt building (pure) ----------------------------------------------

// The chapter's diff across all file slices (006 model), ~10 lines of
// new-side context per hunk from the head file content (missing content —
// deleted files — just omits the context band).
export function chapterDiffText(
  chapter: Chapter,
  headContents: Map<string, string>,
): string {
  const parts: string[] = [];
  for (const slice of chapter.files) {
    const fileLines = headContents.get(slice.file)?.split("\n") ?? [];
    const blocks = slice.hunks
      .map((h) => {
        const header = h.header ?? `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`;
        const above = fileLines
          .slice(Math.max(0, h.newStart - 1 - CONTEXT_LINES), h.newStart - 1)
          .map((t) => ` ${t}`);
        const below = fileLines
          .slice(h.newStart - 1 + h.newLines, h.newStart - 1 + h.newLines + CONTEXT_LINES)
          .map((t) => ` ${t}`);
        return [header, ...above, ...h.lines.map((l) => (l.type === "add" ? "+" : l.type === "del" ? "-" : " ") + l.text), ...below].join("\n");
      })
      .join("\n");
    parts.push(`${slice.file} (${slice.status})\n${blocks}`);
  }
  return parts.join("\n");
}

export function narrateSystemPrompt(): string {
  return (
    "You summarize one chapter of a code review diff. Write a single short " +
    "paragraph (2-4 sentences) describing what the change does. Describe, " +
    "don't judge. Other chapters of the same review are listed so you can " +
    "refer to them by topic instead of repeating them. Reply with the " +
    "paragraph only."
  );
}

export function narrateUserPrompt(chapter: Chapter, otherTitles: string[], diffText: string): string {
  return (
    `Files in this chapter:\n${chapter.files.map((f) => `- ${f.file}`).join("\n")}\n\n` +
    `Other chapters in this review cover:\n${otherTitles.map((t) => `- ${t}`).join("\n") || "- (none)"}\n\n` +
    `Diff:\n${diffText}\n\nSummarize this chapter in one short paragraph.`
  );
}

// shared call (§16.3): JSON out { narrative, marks } — marks entries carry
// `file` because chapters span files (multi-file model, §8)
export function sharedSystemPrompt(): string {
  return (
    "You summarize one chapter of a code review diff and re-check its " +
    "per-line attention classification. Write a short paragraph (2-4 " +
    "sentences) describing what the change does — describe, don't judge. " +
    'Reply with ONLY a JSON object: {"narrative": "...", "marks": [{"file": ' +
    '"path", "side": "old"|"new", "line": <number>, "mark": "focus"|"glance"|' +
    '"safe"}]}. `line` must be a changed line of the diff (the + or - lines). ' +
    "Return a mark only for lines whose current (rule-based) mark is wrong; " +
    "omit lines that are already right."
  );
}

export function classifySystemPrompt(): string {
  return (
    "You re-check the per-line attention classification of a code review " +
    'diff chapter. Reply with ONLY a JSON object: {"marks": [{"file": ' +
    '"path", "side": "old"|"new", "line": <number>, "mark": "focus"|"glance"|' +
    '"safe"}]}. `line` must be a changed line of the diff (the + or - lines). ' +
    "Return a mark only for lines whose current (rule-based) mark is wrong; " +
    "omit lines that are already right."
  );
}

// semantic title from the chunk task when present (§8a), else the file list
export const chapterTitle = (chapter: Chapter) =>
  chapter.title ?? `${chapter.files.map((f) => f.file).join(", ")}`;

// current rules/llm marks listed in the prompt so the model can correct
const currentMarksText = (chapter: Chapter) =>
  chapter.attention.map((m) => `- ${m.file}:${m.line} (${m.side}) ${m.mark}`).join("\n");

// ---- response parsing -----------------------------------------------------

export class NarrateError extends Error {}

// mode: "shared" needs a narrative + optional marks; "classify" needs marks
export function parseLlmResponse(
  raw: string,
  mode: "shared" | "classify",
): { narrative?: string; marks: RawMark[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new NarrateError("response is not valid JSON");
  }
  const obj = parsed as { narrative?: unknown; marks?: unknown };
  const narrative =
    mode === "shared" && typeof obj.narrative === "string" && obj.narrative.trim()
      ? obj.narrative.trim()
      : undefined;
  if (mode === "shared" && narrative === undefined) throw new NarrateError("no narrative");
  const marks: RawMark[] = [];
  if (Array.isArray(obj.marks))
    for (const m of obj.marks) {
      const e = m as Partial<RawMark>;
      if (
        typeof e?.file === "string" &&
        (e.side === "old" || e.side === "new") &&
        typeof e?.line === "number" &&
        typeof e?.mark === "string" &&
        MARK_NAME.test(e.mark)
      )
        marks.push({ file: e.file, side: e.side, line: e.line, mark: e.mark });
    }
  if (mode === "classify" && !Array.isArray(obj.marks)) throw new NarrateError("no marks array");
  return { narrative, marks };
}

// LLM marks overwrite only `markSource: "rules"` marks (custom marks are
// equally protected); entries for unknown coordinates are dropped
export function applyLlmMarks(chapter: Chapter, raw: RawMark[]): void {
  const byKey = new Map(raw.map((m) => [`${m.file}\u0000${m.side}:${m.line}`, m.mark]));
  chapter.attention = chapter.attention.map((m: LineMark) => {
    const mark = byKey.get(`${m.file}\u0000${m.side}:${m.line}`);
    return m.markSource === "rules" && mark ? { ...m, mark, markSource: "llm" as const } : m;
  });
}

// ---- orchestration ---------------------------------------------------------

export interface Adapters {
  narrate?: LlmAdapter;
  classify?: LlmAdapter;
}

// one LLM call → text, degrading to undefined on any failure (console gets
// a one-liner; the session never blocks)
async function call(adapter: LlmAdapter, req: LlmRequest): Promise<string | undefined> {
  try {
    return await adapter.call(req);
  } catch (e) {
    console.error(`sky-eye: llm ${req.task} failed: ${(e as Error).message}`);
    return undefined;
  }
}

export async function rerunChapter(
  root: string,
  kind: "git" | "jj",
  session: Session,
  chapterId: string,
  confirm: boolean,
  adapters?: Adapters, // injected in tests; resolved from config when absent
): Promise<Session> {
  const chapter = session.chapters.find((c) => c.id === chapterId);
  if (!chapter) throw new ApiError(404, `unknown chapter: ${chapterId}`);
  if ((chapter.narrativeEdited || chapter.marksEdited) && !confirm)
    throw new ApiError(409, "narrative or marks edited", { error: "narrative or marks edited", needsConfirm: true });

  const a = adapters ?? { narrate: resolveTask(root, "narrate"), classify: resolveTask(root, "classify") };
  if (!a.narrate && !a.classify) return session; // no config → rules-only world
  await narrateChapter(a, root, kind, session, chapter);
  return persistSession(root, session);
}

// rerun-all (task 018, spec §16.6): regenerate everything in place on the
// stored diff — rules marks + classifier pass + narrative/LLM marks for
// every chapter. The diff itself is NOT re-generated (refresh, §13, owns
// that); chapter ids can't move (same diff → same ids, §8.5). One confirm
// gate covers all edited narratives.
export async function rerunAll(
  root: string,
  kind: "git" | "jj",
  session: Session,
  confirm: boolean,
  adapters?: Adapters,
): Promise<Session> {
  if (session.chapters.some((c) => c.narrativeEdited || c.marksEdited) && !confirm)
    throw new ApiError(409, "narrative or marks edited", { error: "narrative or marks edited", needsConfirm: true });
  // rules pass first (machine-owned, config-free), then the custom
  // classifier (§16.5) — narrate's LLM marks only overwrite "rules" marks,
  // so custom marks survive the narrate loop (§9.3 semantics)
  const rules = loadClassifyRules(root);
  for (const c of session.chapters) c.attention = classifyChapter(c, rules);
  await applyClassifier(root, session.base, session.head, session.chapters);

  const a = adapters ?? { narrate: resolveTask(root, "narrate"), classify: resolveTask(root, "classify") };
  if (!a.narrate && !a.classify) return persistSession(root, session); // rules/classifier only
  for (const chapter of session.chapters) await narrateChapter(a, root, kind, session, chapter);
  return persistSession(root, session);
}

// Shared per-chapter narration core (extracted from rerunChapter): head-
// contents context, shared vs separate calls, mark merging. Mutates the
// chapter in place; persistence is the caller's job. Exported for
// analyze.ts's eager pass (§16.2) — rerun and eager analysis share it.
export async function narrateChapter(
  a: Adapters,
  root: string,
  kind: "git" | "jj",
  session: Session,
  chapter: Chapter,
): Promise<void> {
  const headContents = new Map<string, string>();
  for (const s of chapter.files) {
    if (s.status === "deleted") continue;
    try {
      const { content, binary } = await readFileAt(root, kind, session.head, s.file);
      if (!binary) headContents.set(s.file, content);
    } catch {
      /* deleted mid-flight or unreadable — context band is optional */
    }
  }
  const diffText = chapterDiffText(chapter, headContents);
  const otherTitles = session.chapters
    .filter((c) => c.id !== chapter.id)
    .map((c) => chapterTitle(c));
  const marksInPrompt = currentMarksText(chapter);

  if (a.narrate && a.classify && a.narrate.id === a.classify.id) {
    // shared call (§16.3): one request carries both jobs; malformed output
    // discards the whole LLM part — rules marks stay (degrade, don't fail)
    const text = await call(a.narrate, {
      task: "narrate",
      system: sharedSystemPrompt(),
      prompt:
        narrateUserPrompt(chapter, otherTitles, diffText) +
        `\n\nCurrent rule-based marks for this chapter:\n${marksInPrompt}`,
    });
    if (text === undefined) return;
    try {
      const { narrative, marks } = parseLlmResponse(text, "shared");
      if (narrative) chapter.narrative = narrative;
      applyLlmMarks(chapter, marks);
    } catch {
      console.error("sky-eye: llm shared response malformed — keeping rules marks");
    }
    return;
  }

  // different configs → two calls; each degrades independently
  if (a.narrate) {
    const text = await call(a.narrate, {
      task: "narrate",
      system: narrateSystemPrompt(),
      prompt: narrateUserPrompt(chapter, otherTitles, diffText),
    });
    if (text?.trim()) chapter.narrative = text.trim();
  }
  if (a.classify) {
    const text = await call(a.classify, {
      task: "classify",
      system: classifySystemPrompt(),
      prompt: `${narrateUserPrompt(chapter, otherTitles, diffText)}\n\nCurrent rule-based marks for this chapter:\n${marksInPrompt}`,
    });
    if (text !== undefined) {
      try {
        applyLlmMarks(chapter, parseLlmResponse(text, "classify").marks);
      } catch {
        console.error("sky-eye: llm classify response malformed — keeping rules marks");
      }
    }
  }
}

// ---- chapter ordering (§16.7) ----------------------------------------------

export function orderSystemPrompt(): string {
  return (
    "You order the chapters of a code review so a reviewer builds " +
    "understanding: foundations and data-model changes before their " +
    "consumers, related chapters adjacent. Reply with ONLY JSON: " +
    '{"order": ["<id>", ...]} — every id exactly once, in review-reading order.'
  );
}

// changed-line counts across all slices (rail summary + ordering prompt)
export function chapterCounts(chapter: Chapter): [add: number, del: number] {
  return chapter.files.reduce<[number, number]>(
    ([a, d], s) =>
      s.hunks.reduce(
        ([sa, sd], h) => [
          sa + h.lines.filter((l) => l.type === "add").length,
          sd + h.lines.filter((l) => l.type === "del").length,
        ],
        [a, d],
      ),
    [0, 0],
  );
}

// Pure validation (§16.7): the reply must be a permutation — unknown ids
// dropped, duplicates first-wins, chapters the model missed keep path order
// appended at the end; malformed reply → path order (degrade, don't fail).
export function parseOrderResponse(raw: string, chapters: Chapter[]): string[] {
  const pathOrder = chapters.map((c) => c.id);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return pathOrder;
  }
  const list = (parsed as { order?: unknown }).order;
  if (!Array.isArray(list)) return pathOrder;
  const known = new Set(pathOrder);
  const seen = new Set<string>();
  for (const id of list)
    if (typeof id === "string" && known.has(id) && !seen.has(id)) seen.add(id);
  return [...seen, ...pathOrder.filter((id) => !seen.has(id))];
}

// One cheap call over the chapter list — ids, titles, counts, statuses; no
// diff text (the narratives carry the semantics). Reorders session.chapters
// in place. No narrate adapter → classify; neither → no-op.
export async function orderChapters(session: Session, a: Adapters): Promise<void> {
  const adapter = a.narrate ?? a.classify;
  if (!adapter || session.chapters.length < 2) return;
  const line = (c: Chapter) => {
    const [add, del] = chapterCounts(c);
    const statuses = [...new Set(c.files.map((s) => s.status))].join("/");
    return `- id=${c.id} — ${chapterTitle(c)} (${c.files.length} file${c.files.length === 1 ? "" : "s"}, +${add} −${del}, ${statuses})`;
  };
  const text = await call(adapter, {
    task: "narrate",
    system: orderSystemPrompt(),
    prompt:
      "Chapters of one code review, in current (path) order:\n" +
      session.chapters.map(line).join("\n"),
  });
  if (text === undefined) return;
  const rank = new Map(parseOrderResponse(text, session.chapters).map((id, i) => [id, i]));
  session.chapters.sort((x, y) => (rank.get(x.id) ?? 0) - (rank.get(y.id) ?? 0));
}
