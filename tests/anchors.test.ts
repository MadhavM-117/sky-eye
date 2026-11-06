// Anchor capture fixtures (spec §12, §20): 3-line before/after context even
// at hunk boundaries, plus the chapter-hunk fallback.
import assert from "node:assert/strict";
import { test } from "node:test";
import { captureAnchor, captureAnchorFromHunks } from "../src/anchors.ts";
import type { Hunk } from "../src/types.ts";

const lines = ["a", "b", "c", "d", "e", "f", "g", "h"];

test("captureAnchor: middle line gets 3 before + 3 after", () => {
  const a = captureAnchor(lines, "f.ts", "new", 4, "ch1");
  assert.deepEqual(a, {
    file: "f.ts",
    side: "new",
    line: 4,
    text: "d",
    before: ["a", "b", "c"],
    after: ["e", "f", "g"],
    chapterId: "ch1",
  });
});

test("captureAnchor: first line has no before, keeps 3 after", () => {
  const a = captureAnchor(lines, "f.ts", "new", 1, "ch1");
  assert.deepEqual(a.before, []);
  assert.deepEqual(a.after, ["b", "c", "d"]);
  assert.equal(a.text, "a");
});

test("captureAnchor: last line has no after, keeps 3 before", () => {
  const a = captureAnchor(lines, "f.ts", "new", lines.length, "ch1");
  assert.deepEqual(a.before, ["e", "f", "g"]);
  assert.deepEqual(a.after, []);
  assert.equal(a.text, "h");
});

test("captureAnchor: short file — every other line fits in context", () => {
  const a = captureAnchor(["x", "y"], "f.ts", "old", 1, "ch1");
  assert.deepEqual(a.before, []);
  assert.deepEqual(a.after, ["y"]);
});

test("captureAnchor: out-of-range line clamps to the file ends", () => {
  assert.equal(captureAnchor(lines, "f.ts", "new", 99, "ch1").text, "h");
  assert.equal(captureAnchor(lines, "f.ts", "new", -3, "ch1").text, "a");
  assert.equal(captureAnchor([], "f.ts", "new", 1, "ch1").text, "");
});

test("captureAnchorFromHunks: sparse rebuild from the side's lines", () => {
  const hunks: Hunk[] = [
    {
      header: "@@ -1,2 +1,2 @@",
      oldStart: 1,
      newStart: 1,
      oldLines: 2,
      newLines: 2,
      lines: [
        { type: "del", oldLine: 1, text: "old one" },
        { type: "add", newLine: 1, text: "new one" },
      ],
    },
  ];
  const newSide = captureAnchorFromHunks(hunks, "a.ts", "new", 1, "ch1");
  assert.equal(newSide.text, "new one");
  assert.deepEqual(newSide.before, []);
  assert.deepEqual(newSide.after, []); // line 2 is outside hunk coverage

  const oldSide = captureAnchorFromHunks(hunks, "a.ts", "old", 1, "ch1");
  assert.equal(oldSide.text, "old one");
});
