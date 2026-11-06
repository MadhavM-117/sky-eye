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

const get = async (path: string, expect = 200) => {
  const res = await fetch(`http://localhost:${portOf}${path}`);
  assert.equal(res.status, expect);
  return { status: res.status, body: res.ok ? await res.json() : null };
};

const mut = async (method: string, p: string, body: unknown, headers: Record<string, string> = { "x-sky-eye": "1" }) => {
  const res = await fetch(`http://localhost:${portOf}${p}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

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
    assert.ok(session.chapters.length >= 2, "chapters exist");
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
