// Export/import merge (spec §14, task 010): pure mergeSessions fixtures +
// importSession persistence (no VCS calls — digest must match so the remap
// pass is skipped; that path is covered by the integration test).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { importSession, mergeSessions } from "../src/store.ts";
import type { Chapter, Comment, Session } from "../src/types.ts";

const chapter = (id: string, over: Partial<Chapter> = {}): Chapter => ({
  id,
  files: [{ file: "a.ts", status: "modified", hunks: [] }],
  narrative: "",
  attention: [],
  ...over,
});

const comment = (id: string, over: Partial<Comment> = {}): Comment => ({
  id,
  chapterId: "c1",
  file: "a.ts",
  side: "new",
  line: 1,
  text: `text ${id}`,
  createdAt: 100,
  updatedAt: 100,
  author: null,
  resolved: false,
  anchor: {
    file: "a.ts", side: "new", line: 1, text: "x", before: [], after: [],
    chapterId: "c1",
  },
  ...over,
});

const session = (over: Partial<Session> = {}): Session => ({
  id: "aaa..bbb",
  base: "aaa",
  head: "bbb",
  diffDigest: "d1",
  aliases: [],
  createdAt: 1,
  updatedAt: 1,
  lastWriteAt: 1,
  meta: { repo: "/r" },
  reviewed: false,
  chapters: [chapter("c1")],
  comments: [],
  ...over,
});

test("merge: newer updatedAt wins, tie broken by older createdAt", () => {
  const local = session({ comments: [comment("e1", { text: "local", updatedAt: 200 })] });
  const r1 = mergeSessions(
    local,
    session({ comments: [comment("e1", { text: "imported", updatedAt: 300 })] }),
  );
  assert.equal(r1.session.comments[0].text, "imported");

  const r2 = mergeSessions(
    session({ comments: [comment("e1", { text: "local", createdAt: 100 })] }),
    session({ comments: [comment("e1", { text: "imported", createdAt: 50 })] }),
  ); // same updatedAt → the earlier-created (original) wins
  assert.equal(r2.session.comments[0].text, "imported");

  const r3 = mergeSessions(
    session({ comments: [comment("e1", { text: "local", createdAt: 50 })] }),
    session({ comments: [comment("e1", { text: "imported", createdAt: 90 })] }),
  );
  assert.equal(r3.session.comments[0].text, "local");
});

test("merge: nothing deleted — local-only comments kept, imported-only added", () => {
  const r = mergeSessions(
    session({ comments: [comment("local-only", { updatedAt: 500 })] }),
    session({ comments: [comment("imported-only", { text: "fresh", updatedAt: 500 })] }),
  );
  const ids = r.session.comments.map((c) => c.id).sort();
  assert.deepEqual(ids, ["imported-only", "local-only"]);
});

test("merge: imported narrative wins on a locally unedited chapter, not on an edited one", () => {
  // local unedited → imported narrative (and its edited flag) travel in
  const r1 = mergeSessions(
    session({ chapters: [chapter("c1", { narrative: "local" })] }),
    session({
      updatedAt: 2,
      chapters: [chapter("c1", { narrative: "imported", narrativeEdited: true })],
    }),
  );
  assert.equal(r1.session.chapters[0].narrative, "imported");
  assert.equal(r1.session.chapters[0].narrativeEdited, true);

  // locally edited narrative is never overwritten (chapters carry no
  // timestamp — there is nothing newer to compare against, §14)
  const r2 = mergeSessions(
    session({ chapters: [chapter("c1", { narrative: "mine", narrativeEdited: true })] }),
    session({
      updatedAt: 99,
      chapters: [chapter("c1", { narrative: "imported", narrativeEdited: true })],
    }),
  );
  assert.equal(r2.session.chapters[0].narrative, "mine");
});

test("merge: digest mismatch is flagged for the remap pass, chapters stay local", () => {
  const attention = [{ file: "a.ts", side: "new" as const, line: 1, mark: "focus", markSource: "rules" as const }];
  const local = session({
    chapters: [chapter("c1", { narrative: "keep", narrativeEdited: true, attention })],
  });
  const r = mergeSessions(local, session({ diffDigest: "d2", chapters: [chapter("c1")], comments: [] }));
  assert.equal(r.digestChanged, true);
  // diff-derived fields (attention) and a locally edited narrative stay local
  assert.equal(r.session.chapters[0].narrative, "keep");
  assert.equal(r.session.chapters[0].attention, attention);
});

test("importSession: unknown id creates the session, known id merges in place", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sky-eye-import-"));
  try {
    // create-on-import (§14): validated, written, returned as-is
    const imported = session({ comments: [comment("e1", { text: "from A" })] });
    const created = await importSession(root, "git", imported);
    assert.equal(created.comments[0].text, "from A");
    assert.ok(fs.existsSync(path.join(root, ".sky-eye", "aaa..bbb.json")));

    // merge: local edit (newer) survives re-importing the older export
    created.comments[0].text = "edited on B";
    created.comments[0].updatedAt = 999;
    const merged = await importSession(root, "git", imported);
    assert.equal(merged.comments[0].text, "edited on B");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("importSession: rejects malformed ids and shapes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sky-eye-import-"));
  try {
    await assert.rejects(
      () => importSession(root, "git", session({ id: "../../etc/passwd" })),
      /invalid session id/,
    );
    await assert.rejects(
      () => importSession(root, "git", { id: "aaa..bbb", comments: [] }),
      /not a session file/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
