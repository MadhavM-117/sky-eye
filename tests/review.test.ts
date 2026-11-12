// Agent review loop fixtures (spec §16a, task 030): pure helpers plus the
// store-level PATCH contract on a temp dir; gate checks reuse narrate.test's
// injected-adapter pattern. No CLIs.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ApiError } from "../src/cli.ts";
import { buildReviewSnapshot, patchSession, validateAgentMarks, writeSession } from "../src/store.ts";
import { rerunAll, rerunChapter } from "../src/narrate.ts";
import { carryChapterState } from "../src/remap.ts";
import type { Chapter, Comment, Session } from "../src/types.ts";

const comment = (over: Partial<Comment> = {}): Comment => ({
  id: "c1",
  chapterId: "abc123",
  file: "src/a.ts",
  side: "new",
  line: 3,
  text: "fix this",
  createdAt: 100,
  updatedAt: 100,
  author: null,
  resolved: false,
  anchor: { file: "src/a.ts", side: "new", line: 3, text: "", before: [], after: [], chapterId: "abc123" },
  ...over,
});

const chapter = (): Chapter => ({
  id: "abc123",
  files: [
    {
      file: "src/a.ts",
      status: "modified" as const,
      hunks: [{ oldStart: 1, newStart: 1, oldLines: 3, newLines: 4, lines: [] }],
    },
  ],
  narrative: "unanalyzed",
  attention: [{ file: "src/a.ts", side: "new", line: 2, mark: "glance", markSource: "rules" }],
});

const session = (): Session => ({
  id: "aaa..bbb",
  base: "b",
  head: "h",
  diffDigest: "d",
  aliases: [],
  createdAt: 1,
  updatedAt: 1,
  lastWriteAt: 1,
  meta: { repo: "/tmp/x" },
  reviewed: false,
  chapters: [chapter()],
  comments: [comment()],
});

const root = () => fs.mkdtempSync(path.join(os.tmpdir(), "rev-"));

test("buildReviewSnapshot: open comments in, resolved excluded, field-copied", () => {
  const s = session();
  s.comments.push(comment({ id: "c2", resolved: true, resolvedAt: 200 }));
  const snap = buildReviewSnapshot(s)!;
  assert.equal(snap.comments.length, 1);
  assert.equal(snap.comments[0].id, "c1");
  // copy, not reference: editing the live comment later never mutates it
  s.comments[0].text = "edited after submit";
  assert.equal(snap.comments[0].text, "fix this");
});

test("validateAgentMarks: markSource agent, name rule, file must be a slice", () => {
  const c = chapter();
  const out = validateAgentMarks(
    [{ file: "src/a.ts", side: "new", line: 3, mark: "unsure" }],
    c,
  );
  assert.deepEqual(out, [{ file: "src/a.ts", side: "new", line: 3, mark: "unsure", markSource: "agent" }]);
  assert.throws(() => validateAgentMarks([{ file: "src/a.ts", side: "new", line: 3, mark: "BAD NAME" }], c), ApiError);
  assert.throws(() => validateAgentMarks([{ file: "src/other.ts", side: "new", line: 3, mark: "focus" }], c), ApiError);
  assert.throws(() => validateAgentMarks([{ file: "src/a.ts", side: "sideways", line: 3, mark: "focus" }], c), ApiError);
  assert.throws(() => validateAgentMarks([{ file: "src/a.ts", side: "new", line: 0, mark: "focus" }], c), ApiError);
  assert.throws(() => validateAgentMarks("nope", c), ApiError);
});

const stored = () => {
  const r = root();
  return { r, s: writeSession(r, session()) };
};

test("patchSession: narratives[] bulk-write sets narrativeEdited", () => {
  const { r, s } = stored();
  const out = patchSession(r, s.id, {
    narratives: [{ chapterId: "abc123", text: "agent wrote this" }],
  });
  assert.equal(out.chapters[0].narrative, "agent wrote this");
  assert.equal(out.chapters[0].narrativeEdited, true);
});

