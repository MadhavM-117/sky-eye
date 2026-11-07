// Adapter mapping fixtures (spec §20): server JSON in → pierre render input
// out. Shapes transcribed from @pierre/diffs@1.6.4 types/parse output; these
// double as the upgrade smoke test (pierre-packages.md upgrade procedure).
import assert from "node:assert/strict";
import { test } from "node:test";
import { commentAnnotations, fileDiffMetadata, markGlyphSpec, patchText, selectionSide } from "../src/public/pierre-adapter.js";
import type { Comment, Hunk, LineMark } from "../src/types.ts";

// adapter input shape: {path, status} + hunks
const modified = { path: "src/app.ts", status: "modified" } as const;

test("patchText: modified file with ctx/add/del lines", () => {
  const hunks: Hunk[] = [
    {
      header: "@@ -1,3 +1,4 @@",
      oldStart: 1,
      newStart: 1,
      oldLines: 3,
      newLines: 4,
      lines: [
        { type: "ctx", oldLine: 1, newLine: 1, text: "const a = 1;" },
        { type: "del", oldLine: 2, text: "const b = 2;" },
        { type: "add", newLine: 2, text: "const b = 20;" },
        { type: "add", newLine: 3, text: "const c = 3;" },
        { type: "ctx", oldLine: 3, newLine: 4, text: "export { a };" },
      ],
    },
  ];
  assert.equal(
    patchText(modified, hunks),
    [
      "diff --git a/src/app.ts b/src/app.ts",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1,3 +1,4 @@",
      " const a = 1;",
      "-const b = 2;",
      "+const b = 20;",
      "+const c = 3;",
      " export { a };",
      "",
    ].join("\n"),
  );
});

test("patchText: added and deleted files use /dev/null sides + mode lines", () => {
  assert.equal(
    patchText({ path: "new.ts", status: "added" }, [
      { header: "@@ -0,0 +1,1 @@", oldStart: 0, newStart: 1, oldLines: 0, newLines: 1, lines: [{ type: "add", newLine: 1, text: "hi" }] as Hunk["lines"] },
    ]),
    "diff --git a/new.ts b/new.ts\nnew file mode 100644\n--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1,1 @@\n+hi\n",
  );
  assert.equal(
    patchText({ path: "gone.ts", status: "deleted" }, [
      { header: "@@ -1,1 +0,0 @@", oldStart: 1, newStart: 0, oldLines: 1, newLines: 0, lines: [{ type: "del", oldLine: 1, text: "bye" }] as Hunk["lines"] },
    ]),
    "diff --git a/gone.ts b/gone.ts\ndeleted file mode 100644\n--- a/gone.ts\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-bye\n",
  );
});

test("patchText: no hunks → empty (binary chapters render no diff)", () => {
  assert.equal(patchText(modified, []), "");
  assert.equal(fileDiffMetadata(modified, []), null);
});

test("fileDiffMetadata: pierre computes the render metadata (shape per diffs 1.6.4)", () => {
  const hunks: Hunk[] = [
    {
      header: "@@ -1,2 +1,3 @@",
      oldStart: 1,
      newStart: 1,
      oldLines: 2,
      newLines: 3,
      lines: [
        { type: "ctx", oldLine: 1, newLine: 1, text: "a" },
        { type: "del", oldLine: 2, text: "b" },
        { type: "add", newLine: 2, text: "c" },
        { type: "add", newLine: 3, text: "d" },
      ],
    },
  ];
  const meta = fileDiffMetadata(modified, hunks);
  assert.ok(meta);
  assert.equal(meta.name, "src/app.ts");
  assert.equal(meta.type, "change");
  assert.equal(meta.isPartial, true);
  assert.deepEqual(meta.additionLines, ["a\n", "c\n", "d\n"]);
  assert.deepEqual(meta.deletionLines, ["a\n", "b\n"]);
  const h = meta.hunks[0];
  assert.equal(h.additionStart, 1);
  assert.equal(h.deletionStart, 1);
  assert.equal(h.additionLines, 2);
  assert.equal(h.deletionLines, 1);
  assert.deepEqual(h.hunkContent, [
    { type: "context", lines: 1, additionLineIndex: 0, deletionLineIndex: 0 },
    { type: "change", additions: 2, deletions: 1, additionLineIndex: 1, deletionLineIndex: 1 },
  ]);
  assert.equal(meta.splitLineCount, 3);
  assert.equal(meta.unifiedLineCount, 4);
});

