import test from "node:test";
import assert from "node:assert/strict";
import { parseUnifiedDiff, diffDigest } from "../src/diff.ts";

const TWO_FILE = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 existing
+added line
 unchanged
 unchanged
@@ -10,2 +11,2 @@ function foo()
 old one
-old two
+new two
diff --git a/README.md b/README.md
index 333..444 100644
--- a/README.md
+++ b/README.md
@@ -1 +1 @@
-hello
+hi
`;

test("parses two files with line numbers", () => {
  const files = parseUnifiedDiff(TWO_FILE);
  assert.equal(files.length, 2);
  const [a, b] = files;
  assert.equal(a.path, "src/a.ts");
  assert.equal(a.oldPath, "src/a.ts");
  assert.equal(a.status, "modified");
  assert.equal(a.hunks.length, 2);

  const [h1, h2] = a.hunks;
  assert.equal(h1.oldStart, 1);
  assert.equal(h1.newStart, 1);
  assert.deepEqual(h1.lines[1], { type: "add", newLine: 2, text: "added line" });
  assert.equal(h1.lines[0].oldLine, 1);
  assert.equal(h1.lines[0].newLine, 1);
  // second hunk carries funcname context
  assert.ok(h2.header?.includes("function foo()"));
  assert.equal(h2.oldStart, 10);
  assert.equal(h2.lines.length, 3); // ctx, del, add

  assert.equal(b.path, "README.md");
});

test("line counters run within a hunk", () => {
  const files = parseUnifiedDiff(TWO_FILE);
  const h2 = files[0].hunks[1];
  // ctx(old 10) del(old 11) ctx(old 12)... add on new side
  assert.equal(h2.lines[0].oldLine, 10);
  assert.equal(h2.lines[0].newLine, 11);
  assert.equal(h2.lines[1].type, "del");
  assert.equal(h2.lines[1].oldLine, 11);
  assert.equal(h2.lines[1].newLine, undefined);
  assert.equal(h2.lines[2].type, "add");
  assert.equal(h2.lines[2].oldLine, undefined);
  assert.equal(h2.lines[2].newLine, 12);
});

const DELETED = `diff --git a/gone.txt b/gone.txt
deleted file mode 100644
index 555..000
--- a/gone.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-first
-second
`;

test("deleted file: path falls back to old side", () => {
  const [f] = parseUnifiedDiff(DELETED);
  assert.equal(f.status, "deleted");
  assert.equal(f.path, "gone.txt");
  assert.equal(f.oldPath, "gone.txt");
  assert.notEqual(f.path, "/dev/null");
});

const ADDED = `diff --git a/new.txt b/new.txt
new file mode 100644
index 000..666
--- /dev/null
+++ b/new.txt
@@ -0,0 +1 @@
+fresh
`;

test("added file: status added", () => {
  const [f] = parseUnifiedDiff(ADDED);
  assert.equal(f.status, "added");
  assert.equal(f.path, "new.txt");
  assert.equal(f.oldPath, "/dev/null");
  assert.equal(f.hunks[0].oldStart, 0);
  assert.equal(f.hunks[0].lines[0].newLine, 1);
});

const BINARY = `diff --git a/img.png b/img.png
index 777..888 100644
Binary files a/img.png and b/img.png differ
`;

test("binary file: no hunks, binary flag", () => {
  const [f] = parseUnifiedDiff(BINARY);
  assert.equal(f.binary, true);
  assert.deepEqual(f.hunks, []);
});

const NO_EOL = `diff --git a/x.txt b/x.txt
index 999..aaa 100644
--- a/x.txt
+++ b/x.txt
@@ -1 +1 @@
-old
+new
\\ No newline at end of file
`;

test("no-newline-at-EOF marker is skipped", () => {
  const [f] = parseUnifiedDiff(NO_EOL);
  assert.equal(f.hunks[0].lines.length, 2);
  assert.equal(f.hunks[0].lines[1].text, "new");
});

test("hunk without funcname parses", () => {
  const files = parseUnifiedDiff(NO_EOL);
  assert.equal(files[0].hunks[0].header, "@@ -1 +1 @@");
  assert.equal(files[0].hunks[0].oldLines, 1);
  assert.equal(files[0].hunks[0].newLines, 1);
});

test("empty diff → no files", () => {
  assert.deepEqual(parseUnifiedDiff(""), []);
});

test("digest is deterministic", () => {
  assert.equal(diffDigest("abc"), diffDigest("abc"));
  assert.notEqual(diffDigest("abc"), diffDigest("abd"));
});
