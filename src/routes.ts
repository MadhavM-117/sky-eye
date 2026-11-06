// Route table for the M1 milestone (spec §10). Later milestones append entries.
import path from "node:path";
import { route } from "./server.ts";
import { ApiError, validateRef } from "./cli.ts";
import { getRefs } from "./refs.ts";
import { listTree, listTreeRecursive, readFileAt } from "./tree.ts";
import {
  createComment,
  createSession,
  listSessions,
  loadSession,
  patchComment,
  patchSession,
  sessionId,
} from "./store.ts";

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

route("GET", "/api/sessions", ({ root }) => listSessions(root));

route("GET", "/api/sessions/:id", ({ root, params }) => {
  const id = sessionId(params.id);
  return loadSession(root, id);
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

// tree/file path containment (spec §11)
export function validateDir(p: string): string {
  if (p.includes("\0") || p.includes("\\"))
    throw new ApiError(400, `bad path: ${p}`);
  const n = path.posix.normalize(p);
  if (n.startsWith("/") || n === ".." || n.startsWith("../") || n.startsWith("-"))
    throw new ApiError(400, `bad path: ${p}`);
  return n;
}
