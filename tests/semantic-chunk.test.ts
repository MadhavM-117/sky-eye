import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_HUNKS,
  buildChapters,
  chunkSystemPrompt,
  chunkUserPrompt,
  groupHunks,
  hunkInventory,
  parseChunkResponse,
  semanticChunk,
} from "../src/semantic-chunk.ts";
import { chunk, chapterId } from "../src/chunker.ts";
import type { FileDiff, Hunk } from "../src/types.ts";

function hunk(
  oldStart: number,
  newStart: number,
  adds: number,
  dels: number,
  header?: string,
): Hunk {
  const lines = [];
  lines.push({ type: "ctx" as const, oldLine: 1, newLine: 1, text: "c" });
  for (let i = 0; i < dels; i++) lines.push({ type: "del" as const, oldLine: 2, text: "-d" });
  for (let i = 0; i < adds; i++) lines.push({ type: "add" as const, newLine: 3, text: "+a" });
  lines.push({ type: "ctx" as const, oldLine: 4, newLine: 4, text: "c" });
  return { header, oldStart, newStart, oldLines: dels + 2, newLines: adds + 2, lines };
}

const withFn = (h: Hunk, fn: string) => ({
  ...h,
  header: `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@ ${fn}`,
});

function file(path: string, hunks: Hunk[], status: "modified" | "added" | "deleted" = "modified"): FileDiff {
  return { path, oldPath: path, status, hunks, binary: false };
}

const CFG = { targetLines: 50, maxLines: 200 };

const okAdapter = (reply: string) => ({ id: "test", call: async () => reply });
const failAdapter = { id: "test", call: async () => { throw new Error("boom"); } };

// ---- inventory -------------------------------------------------------------

test("inventory: path-then-position order, h0… ids, funcname from header", () => {
  const files = [
    file("b.ts", [hunk(1, 10, 2, 0, undefined), withFn(hunk(1, 30, 1, 1), "fn b()")]),
    file("a.ts", [withFn(hunk(1, 1, 1, 0), "fn a()")]),
  ];
  const inv = hunkInventory(files);
  assert.deepEqual(inv.map((e) => `${e.id}:${e.file}`), ["h0:a.ts", "h1:b.ts", "h2:b.ts"]);
  assert.equal(inv[0].funcname, "fn a()");
  assert.equal(inv[1].funcname, null);
  assert.equal(inv[0].changed, 1);
});

test("inventory: binary files skipped, text capped at 40 changed lines", () => {
  const many = Array.from({ length: 50 }, (_, i) => ({
    type: "add" as const,
    newLine: i + 1,
    text: `+line${i}`,
  }));
  const files = [
    file("bin.ts", [hunk(1, 1, 2, 0)], "modified"),
    file("big.ts", [{ header: undefined, oldStart: 1, newStart: 1, oldLines: 0, newLines: 50, lines: many }]),
  ];
  files[0].binary = true;
  const inv = hunkInventory(files);
  assert.equal(inv.length, 1); // binary skipped
  assert.equal(inv[0].id, "h0"); // ids renumbered past the skipped file
  assert.match(inv[0].text, /\(10 more changed lines\)$/);
  assert.equal(inv[0].text.split("\n").length, 41); // 40 lines + elision marker
});

// ---- prompts ----------------------------------------------------------------

