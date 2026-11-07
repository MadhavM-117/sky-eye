// Route table for the M1 milestone (spec §10). Later milestones append entries.
import path from "node:path";
import { route } from "./server.ts";
import { ApiError, validateRef } from "./cli.ts";
import { getRefs } from "./refs.ts";
import { listTree, listTreeRecursive, readFileAt } from "./tree.ts";
import {
  archiveSession,
  createComment,
  createSession,
  deleteSession,
  importSession,
  listSessions,
  loadSession,
  patchComment,
  patchSession,
  readSessionRaw,
  sessionId,
  unarchiveSession,
} from "./store.ts";
import { checkStale, refreshSession } from "./remap.ts";
import { rerunChapter } from "./narrate.ts";

route("GET", "/api/refs", async ({ root, kind }) => getRefs(root, kind));

route("GET", "/api/tree", async ({ root, kind, url }) => {
  const ref = validateRef(url.searchParams.get("ref") ?? "");
  // recursive=1: every file path at ref, flat (spec §11) — feeds the
  // explorer FileTree; default stays the single-directory listing
  if (url.searchParams.get("recursive") === "1")
    return listTreeRecursive(root, kind, ref);
  const dir = validateDir(url.searchParams.get("dir") ?? ".");
  return listTree(root, kind, ref, dir);
});

route("GET", "/api/file", async ({ root, kind, url }) => {
  const ref = validateRef(url.searchParams.get("ref") ?? "");
  const p = validateDir(url.searchParams.get("path") ?? "");
  return readFileAt(root, kind, ref, p);
});

route("GET", "/api/sessions", ({ root, url }) =>
  // ?archived=1 lists .sky-watch/archive/ instead (task 017, spec §10)
  listSessions(root, url.searchParams.get("archived") === "1"),
);

route("GET", "/api/sessions/:id", async ({ root, kind, params }) => {
  const session = loadSession(root, sessionId(params.id));
  // computed on read, never auto-refreshed (spec §13.1)
  return { ...session, stale: await checkStale(root, kind, session) };
});

route("POST", "/api/sessions", async ({ root, kind, body }) => {
  const b = body as {
    base?: string;
    head?: string;
    baseLabel?: string;
    headLabel?: string;
  };
  if (!b.base || !b.head)
    throw new ApiError(400, "base and head are required");
  const { session, created } = await createSession(
    root,
    kind,
    b.base,
    b.head,
    b.baseLabel,
    b.headLabel,
  );
  return { status: created ? 201 : 200, value: session };
});

// refresh (spec §13.2): in place for jj, successor session for git
route("POST", "/api/sessions/:id/refresh", async ({ root, kind, params }) =>
  refreshSession(root, kind, loadSession(root, sessionId(params.id))),
);

route("PATCH", "/api/sessions/:id", ({ root, params, body }) => {
  const id = sessionId(params.id);
  return patchSession(root, id, body as Record<string, unknown>);
});

// comments (spec §10, §12): server captures the anchor on create and reanchor
route("POST", "/api/comments", async ({ root, kind, body }) => {
  const b = body as Record<string, unknown>;
  const comment = await createComment(root, kind, sessionId(b.sessionId as string), b);
  return { status: 201, value: comment };
});

route("PATCH", "/api/comments/:id", ({ root, kind, params, body }) => {
  const b = body as Record<string, unknown>;
  return patchComment(root, kind, sessionId(b.sessionId as string), params.id, b);
});

// narrative + LLM marks for one chapter (§16.2): lazy first generation and
// re-run share the endpoint; 409 needsConfirm guards edited narratives (§10)
route("POST", "/api/sessions/:id/rerun", async ({ root, kind, params, body }) => {
  const b = body as { chapterId?: string; confirm?: boolean };
  if (!b.chapterId) throw new ApiError(400, "chapterId is required");
  return rerunChapter(root, kind, loadSession(root, sessionId(params.id)), b.chapterId, b.confirm === true);
});

// archive/delete (task 017, spec §10): archive moves the file into
// .sky-watch/archive/ (restore via unarchive), delete removes it permanently
route("POST", "/api/sessions/:id/archive", ({ root, params }) =>
  archiveSession(root, params.id));
route("POST", "/api/sessions/:id/unarchive", ({ root, params }) =>
  unarchiveSession(root, params.id));
route("DELETE", "/api/sessions/:id", ({ root, params }) => {
  deleteSession(root, params.id);
  return { deleted: true };
});

// export (§14): raw session file as a download — verbatim, not re-serialized
route("GET", "/api/sessions/:id/export", ({ root, params }) => ({
  raw: readSessionRaw(root, sessionId(params.id)),
  headers: {
    "content-disposition": `attachment; filename="${params.id}.json"`,
  },
}));

// import (§14): body IS the session JSON; merge (updatedAt wins) into the
// session with the same id, or create it
route("POST", "/api/import", async ({ root, kind, body }) =>
  importSession(root, kind, body));

// tree/file path containment (spec §11)
export function validateDir(p: string): string {
  if (p.includes("\0") || p.includes("\\"))
    throw new ApiError(400, `bad path: ${p}`);
  const n = path.posix.normalize(p);
  if (n.startsWith("/") || n === ".." || n.startsWith("../") || n.startsWith("-"))
    throw new ApiError(400, `bad path: ${p}`);
  return n;
}
