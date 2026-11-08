// Real temp git repo, real server on an ephemeral loopback port (spec §20.4).
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { serve } from "../src/server.ts";
import "../src/routes.ts";
import { buildDiff, parseUnifiedDiff } from "../src/diff.ts";

const git = (repo: string, ...args: string[]) =>
  execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });

function makeRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "sky-eye-"));
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  // main.ts writes this at startup — without it .sky-watch/ state would leak
  // into the very diffs the server builds
  fs.writeFileSync(path.join(repo, ".gitignore"), ".sky-watch/\n");
  fs.writeFileSync(path.join(repo, "base.txt"), "line1\nline2\nline3\n");
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "a.ts"), "old one\nold two\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "base commit");
  git(repo, "checkout", "-b", "feature");
  fs.writeFileSync(path.join(repo, "base.txt"), "line1\nchanged2\nline3\n");
  fs.writeFileSync(path.join(repo, "src", "a.ts"), "new one\ntwo\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "head commit");
  return repo;
}

async function withServer(
  fn: (port: number, repo: string) => Promise<void>,
) {
  const repo = makeRepo();
  const { server, port } = await serve(repo, "git");
  try {
    await fn(port, repo);
  } finally {
    server.close();
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

// http.request (not fetch): undici pools keep-alive sockets per origin, and
// a pooled socket from one server cycle breaks against the next server that
// reuses the port ("other side closed"). http.request doesn't keep alive.
const request = (
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> =>
  new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port: portOf,
        method,
        path,
        headers: {
          ...(data
            ? {
                "content-type": "application/json",
                "content-length": String(Buffer.byteLength(data)),
              }
            : {}),
          ...headers,
        },
      },
      (res) => {
        let text = "";
        res.on("data", (c: Buffer) => (text += c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: text ? JSON.parse(text) : null,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(data);
  });

const get = async (path: string, expect = 200) => {
  const res = await request("GET", path);
  assert.equal(res.status, expect);
  return res;
};

const mut = (method: string, p: string, body: unknown) =>
  request(method, p, body, { "x-sky-eye": "1" });

let portOf = 0; // set by the test before any request is made

test("integration: refs, tree, file, sessions, security", async () => {
  await withServer(async (port, repo) => {
    portOf = port;

    // refs
    const refs = await get("/api/refs");
    assert.equal(refs.body.kind, "git");
    assert.match(refs.body.head.id, /^[0-9a-f]{40}$/);
    assert.equal(refs.body.head.label, "feature");
    assert.ok(refs.body.defaultBase, "default base exists (main)");
    assert.ok(refs.body.branches.some((b: { name: string }) => b.name === "main"));
    assert.equal(refs.body.commits.length, 2);

    // tree at head
    const tree = await get("/api/tree?ref=HEAD&dir=");
    assert.ok(tree.body.some((e: { name: string; type: string }) => e.name === "base.txt"));
    assert.ok(tree.body.some((e: { name: string }) => e.name === "src"));

    // file at head and at base-side commit
    const headFile = await get("/api/file?ref=HEAD&path=src/a.ts");
    assert.equal(headFile.body.binary, false);
    assert.match(headFile.body.content, /new one/);
    const baseCommit = refs.body.defaultBase.id;
    const baseFile = await get(`/api/file?ref=${baseCommit}&path=src/a.ts`);
    assert.match(baseFile.body.content, /old one/);

    // containment
    await get("/api/file?ref=HEAD&path=../../etc/passwd", 400);
    await get("/api/tree?ref=HEAD&dir=..", 400);
    await get("/api/file?ref=HEAD&path=/etc/passwd", 400);

    // session create
    const head = refs.body.head.id;
    const created = await mut("POST", "/api/sessions", { base: baseCommit, head });
    assert.equal(created.status, 201);
    const session = created.body;
    assert.equal(session.id, `${baseCommit}..${head}`);
    // base.txt + src/a.ts are small enough to merge into one multi-file chapter
    assert.ok(session.chapters.length >= 1, "chapters exist");
    assert.ok(
      session.chapters.some(
        (c: { files: { file: string }[] }) =>
          c.files.some((s) => s.file === "src/a.ts"),
      ),
      "src/a.ts chunked",
    );
    assert.ok(session.chapters.every((c: { narrative: string }) => c.narrative === "unanalyzed"));

    // idempotent create → 200 with the same session
    const again = await mut("POST", "/api/sessions", { base: baseCommit, head });
    assert.equal(again.status, 200);
    assert.equal(again.body.id, session.id);

    // session list
    const list = await get("/api/sessions");
    assert.equal(list.body.length, 1);
    assert.equal(list.body[0].openComments, 0);

    // patch label + narrative with correct lastWriteAt
    const chapter = session.chapters[0];
    const patched = await mut("PATCH", `/api/sessions/${session.id}`, {
      lastWriteAt: session.lastWriteAt,
      label: "the auth refactor",
      narrative: { chapterId: chapter.id, text: "tweaks the base file" },
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.label, "the auth refactor");
    assert.equal(patched.body.chapters[0].narrative, "tweaks the base file");
    assert.equal(patched.body.chapters[0].narrativeEdited, true);

    // persisted across a fresh load
    const reloaded = await get(`/api/sessions/${session.id}`);
    assert.equal(reloaded.body.label, "the auth refactor");

    // viewed files (task 021, spec §10): PATCH replaces the chapter's list,
    // intersected with slice paths, duplicates removed; absent before first use
    assert.ok(!("viewedFiles" in reloaded.body.chapters[0]), "no migration needed");
    const slicePath = chapter.files[0].file;
    const viewed = await mut("PATCH", `/api/sessions/${session.id}`, {
      lastWriteAt: reloaded.body.lastWriteAt,
      viewedFiles: { chapterId: chapter.id, files: [slicePath, slicePath, "../../etc"] },
    });
    assert.equal(viewed.status, 200);
    assert.deepEqual(viewed.body.chapters[0].viewedFiles, [slicePath]);
    // chapter-marking (all slice paths) stores the full list — the client
    // derives "chapter viewed" from `every`
    const allPaths = chapter.files.map((s: { file: string }) => s.file);
    const marked = await mut("PATCH", `/api/sessions/${session.id}`, {
      lastWriteAt: viewed.body.lastWriteAt,
      viewedFiles: { chapterId: chapter.id, files: allPaths },
    });
    assert.deepEqual(marked.body.chapters[0].viewedFiles, allPaths);
    const unviewed = await mut("PATCH", `/api/sessions/${session.id}`, {
      lastWriteAt: marked.body.lastWriteAt,
      viewedFiles: { chapterId: chapter.id, files: [] },
    });
    assert.deepEqual(unviewed.body.chapters[0].viewedFiles, []);
    // unknown chapter → 404; stale lastWriteAt → 409
    assert.equal(
      (await mut("PATCH", `/api/sessions/${session.id}`, {
        lastWriteAt: unviewed.body.lastWriteAt,
        viewedFiles: { chapterId: "nope", files: [slicePath] },
      })).status,
      404,
    );
    assert.equal(
      (await mut("PATCH", `/api/sessions/${session.id}`, {
        lastWriteAt: 1,
        viewedFiles: { chapterId: chapter.id, files: [slicePath] },
      })).status,
      409,
    );

    // conflict: stale lastWriteAt → 409 with current session
    const conflict = await mut("PATCH", `/api/sessions/${session.id}`, {
      lastWriteAt: session.lastWriteAt,
      label: "overwrite",
    });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.label, "the auth refactor");

    // security: mutations without the header, and bad Host, are rejected
    const csrf = await fetch(`http://localhost:${portOf}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ base: baseCommit, head }),
    });
    assert.equal(csrf.status, 403);

    // fetch (undici) won't send a forged Host — use http.request for it
    const badHost: { statusCode?: number } = await new Promise((resolve) => {
      const req = http.request(
        { host: "127.0.0.1", port: portOf, method: "POST", path: "/api/sessions",
          headers: { "content-type": "application/json", "x-sky-eye": "1",
                     host: `evil.example:${portOf}` } },
        (res) => { res.resume(); resolve(res); },
      );
      req.end(JSON.stringify({ base: baseCommit, head }));
    });
    assert.equal(badHost.statusCode, 403);
  });
});

test("comments: create, anchor capture, resolve, edit, conflicts (spec §12)", async () => {
  await withServer(async (port, repo) => {
    portOf = port;
    const refs = await get("/api/refs");
    const head = refs.body.head.id;
    const session = (
      await mut("POST", "/api/sessions", { base: refs.body.defaultBase.id, head })
    ).body;
    const chapter = session.chapters.find((c: { files: { file: string }[] }) =>
      c.files.some((s) => s.file === "src/a.ts"),
    );

    // new-side comment: anchor from the head file ("new one\ntwo\n"),
    // full 3-line context even at the hunk edge (line 1 → no before)
    const fresh = (await get(`/api/sessions/${session.id}`)).body;
    const created = await mut("POST", "/api/comments", {
      sessionId: session.id,
      chapterId: chapter.id,
      file: "src/a.ts",
      side: "new",
      line: 1,
      text: "first!",
      priority: "nit",
      lastWriteAt: fresh.lastWriteAt,
    });
    assert.equal(created.status, 201);
    const comment = created.body;
    assert.equal(comment.text, "first!");
    assert.equal(comment.createdAt, comment.updatedAt);
    // identity from the test repo's git config (spec §15)
    assert.deepEqual(comment.author, { name: "Test", email: "test@example.com" });
    assert.deepEqual(comment.anchor, {
      file: "src/a.ts",
      side: "new",
      line: 1,
      text: "new one",
      before: [],
      after: ["two"],
      chapterId: chapter.id,
    });

    // old-side comment: anchor from the base file ("old one\nold two\n")
    const base = (await get(`/api/sessions/${session.id}`)).body;
    const oldComment = (
      await mut("POST", "/api/comments", {
        sessionId: session.id,
        chapterId: chapter.id,
        file: "src/a.ts",
        side: "old",
        line: 2,
        text: "what was this?",
        lastWriteAt: base.lastWriteAt,
      })
    ).body;
    assert.equal(oldComment.anchor.text, "old two");
    assert.deepEqual(oldComment.anchor.before, ["old one"]);
    assert.deepEqual(oldComment.anchor.after, []);
    assert.equal(oldComment.priority, undefined);

    // open-comment count in the session list
    assert.equal((await get("/api/sessions")).body[0].openComments, 2);

    // resolve stamps resolvedAt; reopen clears it
    const afterCreate = (await get(`/api/sessions/${session.id}`)).body;
    const resolved = await mut("PATCH", `/api/comments/${comment.id}`, {
      sessionId: session.id,
      resolved: true,
      lastWriteAt: afterCreate.lastWriteAt,
    });
    assert.equal(resolved.body.resolved, true);
    assert.ok(typeof resolved.body.resolvedAt === "number");
    const reopened = await mut("PATCH", `/api/comments/${comment.id}`, {
      sessionId: session.id,
      resolved: false,
      lastWriteAt: (await get(`/api/sessions/${session.id}`)).body.lastWriteAt,
    });
    assert.equal(reopened.body.resolved, false);
    assert.equal(reopened.body.resolvedAt, undefined);
    assert.equal((await get("/api/sessions")).body[0].openComments, 2);

    // text edit preserves the anchor and bumps updatedAt
    const before = (await get(`/api/sessions/${session.id}`)).body;
    const edited = await mut("PATCH", `/api/comments/${comment.id}`, {
      sessionId: session.id,
      text: "first! (edited)",
      priority: "must-fix",
      lastWriteAt: before.lastWriteAt,
    });
    assert.equal(edited.body.text, "first! (edited)");
    assert.equal(edited.body.priority, "must-fix");
    assert.equal(edited.body.updatedAt > edited.body.createdAt, true);
    assert.deepEqual(edited.body.anchor, comment.anchor);

    // conflicts: stale lastWriteAt → 409
    const stale = await mut("PATCH", `/api/comments/${comment.id}`, {
      sessionId: session.id,
      resolved: true,
      lastWriteAt: before.lastWriteAt,
    });
    assert.equal(stale.status, 409);

    // validation: bad targets and unknown ids
    const badChapter = await mut("POST", "/api/comments", {
      sessionId: session.id, chapterId: "nope", file: "src/a.ts", side: "new", line: 1, text: "x",
    });
    assert.equal(badChapter.status, 404);
    const badSide = await mut("POST", "/api/comments", {
      sessionId: session.id, chapterId: chapter.id, file: "src/a.ts", side: "middle", line: 1, text: "x",
    });
    assert.equal(badSide.status, 400);
    const badLine = await mut("POST", "/api/comments", {
      sessionId: session.id, chapterId: chapter.id, file: "src/a.ts", side: "new", line: 0, text: "x",
    });
    assert.equal(badLine.status, 400);
    const noText = await mut("POST", "/api/comments", {
      sessionId: session.id, chapterId: chapter.id, file: "src/a.ts", side: "new", line: 1, text: "  ",
    });
    assert.equal(noText.status, 400);
    const unknownComment = await mut("PATCH", `/api/comments/deadbeef`, {
      sessionId: session.id, text: "x",
    });
    assert.equal(unknownComment.status, 404);
    const badSession = await mut("POST", "/api/comments", {
      sessionId: "../../etc/passwd", chapterId: "x", file: "x", side: "new", line: 1, text: "x",
    });
    assert.equal(badSession.status, 400);
  });
});

test("ignore-file upkeep: gitignore appended, dockerignore untouched", async () => {
  const repo = makeRepo();
  // no .dockerignore in this repo — startup must not create one
  const { upsertIgnoreFile } = await import("../src/ignore.ts");
  upsertIgnoreFile(repo, ".gitignore", true);
  upsertIgnoreFile(repo, ".dockerignore", fs.existsSync(path.join(repo, ".dockerignore")));
  assert.match(fs.readFileSync(path.join(repo, ".gitignore"), "utf8"), /\.sky-watch\//);
  assert.ok(!fs.existsSync(path.join(repo, ".dockerignore")));
  fs.rmSync(repo, { recursive: true, force: true });
});

// ---- refresh flows (spec §13, M3) --------------------------------------

const openSession = async () => {
  const refs = await get("/api/refs");
  return (
    await mut("POST", "/api/sessions", {
      base: refs.body.defaultBase.id,
      head: refs.body.head.id,
      baseLabel: refs.body.defaultBase.label,
      headLabel: refs.body.head.label ?? undefined,
    })
  ).body;
};

test("refresh: git amend supersedes, comments carried and re-pinned (spec §13.2)", async () => {
  await withServer(async (port, repo) => {
    portOf = port;
    const session = await openSession();
    // default title is the review order "<current branch> → <base branch>"
    assert.equal(session.label, `${session.headRef} → ${session.baseRef}`);
    assert.equal(
      (await get(`/api/sessions/${session.id}`)).body.stale,
      false,
    );
    const chapter = session.chapters.find((c: { files: { file: string }[] }) => c.files.some((s) => s.file === "base.txt"));
    const fresh = (await get(`/api/sessions/${session.id}`)).body;
    const comment = (
      await mut("POST", "/api/comments", {
        sessionId: session.id, chapterId: chapter.id, file: "base.txt",
        side: "new", line: 2, text: "note", lastWriteAt: fresh.lastWriteAt,
      })
    ).body;
    assert.equal(comment.anchor.text, "changed2");

    // amend the feature commit → headRef now resolves to a new commit id
    fs.writeFileSync(path.join(repo, "base.txt"), "line1\nchanged2\nline3\nline4\n");
    git(repo, "add", "-A");
    git(repo, "commit", "--amend", "--no-edit");

    const stale = (await get(`/api/sessions/${session.id}`)).body;
    assert.equal(stale.stale, true);

    const res = await mut("POST", `/api/sessions/${session.id}/refresh`, {});
    assert.equal(res.status, 200);
    const successor = res.body.session;
    assert.ok(res.body.supersededBy);
    assert.equal(successor.id, res.body.supersededBy);
    assert.notEqual(successor.id, session.id);

    // old session kept on disk, marked superseded
    const old = (await get(`/api/sessions/${session.id}`)).body;
    assert.equal(old.supersededBy, successor.id);

    // comment carried, re-pinned at the same content line with a fresh anchor
    const carried = successor.comments.find((c: { id: string }) => c.id === comment.id);
    assert.ok(carried, "comment carried into successor");
    assert.equal(carried.orphaned, undefined);
    assert.equal(carried.line, 2);
    assert.equal(carried.anchor.text, "changed2");
    assert.equal(carried.anchor.chapterId, carried.chapterId);
    // the fresh anchor reflects the amended file (3 lines of after-context now)
    assert.deepEqual(carried.anchor.after, ["line3", "line4"]);
  });
});

test("refresh: unmatched comments orphan into triage (spec §13.3–13.4)", async () => {
  await withServer(async (port, repo) => {
    portOf = port;
    const session = await openSession();
    const chapter = session.chapters.find((c: { files: { file: string }[] }) => c.files.some((s) => s.file === "base.txt"));
    const fresh = (await get(`/api/sessions/${session.id}`)).body;
    const comment = (
      await mut("POST", "/api/comments", {
        sessionId: session.id, chapterId: chapter.id, file: "base.txt",
        side: "new", line: 2, text: "note", lastWriteAt: fresh.lastWriteAt,
      })
    ).body;

    // rewrite the commented line away → no anchor match in the new head
    fs.writeFileSync(path.join(repo, "base.txt"), "line1\nchanged-two\nline3\n");
    git(repo, "add", "-A");
    git(repo, "commit", "--amend", "--no-edit");

    const res = await mut("POST", `/api/sessions/${session.id}/refresh`, {});
    const carried = res.body.session.comments.find((c: { id: string }) => c.id === comment.id);
    assert.equal(carried.orphaned, true);
    assert.equal(carried.anchor.text, "changed2"); // old anchor kept
    // re-pinning clears the orphan (server-side anchor capture, spec §12);
    // targets a live chapter of that file (old chapter ids may survive when
    // the hunk range is unchanged — D§11 — so use the successor's chapter)
    const afterRefresh = (await get(`/api/sessions/${res.body.session.id}`)).body;
    const fixed = await mut("PATCH", `/api/comments/${comment.id}`, {
      sessionId: res.body.session.id,
      reanchor: {
        chapterId: res.body.session.chapters.find((c: { files: { file: string }[] }) => c.files.some((s) => s.file === "base.txt")).id,
        file: "base.txt", side: "new", line: 2,
      },
      lastWriteAt: afterRefresh.lastWriteAt,
    });
    assert.equal(fixed.status, 200);
    assert.equal(fixed.body.orphaned, undefined);
    assert.equal(fixed.body.anchor.text, "changed-two");
  });
});

// ---- jj flow: the change-id session key survives a working-copy change ----

function makeJjRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "sky-eye-jj-"));
  const jj = (...args: string[]) =>
    execFileSync("jj", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  jj("git", "init");
  // main.ts writes this at startup — without it .sky-watch/ state would leak
  // into the very diffs the server builds
  fs.writeFileSync(path.join(repo, ".gitignore"), ".sky-watch/\n");
  jj("config", "set", "--repo", "user.name", "Test");
  jj("config", "set", "--repo", "user.email", "test@example.com");
  fs.writeFileSync(path.join(repo, "f.txt"), "one\ntwo\nthree\n");
  jj("describe", "-m", "base commit");
  jj("new");
  fs.writeFileSync(path.join(repo, "f.txt"), "one\n2wo\nthree\n");
  jj("describe", "-m", "head commit");
  return repo;
}

test("refresh: jj change-id key survives, session updates in place (spec §13.2)", async () => {
  const repo = makeJjRepo();
  const { server, port } = await serve(repo, "jj");
  try {
    portOf = port;
    const refs = await get("/api/refs");
    assert.equal(refs.body.kind, "jj");
    // head is the change id of @ (mutable → not a commit id, spec §9.1)
    assert.doesNotMatch(refs.body.head.id, /^[0-9a-f]{40}$/);
    const session = (
      await mut("POST", "/api/sessions", { base: refs.body.defaultBase.id, head: refs.body.head.id })
    ).body;
    const chapter = session.chapters.find((c: { files: { file: string }[] }) => c.files.some((s) => s.file === "f.txt"));
    const fresh = (await get(`/api/sessions/${session.id}`)).body;
    const comment = (
      await mut("POST", "/api/comments", {
        sessionId: session.id, chapterId: chapter.id, file: "f.txt",
        side: "new", line: 2, text: "note", lastWriteAt: fresh.lastWriteAt,
      })
    ).body;
    assert.equal(comment.anchor.text, "2wo");

    // working-copy edit: same change id → same session key, changed diff
    fs.writeFileSync(path.join(repo, "f.txt"), "one\n2wo\nthree\nfour\n");
    const stale = (await get(`/api/sessions/${session.id}`)).body;
    assert.equal(stale.stale, true);

    const res = await mut("POST", `/api/sessions/${session.id}/refresh`, {});
    assert.equal(res.status, 200);
    assert.equal(res.body.supersededBy, undefined);
    assert.equal(res.body.session.id, session.id); // in place
    assert.notEqual(res.body.session.diffDigest, session.diffDigest);

    // comment re-pinned on the rebuilt chapters, same line
    const carried = res.body.session.comments.find((c: { id: string }) => c.id === comment.id);
    assert.equal(carried.orphaned, undefined);
    assert.equal(carried.line, 2);
    assert.equal(carried.anchor.text, "2wo");
    assert.equal(carried.anchor.chapterId, carried.chapterId);

    // digest updated → no longer stale
    const after = (await get(`/api/sessions/${session.id}`)).body;
    assert.equal(after.stale, false);
  } finally {
    server.close();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// ---- custom classifier (spec §16.5) ---------------------------------------

const CL_CONFIG = (command: string, extra: object = {}) =>
  JSON.stringify({ classifier: { command, ...extra } });

// classifier that marks every changed line `custom-hot` (extensible name)
const CL_SCRIPT = `
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  const req = JSON.parse(input);
  const marks = [];
  for (const ch of req.chapters)
    for (const f of ch.files)
      for (const h of f.hunks)
        for (const l of h.lines)
          marks.push({ file: f.file, side: l.side, line: l.line, mark: "custom-hot" });
  console.log(JSON.stringify({ marks }));
});`;

const attentionOf = (session: any) =>
  session.chapters.flatMap((c: any) => c.attention);

test("integration: custom classifier overrides rules marks, logged", async () => {
  await withServer(async (port, repo) => {
    portOf = port;
    fs.writeFileSync(path.join(repo, ".classifier.mjs"), CL_SCRIPT);
    fs.mkdirSync(path.join(repo, ".sky-watch"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, ".sky-watch", "config.json"),
      CL_CONFIG("node .classifier.mjs", { debug: true }),
    );
    const refs = await get("/api/refs");
    const session = await mut("POST", "/api/sessions", {
      base: refs.body.defaultBase.id,
      head: refs.body.head.id,
    });
    const attention = attentionOf(session.body);
    assert.ok(attention.length > 0);
    assert.ok(attention.every((m: any) => m.markSource === "custom" && m.mark === "custom-hot"));

    // log entry written to .sky-watch/logs/ (task 016), one run per file —
    // overwritten, so the next run keeps only the most recent log
    const logPath = path.join(repo, ".sky-watch", "logs", "classifier.log");
    const log1 = JSON.parse(fs.readFileSync(logPath, "utf8"));
    assert.equal(log1.failed, false);
    assert.equal(log1.marksOut, attention.length);
    assert.ok(log1.request); // debug: true → full transcript

    // second rebuild (new commit → new session) overwrites the log
    git(repo, "commit", "--allow-empty", "-m", "rotate log");
    const refs2 = await get("/api/refs");
    await mut("POST", "/api/sessions", {
      base: refs.body.defaultBase.id,
      head: refs2.body.head.id,
    });
    const log2 = JSON.parse(fs.readFileSync(logPath, "utf8"));
    assert.notEqual(log2.request, log1.request); // different base/head → different transcript
    assert.ok(!fs.existsSync(path.join(repo, ".sky-watch", "classifier.log.1")));
  });
});

test("integration: broken classifier → fallback keeps rules; fallback:false clears", async () => {
  await withServer(async (port, repo) => {
    portOf = port;
    fs.mkdirSync(path.join(repo, ".sky-watch"), { recursive: true });
    const refs = await get("/api/refs");
    const body = { base: refs.body.defaultBase.id, head: refs.body.head.id };

    // default fallback: rules marks survive the failure
    fs.writeFileSync(path.join(repo, ".sky-watch", "config.json"), CL_CONFIG("exit 3"));
    const fallback = await mut("POST", "/api/sessions", body);
    const rulesAttention = attentionOf(fallback.body);
    assert.ok(rulesAttention.length > 0);
    assert.ok(rulesAttention.every((m: any) => m.markSource === "rules"));

    // fallback:false: the classifier is authoritative — marks cleared (visible
    // failure, not silent stale marks). New commit → distinct session id.
    fs.writeFileSync(
      path.join(repo, ".sky-watch", "config.json"),
      CL_CONFIG("exit 3", { fallback: false }),
    );
    git(repo, "commit", "--allow-empty", "-m", "another head");
    const refs2 = await get("/api/refs");
    const cleared = await mut("POST", "/api/sessions", {
      base: refs.body.defaultBase.id,
      head: refs2.body.head.id,
    });
    assert.equal(attentionOf(cleared.body).length, 0);
    const log = JSON.parse(fs.readFileSync(path.join(repo, ".sky-watch", "logs", "classifier.log"), "utf8"));
    assert.equal(log.failed, true);
  });
});

test("export/import: download round-trip, merge through the server (spec §14)", async () => {
  await withServer(async (port, repo) => {
    portOf = port;
    const refs = await get("/api/refs");
    const session = (
      await mut("POST", "/api/sessions", {
        base: refs.body.defaultBase.id,
        head: refs.body.head.id,
      })
    ).body;
    const comment = (
      await mut("POST", "/api/comments", {
        sessionId: session.id,
        chapterId: session.chapters[0].id,
        file: session.chapters[0].files[0].file,
        side: "new",
        line: session.chapters[0].files[0].hunks[0].lines.find((l: any) => l.type === "add").newLine,
        text: "original wording",
      })
    ).body;

    // export: verbatim download with attachment disposition
    const dl = await fetch(`http://localhost:${portOf}/api/sessions/${encodeURIComponent(session.id)}/export`);
    assert.equal(dl.status, 200);
    assert.match(dl.headers.get("content-disposition")!, /attachment; filename=/);
    const exported = JSON.parse(await dl.text());
    assert.equal(exported.comments.length, 1);
    assert.equal(exported.comments[0].text, "original wording");

    // import: the "other machine" edited the comment (newer updatedAt) → wins
    const remote = structuredClone(exported);
    remote.comments[0].text = "reworded on the other machine";
    remote.comments[0].updatedAt = comment.updatedAt + 1000;
    const merged = await mut("POST", "/api/import", remote);
    assert.equal(merged.status, 200);
    assert.equal(merged.body.comments[0].text, "reworded on the other machine");

    // re-import the stale export: the local (newer) edit survives
    const kept = await mut("POST", "/api/import", exported);
    assert.equal(kept.body.comments[0].text, "reworded on the other machine");

    // digest mismatch (rebased clone abroad): remap pass runs — the comment
    // re-anchors against the head file (text still matches), not orphaned
    const rebased = structuredClone(exported);
    rebased.diffDigest = "different";
    const remapped = await mut("POST", "/api/import", rebased);
    assert.equal(remapped.body.comments[0].orphaned, undefined);
    assert.ok(remapped.body.comments[0].anchor.text.length > 0);

    // invalid import bodies are rejected
    assert.equal((await mut("POST", "/api/import", { id: "bad" })).status, 400);
    assert.equal(
      (await mut("POST", "/api/import", { id: "aaa..bbb", comments: [] })).status,
      400,
    );
  });
});

test("rerun: no config → skip; custom adapter → narrative + confirm guard (spec §16.2)", async () => {
  await withServer(async (_port, repo) => {
    const session = await openSession();
    const chapterId = session.chapters[0].id;

    // no LLM config → rules-only world, rerun is a no-op that never blocks
    const skipped = await mut("POST", `/api/sessions/${session.id}/rerun`, { chapterId });
    assert.equal(skipped.status, 200);
    assert.equal(skipped.body.chapters[0].narrative, "unanalyzed");

    // custom adapter (§22.2): the whole server path fires without network —
    // the script echoes a fixed narrative and re-marks nothing
    const dir = path.join(repo, ".sky-watch");
    fs.mkdirSync(dir, { recursive: true });
    const script = path.join(dir, "adapter.sh");
    fs.writeFileSync(
      script,
      `#!/bin/sh\nnode -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{console.log(JSON.stringify({text:"generated narrative"}))})'`,
    );
    fs.chmodSync(script, 0o755);
    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ tasks: { narrate: { command: script } } }),
    );

    const generated = await mut("POST", `/api/sessions/${session.id}/rerun`, { chapterId });
    assert.equal(generated.status, 200);
    assert.equal(generated.body.chapters[0].narrative, "generated narrative");

    // unknown chapter → 404
    assert.equal(
      (await mut("POST", `/api/sessions/${session.id}/rerun`, { chapterId: "nope" })).status,
      404,
    );

    // edited narrative → 409 needsConfirm; confirm regenerates (§10)
    const edited = await mut("PATCH", `/api/sessions/${session.id}`, {
      lastWriteAt: generated.body.lastWriteAt,
      narrative: { chapterId, text: "human edit" },
    });
    const guarded = await mut("POST", `/api/sessions/${session.id}/rerun`, { chapterId });
    assert.equal(guarded.status, 409);
    assert.equal(guarded.body.needsConfirm, true);
    const confirmed = await mut("POST", `/api/sessions/${session.id}/rerun`, {
      chapterId,
      confirm: true,
    });
    assert.equal(confirmed.body.chapters[0].narrative, "generated narrative");
    assert.ok(edited.body.chapters[0].narrativeEdited);
  });
});