test("prompts carry the inventory and the maxLines bound", () => {
  const inv = hunkInventory([file("a.ts", [withFn(hunk(1, 1, 1, 0), "fn a()")])]);
  assert.match(chunkSystemPrompt(), /\{"chapters": /);
  const prompt = chunkUserPrompt(inv, CFG);
  assert.match(prompt, /Max 200 changed lines per chapter/);
  assert.match(prompt, /h0 {2}a\.ts \(modified\) {2}fn a\(\)/);
  assert.match(prompt, /\+a/);
});

// ---- response parsing -------------------------------------------------------

test("parse: valid grouping round-trips; titles trimmed and capped", () => {
  const out = parseChunkResponse(
    '{"chapters":[{"title":"  auth fix  ","hunks":["h0","h2"]},{"title":"","hunks":["h1"]}]}',
    ["h0", "h1", "h2"],
  );
  assert.equal(out[0].title, "auth fix");
  assert.deepEqual(out[0].hunks, ["h0", "h2"]);
  assert.equal(out[1].title, undefined);
  assert.deepEqual(out[1].hunks, ["h1"]);
});

test("parse: unknown ids dropped; malformed JSON / shape throws", () => {
  assert.deepEqual(parseChunkResponse('{"chapters":[{"hunks":["h0","nope"]}]}', ["h0"]).length, 1);
  assert.deepEqual(parseChunkResponse('{"chapters":[{"hunks":["nope"]}]}', ["h0"])[0].hunks, []);
  assert.throws(() => parseChunkResponse("not json", []));
  assert.throws(() => parseChunkResponse('{"nope":1}', ["h0"]));
});

test("groupHunks: duplicate id → first group wins; unknown dropped", () => {
  const files = [file("a.ts", [hunk(1, 1, 1, 0), hunk(10, 10, 1, 0)])];
  const inv = hunkInventory(files);
  const groups = groupHunks(inv, [
    { title: "one", hunks: ["h0"] },
    { title: "two", hunks: ["h0", "h1", "nope"] },
  ]);
  assert.equal(groups[0].hunks.length, 1);
  assert.equal(groups[1].hunks.length, 1); // h0 went to the first group
  assert.equal(groups[1].hunks[0].hunk, inv[1].hunk);
});

// ---- chapter building -------------------------------------------------------

test("buildChapters: slices per file in path order, id formula unchanged", () => {
  const files = [
    file("b.ts", [hunk(1, 10, 2, 0)]),
    file("a.ts", [withFn(hunk(1, 1, 1, 0), "fn a()")]),
  ];
  const inv = hunkInventory(files);
  const chapters = buildChapters(
    files,
    groupHunks(inv, [{ title: "everything", hunks: ["h0", "h1", "h2"] }]),
    CFG,
  );
  assert.equal(chapters.length, 1);
  assert.equal(chapters[0].title, "everything");
  assert.deepEqual(chapters[0].files.map((s) => s.file), ["a.ts", "b.ts"]); // path order
  // id = what the pure formula computes over these slices
  assert.equal(chapters[0].id, chapterId(chapters[0].files));
});

test("buildChapters: oversized group re-split by the pure chunker, ≤ maxLines, title on first", () => {
  // two big hunks, one chapter would be 40 changed lines > maxLines 20
  const cfg = { targetLines: 5, maxLines: 20 };
  const files = [file("a.ts", [hunk(1, 1, 20, 0, undefined), hunk(100, 100, 20, 0, undefined)])];
  const inv = hunkInventory(files);
  const chapters = buildChapters(files, groupHunks(inv, [{ title: "big", hunks: ["h0", "h1"] }]), cfg);
  assert.ok(chapters.length >= 2);
  for (const c of chapters)
    assert.ok(
      c.files.reduce((n, s) => n + s.hunks.reduce((m, h) => m + h.lines.filter((l) => l.type !== "ctx").length, 0), 0) <= cfg.maxLines,
    );
  assert.equal(chapters[0].title, "big");
  assert.equal(chapters[1].title, undefined);
  // never split a hunk: the re-split keeps whole hunks
  assert.deepEqual(chapters.map((c) => c.files[0].hunks.length).sort(), [1, 1]);
});

test("buildChapters: leftovers appended via pure chunker; empty groups skipped", () => {
  const files = [file("a.ts", [hunk(1, 1, 1, 0), hunk(50, 50, 1, 0), hunk(100, 100, 1, 0)])];
  const inv = hunkInventory(files);
  const chapters = buildChapters(files, groupHunks(inv, [{ title: "x", hunks: ["h0"] }, { hunks: [] }]), CFG);
  // both leftovers are untitled pure-chunked chapters (the >30-line gap
  // between h1 and h2 splits them, §8.2 distance rule)
  assert.equal(chapters.length, 3);
  assert.equal(chapters[0].title, "x");
  assert.ok(chapters.slice(1).every((c) => c.title === undefined));
  const leftoverHunks = chapters.slice(1).flatMap((c) => c.files[0].hunks).length;
  assert.equal(leftoverHunks, 2);
});

test("buildChapters: no groups at all → identical to the pure chunker", () => {
  const files = [file("a.ts", [hunk(1, 1, 1, 0), hunk(50, 50, 1, 0)])];
  const chapters = buildChapters(files, [], CFG);
  assert.deepEqual(chapters.map((c) => c.id), chunk(files, CFG).map((c) => c.id));
});

// ---- orchestration ----------------------------------------------------------

test("semanticChunk: happy path", async () => {
  const files = [file("a.ts", [withFn(hunk(1, 1, 1, 0), "fn a()")])];
  const chapters = await semanticChunk(
    okAdapter('{"chapters":[{"title":"t","hunks":["h0"]}]}'),
    files,
    CFG,
  );
  assert.equal(chapters?.length, 1);
  assert.equal(chapters?.[0].title, "t");
});

test("semanticChunk: failed or malformed call → undefined (pure chunker fallback)", async () => {
  const files = [file("a.ts", [hunk(1, 1, 1, 0)])];
  assert.equal(await semanticChunk(failAdapter, files, CFG), undefined);
  assert.equal(await semanticChunk(okAdapter("garbage"), files, CFG), undefined);
  // empty diff → nothing to group
  assert.equal(await semanticChunk(okAdapter('{"chapters":[]}'), [], CFG), undefined);
});

test("semanticChunk: oversized inventory circuit-breaks before the call", async () => {
  const big = Array.from({ length: MAX_HUNKS + 1 }, (_, i) =>
    file(`f${i}.ts`, [hunk(1, 1, 1, 0)]),
  );
  let called = false;
  const spy = { id: "spy", call: async () => { called = true; return "{}"; } };
  assert.equal(await semanticChunk(spy, big, CFG), undefined);
  assert.equal(called, false);
});
