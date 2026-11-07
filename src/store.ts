// Session persistence (spec §9): atomic writes, header-cached listing,
// creation pipeline, conflict-checked patch. Comments (spec §12) are created
// and mutated here too — with server-side anchor capture.
import fs from "node:fs";
import path from "node:path";
import { ApiError, validateRef } from "./cli.ts";
import { buildDiff, diffDigest, parseUnifiedDiff } from "./diff.ts";
import { chunk, loadConfig } from "./chunker.ts";
import { withAttention } from "./classify.ts";
import { applyCustomClassifier, loadClassifyRules } from "./custom-classifier.ts";
import { resolveStableId } from "./refs.ts";
import { getIdentity } from "./identity.ts";
import { captureAnchor, captureAnchorFromHunks } from "./anchors.ts";
// re-exported for remap.ts (refresh flows persist through the same path)
export { writeSession as persistSession };
import { readFileAt } from "./tree.ts";
import type { Anchor, Chapter, Comment, Hunk, Session } from "./types.ts";

// traversal-safe session ids (spec §9.2): `..` is a substring by design
export const VALID_SESSION_ID =
  /^[0-9a-zA-Z][0-9a-zA-Z+-]*\.\.[0-9a-zA-Z][0-9a-zA-Z+-]*$/;

export function sessionId(id: string): string {
  if (!VALID_SESSION_ID.test(id)) throw new ApiError(400, `invalid session id`);
  return id;
}

const dir = (root: string) => path.join(root, ".sky-watch");
const fileFor = (root: string, id: string) => path.join(dir(root), `${id}.json`);

function readSession(root: string, id: string): Session | undefined {
  try {
    return JSON.parse(fs.readFileSync(fileFor(root, id), "utf8")) as Session;
  } catch {
    return undefined;
  }
}

export function loadSession(root: string, id: string): Session {
  const s = readSession(root, sessionId(id));
  if (!s) throw new ApiError(404, `unknown session: ${id}`);
  // pre-multi-file sessions (task 009 decision) are stale cache, not loadable
  if (s.chapters?.some((c) => !Array.isArray((c as Chapter).files)))
    throw new ApiError(404, `stale session schema, create a new review: ${id}`);
  return s;
}

export function writeSession(root: string, session: Session): Session {
  fs.mkdirSync(dir(root), { recursive: true });
  const now = Date.now();
  session.updatedAt = now;
  session.lastWriteAt = now;
  const file = fileFor(root, session.id);
  fs.writeFileSync(file + ".tmp", JSON.stringify(session, null, 2));
  fs.renameSync(file + ".tmp", file);
  return session;
}

// header cache by mtime so /api/sessions doesn't reparse everything (spec §9.2)
const headerCache = new Map<string, { mtime: number; header: SessionListEntry }>();

export interface SessionListEntry {
  id: string;
  aliases: string[];
  label?: string;
  updatedAt: number;
  openComments: number;
  reviewed: boolean;
}

function headerOf(root: string, file: string): SessionListEntry | null {
  const id = path.basename(file).replace(/\.json$/, "");
  if (!VALID_SESSION_ID.test(id)) return null;
  try {
    const mtime = fs.statSync(file).mtimeMs;
    const cached = headerCache.get(file);
    if (cached && cached.mtime === mtime) return cached.header;
    const session = JSON.parse(fs.readFileSync(file, "utf8")) as Session;
    // pre-multi-file sessions (task 009 decision) are stale cache — don't list
    if (session.chapters?.some((c) => !Array.isArray((c as Chapter).files)))
      return null;
    const header: SessionListEntry = {
      id,
      aliases: session.aliases ?? [],
      label: session.label,
      updatedAt: session.updatedAt,
      openComments: (session.comments ?? []).filter((c) => !c.resolved).length,
      reviewed: session.reviewed,
    };
    headerCache.set(file, { mtime, header });
    return header;
  } catch {
    return null;
  }
}