test("patchSession: marks[] appends with markSource agent, sets marksEdited", () => {
  const { r, s } = stored();
  const out = patchSession(r, s.id, {
    marks: [{ chapterId: "abc123", marks: [{ file: "src/a.ts", side: "new", line: 3, mark: "unsure" }] }],
  });
  // append: the rules mark survives next to the agent mark
  assert.equal(out.chapters[0].attention.length, 2);
  assert.equal(out.chapters[0].attention[0].markSource, "rules");
  assert.equal(out.chapters[0].attention[1].markSource, "agent");
  assert.equal(out.chapters[0].marksEdited, true);
  assert.throws(
    () => patchSession(r, s.id, { marks: [{ chapterId: "nope", marks: [] }] }),
    (e: ApiError) => e.status === 404,
  );
});

test("patchSession: submitReview snapshots, re-submit gated on new comments, review:null clears", () => {
  const { r, s } = stored();
  patchSession(r, s.id, { narratives: [{ chapterId: "abc123", text: "n" }] }); // bump lastWriteAt
  const withStamp = JSON.parse(fs.readFileSync(path.join(r, ".sky-eye", `${s.id}.json`), "utf8")) as Session;

  const first = patchSession(r, s.id, { lastWriteAt: withStamp.lastWriteAt, submitReview: true });
  assert.ok(first.review);
  assert.equal(first.review!.comments.length, 1);
  const stamp = first.review!.submittedAt;

  // nothing new → 409
  const after = JSON.parse(fs.readFileSync(path.join(r, ".sky-eye", `${s.id}.json`), "utf8")) as Session;
  assert.throws(
    () => patchSession(r, s.id, { lastWriteAt: after.lastWriteAt, submitReview: true }),
    (e: ApiError) => e.status === 409,
  );

  // a new comment (updatedAt bumped) → re-submit replaces the snapshot
  const c = JSON.parse(fs.readFileSync(path.join(r, ".sky-eye", `${s.id}.json`), "utf8")) as Session;
  c.comments.push(comment({ id: "c2", updatedAt: stamp + 1 }));
  fs.writeFileSync(path.join(r, ".sky-eye", `${s.id}.json`), JSON.stringify(c));
  const second = patchSession(r, s.id, { lastWriteAt: c.lastWriteAt, submitReview: true });
  assert.equal(second.review!.comments.length, 2);
  assert.ok(second.review!.submittedAt >= stamp); // same-ms submits allowed

  // review: null clears — a new round can submit again
  const cleared = patchSession(r, s.id, { lastWriteAt: second.lastWriteAt, review: null });
  assert.equal(cleared.review, undefined);
  const again = patchSession(r, s.id, { lastWriteAt: cleared.lastWriteAt, submitReview: true });
  assert.equal(again.review!.comments.length, 2);
});

test("gates: marksEdited alone 409s rerun and rerun-all; confirm passes", async () => {
  const s = session();
  s.chapters[0].marksEdited = true;
  await assert.rejects(
    rerunChapter(root(), "git", s, "abc123", false, {}),
    (e: ApiError) => e.status === 409 && (e.payload as { needsConfirm: boolean }).needsConfirm,
  );
  await assert.rejects(
    rerunAll(root(), "git", s, false, {}),
    (e: ApiError) => e.status === 409 && (e.payload as { needsConfirm: boolean }).needsConfirm,
  );
  const out = await rerunChapter(root(), "git", s, "abc123", true, {}); // no adapters → rules-only world
  assert.equal(out.chapters[0].narrative, "unanalyzed");
});

test("carryChapterState: agent marks ride the chapter id like narratives", () => {
  const prev = chapter();
  prev.attention.push({ file: "src/a.ts", side: "new", line: 3, mark: "unsure", markSource: "agent" });
  prev.marksEdited = true;
  const rebuilt = { ...chapter(), attention: [], narrative: "unanalyzed" };
  const out = carryChapterState([rebuilt], new Map([["abc123", prev]]));
  assert.equal(out[0].marksEdited, true);
  assert.equal(out[0].attention.length, 2); // full carried array, agent mark included
  // unedited chapters rebuild their marks from scratch
  const fresh = carryChapterState([{ ...chapter(), attention: [] }], new Map());
  assert.equal(fresh[0].marksEdited, undefined);
});
