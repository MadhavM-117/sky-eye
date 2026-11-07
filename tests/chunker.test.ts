import test from "node:test";
import assert from "node:assert/strict";
import { chunk, chapterId, changedLines, loadConfig } from "../src/chunker.ts";
import type { FileDiff, Hunk } from "../src/types.ts";

function hunk(
  oldStart: number,
  newStart: number,
  adds: number,
  dels: number,
  ctx = 1,
  header?: string,
): Hunk {
  const lines = [];
  for (let i = 0; i < ctx; i++) lines.push({ type: "ctx" as const, oldLine: 1, newLine: 1, text: "c" });
  for (let i = 0; i < dels; i++) lines.push({ type: "del" as const, oldLine: 2, text: "-d" });
  for (let i = 0; i < adds; i++) lines.push({ type: "add" as const, newLine: 3, text: "+a" });
  for (let i = 0; i < ctx; i++) lines.push({ type: "ctx" as const, oldLine: 4, newLine: 4, text: "c" });
  return { header, oldStart, newStart, oldLines: dels + ctx * 2, newLines: adds + ctx * 2, lines };
}

const withFn = (h: Hunk, fn: string) => ({
  ...h,
  header: `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@ ${fn}`,
});

const funcOf = (h: Hunk) => {
  const m = h.header?.match(/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@ ?(.*)$/);
  return m && m[1] ? m[1] : null;
};

function file(path: string, hunks: Hunk[], status: "modified" | "added" | "deleted" = "modified"): FileDiff {
  return { path, oldPath: path, status, hunks, binary: false };
}

const sliceId = (file: string, h: Hunk) => chapterId([{ file, hunks: [h] }]);

const CFG = { targetLines: 10, maxLines: 200 };

test("splits at target size", () => {
  const chapters = chunk([file("a.ts", [hunk(1, 1, 6, 0), hunk(20, 20, 6, 0)])], CFG);
  // 6 changed lines each; together 12 > target 10 → two chapters
  assert.equal(chapters.length, 2);
});

test("small hunks in one file stay together", () => {
  const chapters = chunk([file("a.ts", [hunk(1, 1, 3, 0), hunk(10, 10, 3, 0)])], CFG);
  assert.equal(chapters.length, 1);
  assert.equal(chapters[0].files[0].hunks.length, 2);
});

test("small adjacent files merge into one chapter (no file-boundary rule)", () => {
  const chapters = chunk(
    [file("a.ts", [hunk(1, 1, 3, 0)]), file("b.ts", [hunk(1, 1, 3, 0)])],
    CFG,
  );
  assert.equal(chapters.length, 1);
  assert.deepEqual(chapters[0].files.map((s) => s.file), ["a.ts", "b.ts"]);
  assert.deepEqual(chapters[0].files.map((s) => s.hunks.length), [1, 1]);
});

test("files merge only within the size target", () => {
  // 6 + 6 > target 10 → chapter boundary between the files
  const chapters = chunk(
    [file("a.ts", [hunk(1, 1, 6, 0)]), file("b.ts", [hunk(1, 1, 6, 0)])],
    CFG,
  );
  assert.equal(chapters.length, 2);
  assert.deepEqual(chapters.map((c) => c.files[0].file), ["a.ts", "b.ts"]);
});

test("a file appears at most once per chapter (one contiguous slice)", () => {
  // a.ts hunk 1 + b.ts + a.ts hunk 2: path order interleaves? No — path order
  // groups a.ts's hunks first, so a chapter is [a.ts both, b.ts]
  const chapters = chunk(
    [
      file("a.ts", [hunk(1, 1, 3, 0), hunk(5, 5, 3, 0)]),
      file("b.ts", [hunk(1, 1, 3, 0)]),
    ],
    CFG,
  );
  assert.equal(chapters.length, 1);
  assert.deepEqual(chapters[0].files.map((s) => s.file), ["a.ts", "b.ts"]);
});

test("slices carry their file's status", () => {
  const chapters = chunk(
    [file("a.ts", [hunk(1, 1, 3, 0)]), file("new.md", [hunk(1, 1, 2, 0)], "added")],
    CFG,
  );
  assert.equal(chapters.length, 1);
  assert.equal(chapters[0].files[1].status, "added");
});

test("oversized single hunk stays one chapter (never split a hunk)", () => {
  const big = hunk(1, 1, 500, 0);
  const [c] = chunk([file("a.ts", [big])], CFG);
  assert.equal(c.files[0].hunks.length, 1);
  assert.ok(changedLines(c.files[0].hunks[0]) > CFG.maxLines);
});

test("chapter ids are stable and unique per slice set", () => {
  const a = sliceId("a.ts", hunk(1, 1, 1, 0));
  const b = sliceId("a.ts", hunk(1, 1, 1, 0));
  const c = sliceId("a.ts", hunk(5, 5, 1, 0));
  const d = sliceId("b.ts", hunk(1, 1, 1, 0));
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.notEqual(a, d);
  assert.match(a, /^[0-9a-f]{12}$/);
});

