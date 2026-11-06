// Refresh, remap, supersede (spec §13). Comments survive rebases via content
// anchors: staleness is detected on GET (never auto-refreshed), refresh
// rebuilds the diff — in place for jj (change ids survive), via a successor
// session for git (commit ids break) — and the remap pass re-anchors
// comments onto the rebuilt chapters.
import { run, tryRun, validateRef, ApiError } from "./cli.ts";
import { buildDiff, diffDigest, parseUnifiedDiff } from "./diff.ts";
import { chunk, loadConfig } from "./chunker.ts";
import { captureAnchor } from "./anchors.ts";
import { readFileAt } from "./tree.ts";
import { persistSession } from "./store.ts";
import type { Anchor, Chapter, Comment, Session } from "./types.ts";

// ---- staleness detection (spec §13.1) ---------------------------------

export async function checkStale(
  root: string,
  kind: "git" | "jj",
  session: Session,
): Promise<boolean> {
  try {
    if (kind === "jj") {
      // change ids survive working-copy edits and rebases: same key, compare digests
      const text = await buildDiff(root, kind, session.base, session.head);
      return diffDigest(text) !== session.diffDigest;
    }
    if (!session.headRef) return false; // unknown branch movement
    // commit ids are immutable: the branch moving is the only signal
    let id = await tryRun(
      "git",
      ["rev-parse", "--verify", `${validateRef(session.headRef)}^{commit}`],
      root,
    );
    id ??= await tryRun("git", ["rev-parse", "--verify", "HEAD"], root);
    return id !== null && id.trim() !== session.head;
  } catch {
    return false; // can't compare → don't claim stale
  }
}

// ---- remap pass (spec §13.3) ------------------------------------------

// weighted, ordered context match (spec §13.3.3): a matching context line
// scores by its distance (1 → 3 points, 3 → 1 point)
function contextScore(anchor: Anchor, lines: string[], i: number): number {
  let score = 0;
  anchor.before.forEach((text, j) => {
    const dist = anchor.before.length - j; // 1 = the line just above
    if (lines[i - dist] === text) score += 4 - dist;
  });
  anchor.after.forEach((text, j) => {
    if (lines[i + j + 1] === text) score += 4 - (j + 1);
  });
  return score;
}

// rebuilt chapter whose hunks render this new-side line (spec §13.3.4)
function chapterForLine(
  chapters: Chapter[],
  file: string,
  line: number,
): Chapter | undefined {
  return chapters.find(
    (c) =>
      c.file === file &&
      c.hunks.some(
        (h) => line >= h.newStart && line < h.newStart + h.newLines,
      ),
  );
}

// Re-anchor one comment against the rebuilt diff (spec §13.3). Pure,
// fixture-tested; mutates `comment` in place. `newLines` is the file at the
// new head (null when the file is gone or binary). Returns the outcome.
export function remapComment(
  comment: Comment,
  newLines: string[] | null,
  chapters: Chapter[],
): "repinned" | "orphaned" {
  // old side is history (D§6 cut): orphaned, never moved
  if (comment.side === "old" || !newLines) {
    comment.orphaned = true;
    return "orphaned";
  }
  const candidates: number[] = [];
  for (let i = 0; i < newLines.length; i++)
    if (newLines[i] === comment.anchor.text) candidates.push(i);
  if (candidates.length === 0) {
    comment.orphaned = true; // keep the anchor; surfaces in triage
    return "orphaned";
  }
  // best context score wins; ties → nearest to the old line (§13.3.3)
  let best = candidates[0];
  let bestScore = -1;
  for (const i of candidates) {
    const dist = Math.abs(i + 1 - comment.anchor.line);
    const s = contextScore(comment.anchor, newLines, i);
    if (s > bestScore || (s === bestScore && dist < Math.abs(best + 1 - comment.anchor.line))) {
      best = i;
      bestScore = s;
    }
  }
  const chapter = chapterForLine(chapters, comment.anchor.file, best + 1);
  if (!chapter) {
    // matched, but the line no longer sits inside any rendered hunk —
    // hiding it there would strand it outside the diff (spec §13.3.5)
    comment.orphaned = true;
    return "orphaned";
  }
  comment.line = best + 1;
  comment.chapterId = chapter.id;
  comment.file = comment.anchor.file;
  comment.side = "new";
  comment.anchor = captureAnchor(newLines, comment.file, "new", comment.line, chapter.id);
  delete comment.orphaned;
  return "repinned";
}