test("fileDiffMetadata: added/deleted file types", () => {
  const added = fileDiffMetadata(
    { path: "new.ts", status: "added" },
    [{ header: "@@ -0,0 +1,1 @@", oldStart: 0, newStart: 1, oldLines: 0, newLines: 1, lines: [{ type: "add", newLine: 1, text: "hi" }] as Hunk["lines"] }],
  );
  assert.equal(added?.type, "new");
  const deleted = fileDiffMetadata(
    { path: "gone.ts", status: "deleted" },
    [{ header: "@@ -1,1 +0,0 @@", oldStart: 1, newStart: 0, oldLines: 1, newLines: 0, lines: [{ type: "del", oldLine: 1, text: "bye" }] as Hunk["lines"] }],
  );
  assert.equal(deleted?.type, "deleted");
});

test("selectionSide: pierre deletions/additions → sky-eye old/new", () => {
  assert.equal(selectionSide({ start: 1, end: 2, side: "deletions" }), "old");
  assert.equal(selectionSide({ start: 1, end: 2, side: "additions" }), "new");
  assert.equal(selectionSide({ start: 1, end: 2 }), "new"); // additions is the default side
  // gutter-click props use annotationSide (M2 composer path)
  assert.equal(selectionSide({ annotationSide: "deletions" }), "old");
});

// comment→annotation projection (M2). Comment fixtures only need the fields
// the projection reads.
const comment = (over: Partial<Comment>): Comment => ({
  id: "c1",
  chapterId: "ch1",
  file: "a.ts",
  side: "new",
  line: 3,
  text: "hi",
  createdAt: 1,
  updatedAt: 1,
  author: null,
  resolved: false,
  anchor: { file: "a.ts", side: "new", line: 3, text: "x", before: [], after: [], chapterId: "ch1" },
  ...over,
});

test("commentAnnotations: sides map onto pierre deletions/additions", () => {
  const out = commentAnnotations([
    comment({ line: 3 }),
    comment({ side: "old", line: 2 }),
  ]);
  assert.deepEqual(out, [
    { side: "additions", lineNumber: 3, metadata: { comments: [comment({ line: 3 })], composer: null } },
    { side: "deletions", lineNumber: 2, metadata: { comments: [comment({ side: "old", line: 2 })], composer: null } },
  ]);
});

test("commentAnnotations: multiple comments on one line group into one row", () => {
  const [only] = commentAnnotations([comment({ line: 5 }), comment({ id: "c2", line: 5 })]);
  assert.equal(only.metadata.comments.length, 2);
  assert.equal((only.metadata.comments[1] as Comment).id, "c2");
});

test("commentAnnotations: composer joins the comments on its line (marker entry)", () => {
  const [row] = commentAnnotations([comment({ line: 3 })], { side: "new", line: 3 });
  assert.equal(row.metadata.comments.length, 2);
  assert.deepEqual(row.metadata.comments[1], { composer: true });
  const [solo] = commentAnnotations([], { side: "old", line: 7 });
  assert.deepEqual(solo, {
    side: "deletions",
    lineNumber: 7,
    metadata: { comments: [{ composer: true }], composer: null },
  });
});

test("commentAnnotations: nothing to show → no annotations", () => {
  assert.deepEqual(commentAnnotations([]), []);
});

// mark gutter glyphs (task 009): the pure spec half of markGlyph (the DOM
// half runs in the browser; §20 — pure logic as fixtures)
const mark = (over: Partial<LineMark>): LineMark => ({
  file: "a.ts",
  side: "new",
  line: 3,
  mark: "focus",
  markSource: "rules",
  ...over,
});

test("markGlyphSpec: canonical marks map onto glyph + color var", () => {
  assert.deepEqual(markGlyphSpec(mark({ mark: "focus" })), {
    cls: "focus",
    glyph: "◆",
    color: "var(--mark-focus)",
    title: "focus (rules)",
  });
  assert.equal(markGlyphSpec(mark({ mark: "glance" })).glyph, "▲");
  assert.equal(markGlyphSpec(mark({ mark: "safe" })).glyph, "●");
});

test("markGlyphSpec: custom classifier names → neutral muted dot (§16.5)", () => {
  const spec = markGlyphSpec(mark({ mark: "danger", markSource: "custom" }));
  assert.equal(spec.glyph, "·");
  assert.equal(spec.color, "var(--muted)");
  assert.equal(spec.cls, "danger"); // sanitized class for scoping
  assert.equal(spec.title, "danger (custom)"); // mark name + source on hover
  assert.equal(markGlyphSpec(mark({ mark: "we!rd-name" })).cls, "werd-name");
});
