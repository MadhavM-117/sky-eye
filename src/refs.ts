// Repo detection + ref discovery (spec §5). Discovery gaps → empty/null in a 200.
import { run, tryRun, ApiError } from "./cli.ts";
import type { Refs } from "./types.ts";

const GIT_DEFAULT_BRANCHES = ["origin/main", "main", "origin/master", "master"];

export async function getRefs(root: string, kind: "git" | "jj"): Promise<Refs> {
  return kind === "jj" ? jjRefs(root) : gitRefs(root);
}

async function gitRefs(root: string): Promise<Refs> {
  const headId = (await tryRun("git", ["rev-parse", "HEAD"], root))?.trim() ?? "";
  const branch = (await tryRun("git", ["symbolic-ref", "--short", "HEAD"], root))?.trim();

  let defaultBase: Refs["defaultBase"] = null;
  for (const b of GIT_DEFAULT_BRANCHES) {
    const out = await tryRun("git", ["merge-base", "HEAD", b], root);
    if (out) {
      defaultBase = { id: out.trim(), label: b };
      break;
    }
  }

  const branches: Refs["branches"] = [];
  const forEachRef = await tryRun(
    "git",
    ["for-each-ref", "--format=%(objectname)%00%(refname:short)", "refs/heads", "refs/remotes"],
    root,
  );
  if (forEachRef) {
    for (const line of forEachRef.split("\n").filter(Boolean)) {
      const [id, name] = line.split("\0");
      if (id && name) branches.push({ id, name });
    }
  }

  const commits: Refs["commits"] = [];
  const log = await tryRun("git", ["log", "-n", "20", "--format=%H%00%s"], root);
  if (log) {
    for (const line of log.split("\n").filter(Boolean)) {
      const [id, subject] = line.split("\0");
      if (id) commits.push({ id, subject: subject ?? "" });
    }
  }

  return {
    root,
    kind: "git",
    head: { id: headId, label: branch ?? null },
    defaultBase,
    branches,
    commits,
  };
}

async function jjRefs(root: string): Promise<Refs> {
  // session-key rule (spec §9.1): head id = change id of @
  const headId = (await tryRun("jj", ["log", "--no-graph", "-r", "@", "-T", "change_id"], root))?.trim() ?? "";

  let defaultBase: Refs["defaultBase"] = null;
  const trunk = await tryRun(
    "jj",
    ["log", "--no-graph", "-r", "trunk", "-T", "commit_id"],
    root,
  );
  if (trunk) {
    defaultBase = { id: trunk.trim(), label: "trunk" };
  } else {
    // fall back to @- : change id when mutable, commit id when immutable
    const parentId = await tryRun(
      "jj",
      ["log", "--no-graph", "-r", "@-", "-T", "if(immutable, commit_id, change_id)"],
      root,
    );
    if (parentId) defaultBase = { id: parentId.trim(), label: "@-" };
  }

  const branches: Refs["branches"] = [];
  const bookmarks = await tryRun(
    "jj",
    ["bookmark", "list", "-T", 'name ++ "\\0" ++ normal_target.commit_id() ++ "\\n"'],
    root,
  );
  if (bookmarks) {
    for (const line of bookmarks.split("\n").filter(Boolean).map((l) => l.replace(/\0$/, ""))) {
      const [name, id] = line.split("\0");
      if (name && id) branches.push({ id, name });
    }
  } // error (absent target) → empty list, empty-data rule

  const commits: Refs["commits"] = [];
  const log = await tryRun(
    "jj",
    [
      "log",
      "--no-graph",
      "-n",
      "20",
      "-T",
      'if(immutable, commit_id, change_id) ++ "\\0" ++ commit_id ++ "\\0" ++ description.first_line() ++ "\\n"',
    ],
    root,
  );
  if (log) {
    for (const line of log.split("\n").filter(Boolean).map((l) => l.replace(/\0$/, ""))) {
      const [id, commitId, subject] = line.split("\0");
      if (id) commits.push({ id, subject: subject ?? "" });
      void commitId;
    }
  }

  return {
    root,
    kind: "jj",
    head: { id: headId || "@", label: "@ (working copy)" },
    defaultBase,
    branches,
    commits,
  };
}

// Resolve a user-picked base/head argument to the session-key stable id (spec §9.1):
// git → full commit id; jj → change id for mutable revisions (incl. @), commit id
// for immutable ones.
export async function resolveStableId(
  root: string,
  kind: "git" | "jj",
  ref: string,
): Promise<string> {
  if (kind === "git") {
    const out = await run("git", ["rev-parse", "--verify", ref + "^{commit}"], root);
    return out.trim();
  }
  const out = await run(
    "jj",
    ["log", "--no-graph", "-r", ref, "-T", "if(immutable, commit_id, change_id)"],
    root,
  );
  const id = out.trim();
  if (!id) throw new ApiError(400, `cannot resolve revision: ${ref}`);
  return id;
}
