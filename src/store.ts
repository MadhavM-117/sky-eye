// Session persistence (spec §9): atomic writes, header-cached listing,
// creation pipeline, conflict-checked patch.
import fs from "node:fs";
import path from "node:path";
import { ApiError, validateRef } from "./cli.ts";
import { buildDiff, diffDigest, parseUnifiedDiff } from "./diff.ts";
import { chunk, loadConfig } from "./chunker.ts";
import { resolveStableId } from "./refs.ts";
import type { Session } from "./types.ts";

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
  return s;
}

function writeSession(root: string, session: Session): Session {
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
  if (existing) return { session: existing, created: false }; // 200, no duplicate (U§1.5)

  const diffText = await buildDiff(root, kind, baseId, headId);
  const config = loadConfig(root);
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
    chapters: chunk(parseUnifiedDiff(diffText), config),
    comments: [],
  };
  return { session: writeSession(root, session), created: true };
}

// conflict check on every mutation (spec §9.4): mismatch → 409 with current
export function patchSession(
  root: string,
  id: string,
  body: Record<string, unknown>,
): Session {
  const session = loadSession(root, id);
  if (
    typeof body.lastWriteAt === "number" &&
    body.lastWriteAt !== session.lastWriteAt
  ) {
    throw new ApiError(409, "session changed elsewhere", session);
  }
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