test("creation is eager: chapters fully analysed before the session is served (spec §16.2)", async () => {
  await withServer(async (_port, repo) => {
    const dir = path.join(repo, ".sky-watch");
    fs.mkdirSync(dir, { recursive: true });
    const script = path.join(dir, "adapter.sh");
    fs.writeFileSync(
      script,
      `#!/bin/sh\nnode -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{console.log(JSON.stringify({text:"generated narrative"}))})'`,
    );
    fs.chmodSync(script, 0o755);
    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ tasks: { narrate: { command: script } } }),
    );

    const refs = await get("/api/refs");
    const created = await mut("POST", "/api/sessions", {
      base: refs.body.defaultBase.id,
      head: refs.body.head.id,
    });
    assert.equal(created.status, 201);
    assert.ok(created.body.chapters.length > 0);
    assert.ok(
      created.body.chapters.every(
        (c: { narrative: string }) => c.narrative === "generated narrative",
      ),
      "every chapter narrated by the create call itself",
    );
  });
});

test("buildDiff is config-proof against diff.mnemonicPrefix", async () => {
  // task 012: a user's mnemonicPrefix config would otherwise make git emit
  // c/w prefixes that parseUnifiedDiff can't handle (silent 0-file parse)
  const repo = makeRepo();
  try {
    git(repo, "config", "diff.mnemonicPrefix", "true");
    const text = await buildDiff(repo, "git", "main", "feature");
    const files = parseUnifiedDiff(text);
    assert.ok(files.length > 0, `expected files, got: ${text.slice(0, 200)}`);
    assert.deepEqual(
      files.map((f) => f.path).sort(),
      ["base.txt", "src/a.ts"],
    );
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("archive/delete: archive moves the file, unarchive restores, delete removes (task 017)", async () => {
  await withServer(async (_port, repo) => {
    const refs = await get("/api/refs");
    const created = await mut("POST", "/api/sessions", {
      base: refs.body.defaultBase.id,
      head: refs.body.head.id,
    });
    const id = created.body.id;
    const enc = encodeURIComponent(id);

    // archive → leaves the active list + 404s on load; archived list has it
    assert.equal((await mut("POST", `/api/sessions/${enc}/archive`, {})).status, 200);
    assert.equal((await get("/api/sessions")).body.length, 0);
    const archived = await get("/api/sessions?archived=1");
    assert.equal(archived.body.length, 1);
    assert.equal(archived.body[0].id, id);
    await get(`/api/sessions/${enc}`, 404);
    assert.ok(fs.existsSync(path.join(repo, ".sky-watch", "archive", `${id}.json`)));
    assert.ok(!fs.existsSync(path.join(repo, ".sky-watch", `${id}.json`)));

    // unarchive → back in the active list, loadable again
    assert.equal((await mut("POST", `/api/sessions/${enc}/unarchive`, {})).status, 200);
    assert.equal((await get("/api/sessions")).body.length, 1);
    assert.equal((await get("/api/sessions?archived=1")).body.length, 0);
    assert.equal((await get(`/api/sessions/${enc}`)).body.id, id);

    // archive again, delete removes the archived file for good
    await mut("POST", `/api/sessions/${enc}/archive`, {});
    assert.equal((await mut("DELETE", `/api/sessions/${enc}`, {})).status, 200);
    assert.equal((await get("/api/sessions?archived=1")).body.length, 0);
    await mut("DELETE", `/api/sessions/${enc}`, {});
    assert.equal((await mut("DELETE", `/api/sessions/${enc}`, {})).status, 404);
  });
});

test("rechunk: pure fallback keeps ids; chunk adapter regroups with titles; 409 gate (spec §8a)", async () => {
  await withServer(async (_port, repo) => {
    const session = await openSession();
    const enc = encodeURIComponent(session.id);

    // no chunk config → pure chunker, same diff → same ids
    const rechunked = await mut("POST", `/api/sessions/${enc}/rechunk`, {});
    assert.equal(rechunked.status, 200);
    assert.deepEqual(
      rechunked.body.chapters.map((c: { id: string }) => c.id),
      session.chapters.map((c: { id: string }) => c.id),
    );

    // chunk adapter via the custom exec hook: groups h0, unknown ids dropped →
    // leftovers land in trailing pure-chunked chapters
    const dir = path.join(repo, ".sky-watch");
    fs.mkdirSync(dir, { recursive: true });
    const script = path.join(dir, "chunk.sh");
    fs.writeFileSync(
      script,
      `#!/bin/sh\nnode -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{console.log(JSON.stringify({text:JSON.stringify({chapters:[{title:"one",hunks:["h0","h9"]}]})}))})'`,
    );
    fs.chmodSync(script, 0o755);
    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ tasks: { chunk: { command: script } } }),
    );

    const semantic = await mut("POST", `/api/sessions/${enc}/rechunk`, {});
    assert.equal(semantic.status, 200);
    assert.equal(semantic.body.chapters[0].title, "one");

    // edited narrative → 409 needsConfirm until confirmed (§10 gate)
    const chapterId = semantic.body.chapters[0].id;
    await mut("PATCH", `/api/sessions/${enc}`, {
      lastWriteAt: semantic.body.lastWriteAt,
      narrative: { chapterId, text: "human edit" },
    });
    const guarded = await mut("POST", `/api/sessions/${enc}/rechunk`, {});
    assert.equal(guarded.status, 409);
    assert.equal(guarded.body.needsConfirm, true);
    assert.equal((await mut("POST", `/api/sessions/${enc}/rechunk`, { confirm: true })).status, 200);
  });
});
