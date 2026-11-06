import test from "node:test";
import assert from "node:assert/strict";
import { chunk, chapterId, changedLines, loadConfig } from "../src/chunker.ts";
import type { FileDiff, Hunk } from "../src/types.ts";

function hunk(oldStart: number, newStart: number, adds: number, dels: number, ctx = 1): Hunk {
  const lines = [];
  for (let i = 0; i < ctx; i++) lines.push({ type: "ctx" as const, oldLine: 1, newLine: 1, text: "c" });
  for (let i = 0; i < dels; i++) lines.push({ type: "del" as const, oldLine: 2, text: "-d" });
  for (let i = 0; i < adds; i++) lines.push({ type: "add" as const, newLine: 3, text: "+a" });
  for (let i = 0; i < ctx; i++) lines.push({ type: "ctx" as const, oldLine: 4, newLine: 4, text: "c" });
  return { oldStart, newStart, oldLines: dels + ctx * 2, newLines: adds + ctx * 2, lines };
}

function file(path: string, hunks: Hunk[], status: "modified" | "added" | "deleted" = "modified"): FileDiff {
  return { path, oldPath: path, status, hunks, binary: false };
}

const CFG = { targetLines: 10, maxLines: 200 };

test("splits at target size", () => {
  const chapters = chunk([file("a.ts", [hunk(1, 1, 6, 0), hunk(20, 20, 6, 0)])], CFG);
  // 6 changed lines each; together 12 > target 10 → two chapters
  assert.equal(chapters.length, 2);
});

test("small hunks in one file stay together", () => {
  const chapters = chunk([file("a.ts", [hunk(1, 1, 3, 0), hunk(10, 10, 3, 0)])], CFG);
  assert.equal(chapters.length, 1);
  assert.equal(chapters[0].hunks.length, 2);
});

test("each chapter covers a single file", () => {
  const chapters = chunk(
    [file("a.ts", [hunk(1, 1, 3, 0)]), file("b.ts", [hunk(1, 1, 3, 0)])],
    CFG,
  );
  assert.equal(chapters.length, 2);
  assert.deepEqual(chapters.map((c) => c.file), ["a.ts", "b.ts"]);
});

test("oversized single hunk stays one chapter (never split a hunk)", () => {
  const big = hunk(1, 1, 500, 0);
  const [c] = chunk([file("a.ts", [big])], CFG);
  assert.equal(c.hunks.length, 1);
  assert.ok(changedLines(c.hunks[0]) > CFG.maxLines);
});

test("chapter ids are stable and unique per range", () => {
  const a = chapterId("a.ts", hunk(1, 1, 1, 0));
  const b = chapterId("a.ts", hunk(1, 1, 1, 0));
  const c = chapterId("a.ts", hunk(5, 5, 1, 0));
  const d = chapterId("b.ts", hunk(1, 1, 1, 0));
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.notEqual(a, d);
  assert.match(a, /^[0-9a-f]{12}$/);
});

test("pure-deletion chapters get unique ids", () => {
  // newStart=0,newLines=0 still unique via oldStart/oldLines
  const a = chapterId("a.ts", hunk(10, 0, 0, 5));
  const b = chapterId("a.ts", hunk(20, 0, 0, 5));
  assert.notEqual(a, b);
});

test("deleted file chapters carry the file path", () => {
  const chapters = chunk([file("gone.txt", [hunk(1, 0, 0, 2)], "deleted")], CFG);
  assert.equal(chapters[0].file, "gone.txt");
  assert.equal(chapters[0].status, "deleted");
});

test("binary files produce no chapters", () => {
  const chapters = chunk([{ ...file("x.png", []), binary: true }], CFG);
  assert.deepEqual(chapters, []);
});

test("empty diff → no chapters", () => {
  assert.deepEqual(chunk([], CFG), []);
});

test("chapters are ordered by path", () => {
  const chapters = chunk(
    [file("z.ts", [hunk(1, 1, 1, 0)]), file("a.ts", [hunk(1, 1, 1, 0)])],
    CFG,
  );
  assert.deepEqual(chapters.map((c) => c.file), ["a.ts", "z.ts"]);
});

test("loadConfig falls back to defaults", () => {
  assert.deepEqual(loadConfig("/nonexistent-root"), { targetLines: 75, maxLines: 200 });
});
