// Eager analysis (spec §16.2/§16.7): the final step of every chapter-
// building pipeline (creation, jj refresh, git supersede, rechunk) — the
// served session is fully analysed. Fills narratives for chapters without
// one (never overwrites — fresh chapters have narrativeEdited unset by
// definition), then orders chapters for reading. Degrade rule (§16.1): no
// adapter or a failed call leaves the chapter "unanalyzed" / path-ordered;
// the session never blocks on the LLM layer.
//
// Own module because narrate.ts already imports store.ts (persistSession):
// store → narrate would be a circular import.
import { resolveTask } from "./llm.ts";
import { narrateChapter, orderChapters, type Adapters } from "./narrate.ts";
import { persistSession } from "./store.ts";
import type { LlmAdapter, Session } from "./types.ts";

export interface AnalyzeAdapters extends Adapters {
  // chunk task configured → semantic grouping's order already is the
  // reading order; the §16.7 ordering pass is skipped
  chunk?: LlmAdapter;
}

// injectable adapters for tests; resolved from config when absent
export async function ensureAnalyzed(
  root: string,
  kind: "git" | "jj",
  session: Session,
  adapters?: AnalyzeAdapters,
): Promise<Session> {
  const a = adapters ?? {
    narrate: resolveTask(root, "narrate"),
    classify: resolveTask(root, "classify"),
    chunk: resolveTask(root, "chunk"),
  };
  if (a.narrate || a.classify) {
    for (const chapter of session.chapters)
      if (!chapter.narrative || chapter.narrative === "unanalyzed")
        await narrateChapter(a, root, kind, session, chapter);
    // §16.7: ordering only when an LLM is configured and the chunk task
    // isn't (its grouping order wins)
    if (!a.chunk) await orderChapters(session, a);
  }
  return persistSession(root, session);
}
