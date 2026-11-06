// Adapter mapping fixtures (spec §20): server JSON in → pierre render input
// out. Shapes transcribed from @pierre/diffs@1.6.4 types/parse output; these
// double as the upgrade smoke test (pierre-packages.md upgrade procedure).
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileDiffMetadata, patchText, selectionSide } from "../src/public/pierre-adapter.js";
import type { Hunk } from "../src/types.ts";

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
});