// file content at the new head from the VCS object store (spec §13.3.1);
// per-file cache — many comments usually share a file
async function fileLinesAt(
  root: string,
  kind: "git" | "jj",
  session: Session,
  file: string,
): Promise<string[] | null> {
  try {
    const { content, binary } = await readFileAt(root, kind, session.head, file);
    if (!binary) return content.replace(/\n$/, "").split("\n");
  } catch {
    // file no longer exists at the new head
  }
  return null;
}

export async function remapComments(
  root: string,
  kind: "git" | "jj",
  session: Session,
): Promise<void> {
  const files = new Map<string, string[] | null>();
  for (const comment of session.comments) {
    if (!files.has(comment.anchor.file))
      files.set(comment.anchor.file, await fileLinesAt(root, kind, session, comment.anchor.file));
    remapComment(comment, files.get(comment.anchor.file)!, session.chapters);
  }
}

// ---- the two refresh flows (spec §13.2) --------------------------------

export interface RefreshResult {
  session: Session;
  supersededBy?: string;
}

// narratives ride chapter ids (D§11 accepted: ids break when hunk ranges shift)
function carryNarratives(chapters: Chapter[], old: Map<string, Chapter>): Chapter[] {
  for (const c of chapters) {
    const prev = old.get(c.id);
    if (prev) {
      c.narrative = prev.narrative;
      if (prev.narrativeEdited) c.narrativeEdited = true;
    }
  }
  return chapters;
}

async function gitHeadNow(root: string, session: Session): Promise<string | null> {
  let id = await tryRun(
    "git",
    ["rev-parse", "--verify", `${validateRef(session.headRef!)}^{commit}`],
    root,
  );
  id ??= await tryRun("git", ["rev-parse", "--verify", "HEAD"], root);
  return id?.trim() ?? null;
}

export async function refreshSession(
  root: string,
  kind: "git" | "jj",
  session: Session,
): Promise<RefreshResult> {
  if (kind === "jj") {
    // key survives the rebase: same session file, new diff (spec §13.2)
    const diffText = await buildDiff(root, kind, session.base, session.head);
    const oldChapters = new Map(session.chapters.map((c) => [c.id, c]));
    session.chapters = carryNarratives(
      chunk(parseUnifiedDiff(diffText), loadConfig(root)),
      oldChapters,
    );
    session.diffDigest = diffDigest(diffText);
    await remapComments(root, kind, session);
    return { session: persistSession(root, session) };
  }
  if (!session.headRef) throw new ApiError(400, "cannot refresh without a headRef");
  const newHead = await gitHeadNow(root, session);
  if (!newHead || newHead === session.head) return { session }; // nothing moved
  // key breaks: successor session, old one kept as history (spec §13.2)
  const successor = await createSuccessor(root, kind, session, newHead);
  session.supersededBy = successor.id;
  persistSession(root, session);
  return { session: successor, supersededBy: successor.id };
}

async function createSuccessor(
  root: string,
  kind: "git" | "jj",
  session: Session,
  newHead: string,
): Promise<Session> {
  const diffText = await buildDiff(root, kind, session.base, newHead);
  const now = Date.now();
  const successor: Session = {
    id: `${session.base}..${newHead}`,
    base: session.base,
    head: newHead,
    baseRef: session.baseRef,
    headRef: session.headRef,
    diffDigest: diffDigest(diffText),
    aliases: session.aliases,
    createdAt: now,
    updatedAt: now,
    lastWriteAt: now,
    meta: { repo: root },
    label: session.label,
    reviewed: session.reviewed,
    chapters: [],
    comments: structuredClone(session.comments),
  };
  const oldChapters = new Map(session.chapters.map((c) => [c.id, c]));
  successor.chapters = carryNarratives(
    chunk(parseUnifiedDiff(diffText), loadConfig(root)),
    oldChapters,
  );
  await remapComments(root, kind, successor);
  return persistSession(root, successor);
}