export function listSessions(root: string): SessionListEntry[] {
  let files: string[] = [];
  try {
    files = fs
      .readdirSync(dir(root))
      .filter((f) => f.endsWith(".json"))
      .map((f) => path.join(dir(root), f));
  } catch {
    return []; // no .sky-watch yet
  }
  return files
    .map((f) => headerOf(root, f))
    .filter((h): h is SessionListEntry => h !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

// The one rebuild pipeline (plan 008): chunk → rules marks → custom
// classifier merge — so creation, jj refresh and git supersede behave
// identically. Reads its own config to avoid threading it through.
export async function chaptersFromDiff(
  root: string,
  diffText: string,
  ids: { base: string; head: string },
): Promise<Chapter[]> {
  const rules = loadClassifyRules(root);
  const chapters = chunk(parseUnifiedDiff(diffText), loadConfig(root)).map((c) =>
    withAttention(c, rules),
  );
  await applyCustomClassifier(root, ids.base, ids.head, chapters);
  return chapters;
}

export async function createSession(
  root: string,
  kind: "git" | "jj",
  base: string,
  head: string,
  baseLabel?: string,
  headLabel?: string,
): Promise<{ session: Session; created: boolean }> {
  validateRef(base);
  validateRef(head);
  const baseId = await resolveStableId(root, kind, base);
  const headId = await resolveStableId(root, kind, head);
  const id = `${baseId}..${headId}`;
  if (!VALID_SESSION_ID.test(id))
    throw new ApiError(400, `cannot form a session id from ${base}..${head}`);

  const existing = readSession(root, id);
  // pre-multi-file sessions (task 009 decision) count as absent — rebuild
  if (existing && Array.isArray(existing.chapters) && existing.chapters.every((c) => Array.isArray((c as Chapter).files)))
    return { session: existing, created: false }; // 200, no duplicate (U§1.5)

  const diffText = await buildDiff(root, kind, baseId, headId);
  const now = Date.now();
  const session: Session = {
    id,
    base: baseId,
    head: headId,
    baseRef: baseLabel,
    headRef: headLabel,
    diffDigest: diffDigest(diffText),
    aliases: [baseLabel, headLabel].filter((l): l is string => !!l),
    createdAt: now,
    updatedAt: now,
    lastWriteAt: now,
    meta: { repo: root },
    reviewed: false,
    chapters: await chaptersFromDiff(root, diffText, { base: baseId, head: headId }),
    comments: [],
  };
  return { session: writeSession(root, session), created: true };
}

// conflict check on every mutation (spec §9.4): mismatch → 409 with current
function checkConflict(session: Session, body: Record<string, unknown>): void {
  if (
    typeof body.lastWriteAt === "number" &&
    body.lastWriteAt !== session.lastWriteAt
  ) {
    throw new ApiError(409, "session changed elsewhere", session);
  }
}

export function patchSession(
  root: string,
  id: string,
  body: Record<string, unknown>,
): Session {
  const session = loadSession(root, id);
  checkConflict(session, body);
  if (typeof body.label === "string") session.label = body.label;
  if (typeof body.reviewed === "boolean") session.reviewed = body.reviewed;
  if (body.narrative) {
    const n = body.narrative as { chapterId?: string; text?: string };
    const chapter = session.chapters.find((c) => c.id === n.chapterId);
    if (!chapter) throw new ApiError(404, `unknown chapter: ${n.chapterId}`);
    chapter.narrative = n.text ?? "";
    chapter.narrativeEdited = true;
  }
  return writeSession(root, session);
}

// ---- comments (spec §12) ---------------------------------------------

const PRIORITIES = ["nit", "must-fix"] as const;

function validateCommentTarget(
  session: Session,
  t: { chapterId?: unknown; file?: unknown; side?: unknown; line?: unknown },
): {
  chapterId: string;
  chapter: Session["chapters"][number];
  file: string;
  side: "old" | "new";
  line: number;
} {
  const chapter = session.chapters.find((c) => c.id === t.chapterId);
  if (!chapter) throw new ApiError(404, `unknown chapter: ${t.chapterId}`);
  if (
    typeof t.file !== "string" ||
    !chapter.files.some((s) => s.file === t.file)
  )
    throw new ApiError(400, `file does not match chapter`);
  if (t.side !== "old" && t.side !== "new")
    throw new ApiError(400, `side must be "old" or "new"`);
  if (typeof t.line !== "number" || !Number.isInteger(t.line) || t.line < 1)
    throw new ApiError(400, `line must be a positive integer`);
  return { chapterId: chapter.id, chapter, file: t.file, side: t.side, line: t.line };
}

// fresh server-side anchor (spec §12): read the file from the VCS object
// store at head (new side) / base (old side); chapter hunks are the fallback
async function freshAnchor(
  root: string,
  kind: "git" | "jj",
  session: Session,
  t: { chapterId: string; file: string; side: "old" | "new"; line: number },
): Promise<Anchor> {
  const ref = t.side === "old" ? session.base : session.head;
  try {
    const { content, binary } = await readFileAt(root, kind, ref, t.file);
    if (!binary) {
      // drop the artifact segment after a final newline — it isn't a line
      const lines = content.replace(/\n$/, "").split("\n");
      return captureAnchor(lines, t.file, t.side, t.line, t.chapterId);
    }
  } catch {
    // fall through to hunks
  }
  const chapter = session.chapters.find((c) => c.id === t.chapterId);
  return captureAnchorFromHunks(
    chapter?.files.find((s) => s.file === t.file)?.hunks ?? ([] as Hunk[]),
    t.file, t.side, t.line, t.chapterId,
  );
}

export async function createComment(
  root: string,
  kind: "git" | "jj",
  id: string,
  body: Record<string, unknown>,
): Promise<Comment> {
  const session = loadSession(root, id);
  checkConflict(session, body);
  const t = validateCommentTarget(session, body);
  if (typeof body.text !== "string" || !body.text.trim())
    throw new ApiError(400, `text is required`);
  if (body.priority !== undefined && !PRIORITIES.includes(body.priority as never))
    throw new ApiError(400, `priority must be "nit" or "must-fix"`);
  const now = Date.now();
  const comment: Comment = {
    id: crypto.randomUUID().slice(0, 8),
    chapterId: t.chapterId,
    file: t.file,
    side: t.side,
    line: t.line,
    text: body.text,
    createdAt: now,
    updatedAt: now,
    author: await getIdentity(root, kind),
    resolved: false,
    anchor: await freshAnchor(root, kind, session, t),
    ...(body.priority !== undefined ? { priority: body.priority as Comment["priority"] } : {}),
  };
  session.comments.push(comment);
  writeSession(root, session);
  return comment;
}

export async function patchComment(
  root: string,
  kind: "git" | "jj",
  id: string,
  commentId: string,
  body: Record<string, unknown>,
): Promise<Comment> {
  const session = loadSession(root, id);
  checkConflict(session, body);
  const comment = session.comments.find((c) => c.id === commentId);
  if (!comment) throw new ApiError(404, `unknown comment: ${commentId}`);
  // reanchor (re-pin / orphan recovery, spec §12): fresh anchor, clear orphan
  if (body.reanchor) {
    const r = body.reanchor as Record<string, unknown>;
    const t = validateCommentTarget(session, { ...r, chapterId: r.chapterId ?? comment.chapterId, file: r.file ?? comment.file });
    comment.chapterId = t.chapterId;
    comment.file = t.file;
    comment.side = t.side;
    comment.line = t.line;
    comment.anchor = await freshAnchor(root, kind, session, t);
    delete comment.orphaned;
  }
  if (body.text !== undefined) {
    if (typeof body.text !== "string" || !body.text.trim())
      throw new ApiError(400, `text must be a non-empty string`);
    comment.text = body.text;
  }
  if (body.resolved === true) {
    comment.resolved = true;
    comment.resolvedAt = Date.now();
  } else if (body.resolved === false) {
    comment.resolved = false;
    delete comment.resolvedAt;
  }
  if (body.priority !== undefined) {
    if (body.priority === null) delete comment.priority;
    else if (PRIORITIES.includes(body.priority as never)) comment.priority = body.priority as Comment["priority"];
    else throw new ApiError(400, `priority must be "nit" or "must-fix"`);
  }
  // edits preserve the existing anchor (spec §12); only updatedAt moves
  comment.updatedAt = Date.now();
  writeSession(root, session);
  return comment;
}
