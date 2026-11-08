import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ClassifierError,
  classifierRequest,
  loadClassifierConfig,
  loadClassifyRules,
  parseClassifierResponse,
} from "../src/custom-classifier.ts";
import type { Chapter, FileSlice, Hunk } from "../src/types.ts";

// temp repo with a .sky-watch/config.json
const withConfig = (body: unknown): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cl-"));
  fs.mkdirSync(path.join(dir, ".sky-watch"), { recursive: true });
  if (body !== null)
    fs.writeFileSync(path.join(dir, ".sky-watch", "config.json"), JSON.stringify(body));
  return dir;
};

const hunk: Hunk = {
  oldStart: 1,
  newStart: 1,
  oldLines: 3,
  newLines: 3,
  lines: [
    { type: "ctx", oldLine: 1, newLine: 1, text: "same" },
    { type: "del", oldLine: 2, text: "old line" },
    { type: "add", newLine: 2, text: "new line" },
  ],
};

const slice = (file: string): FileSlice => ({ file, status: "modified", hunks: [hunk] });
const chapter: Chapter = { id: "c1", files: [slice("src/a.ts")], narrative: "", attention: [] };

test("request carries only changed lines, with side + text", () => {
  const req = JSON.parse(classifierRequest("/repo", "b1", "h1", [chapter]));
  assert.equal(req.protocol, 1);
  assert.equal(req.repo, "/repo");
  assert.equal(req.base, "b1");
  assert.equal(req.head, "h1");
  const lines = req.chapters[0].files[0].hunks[0].lines;
  assert.deepEqual(lines, [
    { type: "del", side: "old", line: 2, text: "old line" },
    { type: "add", side: "new", line: 2, text: "new line" },
  ]);
});

test("request carries the semantic chapter title (§8a), omitted when absent", () => {
  const titled: Chapter = { ...chapter, title: "auth fix" };
  const req = JSON.parse(classifierRequest("/repo", "b1", "h1", [titled, chapter]));
  assert.equal(req.chapters[0].title, "auth fix");
  assert.equal("title" in req.chapters[1], false);
});

test("response parser: valid, sparse, unknown mark kept", () => {
  const expected = new Set(["src/a.ts\0old:2", "src/a.ts\0new:2"]);
  const raw = JSON.stringify({
    marks: [
      { file: "src/a.ts", side: "new", line: 2, mark: "focus" },
      { file: "src/a.ts", side: "new", line: 2, mark: "hotspot" }, // extensible name
    ],
  });
  const marks = parseClassifierResponse(raw, expected);
  assert.deepEqual(
    marks.map((m) => [m.mark, m.markSource]),
    [["focus", "custom"], ["hotspot", "custom"]],
  );
  assert.deepEqual(
    marks.map((m) => [m.file, m.side, m.line]),
    [["src/a.ts", "new", 2], ["src/a.ts", "new", 2]],
  );
});

test("response parser: invalid entries dropped, never fatal", () => {
  const expected = new Set(["src/a.ts\0new:2"]);
  const raw = JSON.stringify({
    marks: [
      { file: "unknown.ts", side: "new", line: 2, mark: "focus" }, // not sent
      { file: "src/a.ts", side: "old", line: 2, mark: "focus" }, // old:2 not in expected
      { file: "src/a.ts", side: "new", line: 2, mark: "UPPER" }, // bad name
      { file: "src/a.ts", side: "new", line: 2, mark: "focus" }, // valid
      { file: "src/a.ts", side: "new", line: 2 }, // missing mark
      "garbage",
    ],
  });
  assert.deepEqual(
    parseClassifierResponse(raw, expected).map((m) => m.mark),
    ["focus"],
  );
});

test("response parser: structurally invalid output throws", () => {
  const expected = new Set<string>();
  assert.throws(() => parseClassifierResponse("not json", expected), ClassifierError);
  assert.throws(() => parseClassifierResponse(JSON.stringify({ no: "marks" }), expected), ClassifierError);
  assert.throws(() => parseClassifierResponse(JSON.stringify({ marks: "nope" }), expected), ClassifierError);
});

test("loadClassifierConfig: missing/invalid → undefined, defaults filled", () => {
  assert.equal(loadClassifierConfig(withConfig({})), undefined);
  assert.equal(loadClassifierConfig(withConfig({ classifier: {} })), undefined);
  assert.equal(loadClassifierConfig(withConfig(null)), undefined);
  const good = loadClassifierConfig(
    withConfig({ classifier: { command: "my-cl" }, classifyRules: { safePaths: ["vendor/*"] } }),
  );
  assert.deepEqual(good, { command: "my-cl", timeoutMs: 30000, fallback: true, debug: false });
  const custom = loadClassifierConfig(
    withConfig({ classifier: { command: "x", timeoutMs: 500, fallback: false, debug: true } }),
  );
  assert.deepEqual(custom, { command: "x", timeoutMs: 500, fallback: false, debug: true });
});

test("loadClassifyRules: globs validated, junk dropped", () => {
  assert.equal(loadClassifyRules(withConfig({ classifyRules: { safePaths: "no" } })), undefined);
  assert.deepEqual(
    loadClassifyRules(withConfig({ classifyRules: { focusPaths: ["a/*", 3, "b*"] } })),
    { focusPaths: ["a/*", "b*"] },
  );
});
