import test from "node:test";
import assert from "node:assert/strict";
import { classifyChapter, classifySlice, withAttention } from "../src/classify.ts";
import type { Chapter, DiffLineType, FileSlice, Hunk } from "../src/types.ts";

const hunk = (lines: [DiffLineType, string | undefined, string][]): Hunk => ({
  // tuple: [type, line number (old or new), text]
  oldStart: 1,
  newStart: 1,
  oldLines: lines.length,
  newLines: lines.length,
  lines: lines.map(([type, oldLine, text]) =>
    type === "ctx"
      ? { type, oldLine: Number(oldLine), newLine: Number(oldLine), text }
      : type === "add"
        ? { type, newLine: Number(oldLine), text }
        : { type, oldLine: Number(oldLine), text },
  ),
});

const slice = (file: string, h: Hunk): FileSlice => ({ file, status: "modified", hunks: [h] });

test("safe paths: tests, lockfiles, docs, generated", () => {
  for (const path of [
    "tests/auth.test.ts",
    "src/login.spec.ts",
    "src/__tests__/util.ts",
    "package-lock.json",
    "Cargo.lock",
    "pnpm-lock.yaml",
    "README.md",
    "dist/bundle.min.js",
    "web/dist/app.js",
  ]) {
    const marks = classifySlice(slice(path, hunk([["add", "1", "await fetch('/x')"]])));
    assert.equal(marks[0].mark, "safe", path);
    assert.equal(marks[0].markSource, "rules");
  }
});

test("focus paths: auth/, payment, token, secret", () => {
  for (const path of ["src/auth/login.ts", "lib/payment.ts", "src/token.ts", "my-secrets.txt"]) {
    const marks = classifySlice(slice(path, hunk([["add", "3", "return value;"]])));
    assert.equal(marks[0].mark, "focus", path);
  }
});

test("focus keywords: async/error/crypto/permission/SQL", () => {
  for (const text of [
    "await save()",
    "async function go()",
    "try {",
    "} catch (e) {",
    "throw new Error()",
    "password = hash(pw)",
    "SELECT * FROM users",
    "GRANT read ON t",
  ]) {
    const marks = classifySlice(slice("src/plain.ts", hunk([["add", "1", text]])));
    assert.equal(marks[0].mark, "focus", text);
  }
});

test("comment-only lines are safe, even in focus paths", () => {
  for (const text of ["// TODO", "# comment", "/* block", " * doc", "<!-- note -->"]) {
    const marks = classifySlice(slice("src/auth/login.ts", hunk([["add", "1", text]])));
    assert.equal(marks[0].mark, "safe", text);
  }
});

test("everything else is glance", () => {
  const marks = classifySlice(slice("src/plain.ts", hunk([["add", "1", "const x = compute(y);"]])));
  assert.equal(marks[0].mark, "glance");
});

test("side/line mapping: add→new, del→old, ctx skipped; file carried", () => {
  const marks = classifySlice(
    slice("src/a.ts", hunk([
      ["ctx", "1", "unchanged"],
      ["del", "2", "old line"],
      ["add", "5", "new line"],
    ])),
  );
  assert.deepEqual(
    marks.map((m) => [m.side, m.line, m.file]),
    [["old", 2, "src/a.ts"], ["new", 5, "src/a.ts"]],
  );
});

test("classifyChapter fills attention across all slices; withAttention copies", () => {
  const chapter: Chapter = {
    id: "abc",
    files: [
      slice("src/auth/x.ts", hunk([["add", "1", "await token();"]])),
      slice("tests/y.test.ts", hunk([["add", "1", "expect(1)"]])),
    ],
    narrative: "unanalyzed",
    attention: [],
  };
  const filled = withAttention(chapter);
  assert.equal(filled.attention.length, 2);
  assert.equal(filled.attention[0].mark, "focus");
  assert.equal(filled.attention[1].mark, "safe");
  assert.equal(chapter.attention.length, 0); // original untouched
});
