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

    // log entry written, rotated on the next run
    const log1 = JSON.parse(fs.readFileSync(path.join(repo, ".sky-watch", "classifier.log"), "utf8"));
    assert.equal(log1.failed, false);
    assert.equal(log1.marksOut, attention.length);
    assert.ok(log1.request); // debug: true → full transcript

    // second rebuild (new commit → new session) rotates the log
    git(repo, "commit", "--allow-empty", "-m", "rotate log");
    const refs2 = await get("/api/refs");
    await mut("POST", "/api/sessions", {
      base: refs.body.defaultBase.id,
      head: refs2.body.head.id,
    });
    assert.ok(fs.existsSync(path.join(repo, ".sky-watch", "classifier.log.1")));
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
    const log = JSON.parse(fs.readFileSync(path.join(repo, ".sky-watch", "classifier.log"), "utf8"));
    assert.equal(log.failed, true);
  });
});