test("multi-file chapter ids hash all slices", () => {
  const h1 = hunk(1, 1, 1, 0);
  const h2 = hunk(1, 1, 1, 0);
  const single = chapterId([{ file: "a.ts", hunks: [h1] }]);
  const multi = chapterId([
    { file: "a.ts", hunks: [h1] },
    { file: "b.ts", hunks: [h2] },
  ]);
  assert.notEqual(single, multi);
  // stable under re-chunking the same diff
  const [merged] = chunk([file("a.ts", [h1]), file("b.ts", [h2])], CFG);
  assert.equal(merged.id, multi);
  assert.match(multi, /^[0-9a-f]{12}$/);
});

test("pure-deletion chapters get unique ids", () => {
  // newStart=0,newLines=0 still unique via oldStart/oldLines
  const a = sliceId("a.ts", hunk(10, 0, 0, 5));
  const b = sliceId("a.ts", hunk(20, 0, 0, 5));
  assert.notEqual(a, b);
});

test("deleted file slices carry the file path and status", () => {
  const chapters = chunk([file("gone.txt", [hunk(1, 0, 0, 2)], "deleted")], CFG);
  assert.equal(chapters[0].files[0].file, "gone.txt");
  assert.equal(chapters[0].files[0].status, "deleted");
});

test("binary files produce no chapters", () => {
  const chapters = chunk([{ ...file("x.png", []), binary: true }], CFG);
  assert.deepEqual(chapters, []);
});

test("empty diff → no chapters", () => {
  assert.deepEqual(chunk([], CFG), []);
});

test("chapters are ordered by path", () => {
  // 6+6 > target 1 forces one chapter per file despite the merge rule
  const chapters = chunk(
    [file("z.ts", [hunk(1, 1, 6, 0)]), file("a.ts", [hunk(1, 1, 6, 0)])],
    { targetLines: 1, maxLines: 200 },
  );
  assert.equal(chapters.length, 2);
  assert.deepEqual(chapters.map((c) => c.files[0].file), ["a.ts", "z.ts"]);
});

test("funcOf extracts git/jj funcname context", () => {
  assert.equal(funcOf(withFn(hunk(1, 1, 1, 0), "fn a() {")), "fn a() {");
  assert.equal(funcOf(withFn(hunk(1, 1, 1, 0), "static void main(...)")), "static void main(...)");
  assert.equal(funcOf(hunk(1, 1, 1, 0)), null);
});

test("function context change splits even small hunks (§8.2)", () => {
  const chapters = chunk(
    [file("a.ts", [withFn(hunk(1, 1, 3, 0), "fn a() {"), withFn(hunk(10, 10, 3, 0), "fn b() {")])],
    CFG,
  );
  assert.equal(chapters.length, 2);
});

test("same function context keeps together past targetLines (§8.4)", () => {
  // 30 + 30 changed lines, target 10, max 200 → one chapter
  const chapters = chunk(
    [file("a.ts", [withFn(hunk(1, 1, 30, 0), "fn a() {"), withFn(hunk(100, 100, 30, 0), "fn a() {")])],
    CFG,
  );
  assert.equal(chapters.length, 1);
  assert.equal(chapters[0].files[0].hunks.length, 2);
});

test("keep-together stops at the maxLines hard max (§8.4)", () => {
  // three 80-line hunks in one function: 160 fits max 200, 240 does not
  const chapters = chunk(
    [file("a.ts", [
      withFn(hunk(1, 1, 80, 0), "fn a() {"),
      withFn(hunk(200, 200, 80, 0), "fn a() {"),
      withFn(hunk(400, 400, 80, 0), "fn a() {"),
    ])],
    CFG,
  );
  assert.equal(chapters.length, 2);
  assert.equal(changedLines(chapters[0].files[0].hunks[1]), 80);
});

test("identical funcnames in different files do not keep-together", () => {
  // keep-together is keyed on (file, funcname); across files only the size
  // rule applies — 3+3 ≤ target 10 merges, but 30+30 > target splits
  const a = withFn(hunk(1, 1, 30, 0), "fn a() {");
  const b = withFn(hunk(1, 1, 30, 0), "fn a() {");
  const chapters = chunk([file("a.ts", [a]), file("b.ts", [b])], CFG);
  assert.equal(chapters.length, 2);
});

test("distance fallback splits far-apart context-less hunks (§8.2)", () => {
  // no header; 40 unchanged lines between hunks → split despite tiny size
  const chapters = chunk(
    [file("a.ts", [hunk(1, 1, 2, 0), hunk(45, 45, 2, 0)])],
    CFG,
  );
  assert.equal(chapters.length, 2);
});

test("no context: targetLines still splits (keep-together needs a context)", () => {
  const chapters = chunk([file("a.ts", [hunk(1, 1, 6, 0), hunk(10, 10, 6, 0)])], CFG);
  assert.equal(chapters.length, 2);
});

test("loadConfig falls back to defaults", () => {
  assert.deepEqual(loadConfig("/nonexistent-root"), { targetLines: 75, maxLines: 200 });
});
