// Remap pass fixtures (spec §13.3): pure logic, no CLIs (spec §20).
import test from "node:test";
import assert from "node:assert/strict";
import { remapComment } from "../src/remap.ts";
import type { Chapter, Comment, Hunk } from "../src/types.ts";

const lines = (...texts: string[]) => texts;

// chapter whose slice for `file` renders new-side lines [start, start+count)
const chapter = (file: string, ranges: [number, number][]): Chapter => ({
  id: "ch-fixed",
  files: [
    {
      file,
      status: "modified" as const,
      hunks: ranges.map(([newStart, count]): Hunk => ({
        oldStart: newStart,
        newStart,
        oldLines: count,
        newLines: count,
        lines: [],
      })),
    },
  ],
  narrative: "",
  attention: [],
});

let seq = 0;
const comment = (
  anchor: Partial<Comment["anchor"]> & { text: string },
  over: Partial<Comment> = {},
): Comment => ({
  id: `c${++seq}`,
  chapterId: "old-chapter",
  file: anchor.file ?? "f.txt",
  side: anchor.side ?? "new",
  line: anchor.line ?? 1,
  text: "note",
  createdAt: 1,
  updatedAt: 1,
  author: null,
  resolved: false,
  anchor: {
    file: anchor.file ?? "f.txt",
    side: anchor.side ?? "new",
    line: anchor.line ?? 1,
    text: anchor.text,
    before: anchor.before ?? [],
    after: anchor.after ?? [],
    chapterId: "old-chapter",
  },
  ...over,
});

test("single match near the old line → re-pinned with a fresh anchor", () => {
  const c = comment({ text: "  2wo", line: 2, before: ["  one"], after: ["  three"] });
  const chapters = [chapter("f.txt", [[1, 4]])];
  const outcome = remapComment(c, lines("  one", "  2wo", "  three", "}"), chapters);
  assert.equal(outcome, "repinned");
  assert.equal(c.line, 2);
  assert.equal(c.chapterId, "ch-fixed");
  assert.equal(c.orphaned, undefined);
  assert.equal(c.anchor.text, "  2wo");
  assert.deepEqual(c.anchor.before, ["  one"]);
  assert.deepEqual(c.anchor.after, ["  three", "}"]);
  assert.equal(c.anchor.chapterId, "ch-fixed");
});

test("multiple candidates → context score wins over proximity", () => {
  // "return null" twice; the second has the matching after-context "}"
  const c = comment({
    text: "return null",
    line: 3,
    after: ["}"],
    before: ["a", "b"],
  });
  const chapters = [chapter("f.txt", [[1, 8]])];
  const outcome = remapComment(
    c,
    lines(
      "a", "b", "return null", "x", // near old line, no "}" after
      "a", "b", "return null", "}", // further away, context matches
    ),
    chapters,
  );
  assert.equal(outcome, "repinned");
  assert.equal(c.line, 7);
});

test("context-score tie → nearest to the old line wins", () => {
  const c = comment({ text: "same", line: 5, before: ["b"], after: ["a"] });
  const chapters = [chapter("f.txt", [[1, 6]])];
  // both candidates have identical context (b/a); the nearer one (line 5) wins
  const outcome = remapComment(c, lines("b", "same", "a", "b", "same", "a"), chapters);
  assert.equal(outcome, "repinned");
  assert.equal(c.line, 5);
});

test("no match in the new file → orphaned, anchor kept", () => {
  const anchor = { file: "f.txt", side: "new" as const, line: 2, text: "gone", before: [], after: [], chapterId: "old-chapter" };
  const c = comment(anchor);
  const outcome = remapComment(c, lines("one", "two", "three"), [chapter("f.txt", [[1, 3]])]);
  assert.equal(outcome, "orphaned");
  assert.equal(c.orphaned, true);
  assert.equal(c.line, 2);
  assert.deepEqual(c.anchor, anchor); // untouched
});

test("matched line outside every rebuilt hunk → orphaned (never hidden)", () => {
  const c = comment({ text: "ctx", line: 2 });
  // matches at line 2, but the rebuilt chapter only renders lines 5–6
  const outcome = remapComment(c, lines("pre", "ctx", "filler", "ctx", "in"), [chapter("f.txt", [[4, 2]])]);
  assert.equal(outcome, "orphaned");
  assert.equal(c.orphaned, true);
});

test("old-side comments orphan immediately (D§6 cut)", () => {
  const c = comment({ text: "one", side: "old", line: 1 });
  const outcome = remapComment(c, lines("one", "two"), [chapter("f.txt", [[1, 2]])]);
  assert.equal(outcome, "orphaned");
  assert.equal(c.orphaned, true);
});

test("file gone at the new head → orphaned", () => {
  const c = comment({ text: "one", line: 1 });
  const outcome = remapComment(c, null, [chapter("f.txt", [[1, 2]])]);
  assert.equal(outcome, "orphaned");
  assert.equal(c.orphaned, true);
});
