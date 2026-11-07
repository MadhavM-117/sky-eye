import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  NarrateError,
  applyLlmMarks,
  chapterDiffText,
  chapterTitle,
  narrateUserPrompt,
  parseLlmResponse,
  rerunAll,
  rerunChapter,
  sharedSystemPrompt,
} from "../src/narrate.ts";
import { ApiError } from "../src/cli.ts";
import type { Chapter, LlmRequest, Session } from "../src/types.ts";

const hunk = (newStart: number, lines: { type: "ctx" | "add" | "del"; text: string }[]) => ({
  oldStart: newStart,
  newStart,
  oldLines: lines.length,
  newLines: lines.length,
  header: `@@ -${newStart},${lines.length} +${newStart},${lines.length} @@ fn a() {`,
  lines: lines.map((l, i) => ({
    type: l.type,
    oldLine: l.type === "add" ? undefined : newStart + i,
    newLine: l.type === "del" ? undefined : newStart + i,
    text: l.text,
  })),
});

const slice = (file: string, status: "modified" | "added" | "deleted", hunks: ReturnType<typeof hunk>[]) => ({
  file,
  status,
  hunks,
});

const chapter: Chapter = {
  id: "abc123",
  files: [
    slice("src/a.ts", "modified", [
      hunk(10, [
        { type: "ctx", text: "before" },
        { type: "del", text: "old" },
        { type: "add", text: "new" },
        { type: "ctx", text: "after" },
      ]),
    ]),
    slice("src/b.ts", "added", [
      hunk(1, [{ type: "add", text: "brand new" }]),
    ]),
  ],
  narrative: "unanalyzed",
  attention: [
    { file: "src/a.ts", side: "new", line: 11, mark: "glance", markSource: "rules" },
    { file: "src/a.ts", side: "new", line: 12, mark: "safe", markSource: "custom" },
  ],
};

const session = (): Session => ({
  id: "abc..def",
  base: "b",
  head: "h",
  diffDigest: "d",
  aliases: [],
  createdAt: 1,
  updatedAt: 1,
  lastWriteAt: 1,
  meta: { repo: "/tmp/x" },
  reviewed: false,
  // deep copy: rerunChapter mutates chapters in place — tests must not share
  // state through the module-level fixture
  chapters: [structuredClone(chapter), { ...structuredClone(chapter), id: "other", files: [slice("src/c.ts", "modified", [])], narrative: "other chapter" }],
  comments: [],
});

test("chapterDiffText: all slices, context band from head content, no band for deleted", () => {
  const heads = new Map([
    ["src/a.ts", "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nbefore\nafter\nzz\n"],
    ["src/c.ts", "x\n"],
  ]);
  const del = (f: string): Chapter["files"][number] => ({ file: f, status: "deleted", hunks: [hunk(1, [{ type: "del", text: "gone" }])] });
  const text = chapterDiffText({ ...chapter, files: [...chapter.files, del("src/gone.ts")] }, heads);
  assert.match(text, /src\/a\.ts \(modified\)/);
  assert.match(text, /src\/b\.ts \(added\)/);
  assert.match(text, /src\/gone\.ts \(deleted\)/);
  assert.match(text, /fn a\(\) \{/); // funcname header kept
  assert.match(text, / l1\n/); // ~10 lines of new-side context above
  assert.match(text, /-old/);
  assert.match(text, /\+new/);
  assert.match(text, / after\n/);
  assert.doesNotMatch(text, /zz/); // band stays ±10 lines around the hunk
  assert.doesNotMatch(text, /src\/gone\.ts[\s\S]*? l1/);
});

test("narrate prompt: file paths, other chapter titles, never the chapter itself", () => {
  const prompt = narrateUserPrompt(chapter, [chapterTitle(session().chapters[1])], chapterDiffText(chapter, new Map()));
  assert.match(prompt, /src\/a\.ts/);
  assert.match(prompt, /src\/c\.ts/);
  assert.doesNotMatch(prompt, /chapterDiffText placeholder/);
  assert.match(sharedSystemPrompt(), /JSON/);
});

test("parseLlmResponse: shared needs a narrative; marks validated per entry", () => {
  const good = parseLlmResponse(
    JSON.stringify({ narrative: "N", marks: [
      { file: "src/a.ts", side: "new", line: 11, mark: "focus" },
      { file: "src/a.ts", side: "bad", line: 11, mark: "focus" },
      { file: "src/a.ts", side: "new", line: "11", mark: "focus" }, // non-number line dropped
      { file: "src/a.ts", side: "new", line: 11, mark: "BAD NAME" },
    ] }),
    "shared",
  );
  assert.equal(good.narrative, "N");
  assert.equal(good.marks.length, 1); // invalid entries dropped
  assert.throws(() => parseLlmResponse("{}", "shared"), NarrateError);
  assert.throws(() => parseLlmResponse("not json", "shared"), NarrateError);
  assert.throws(() => parseLlmResponse(JSON.stringify({ narrative: "N" }), "classify"), NarrateError);
  assert.deepEqual(parseLlmResponse(JSON.stringify({ marks: [] }), "classify").marks, []);
});

test("applyLlmMarks: overwrites rules only; custom and llm protected; unknown coords dropped", () => {
  const ch: Chapter = {
    ...chapter,
    attention: [
      { file: "src/a.ts", side: "new", line: 11, mark: "glance", markSource: "rules" },
      { file: "src/a.ts", side: "new", line: 12, mark: "safe", markSource: "custom" },
      { file: "src/a.ts", side: "new", line: 13, mark: "focus", markSource: "llm" },
    ],
  };
  applyLlmMarks(ch, [
    { file: "src/a.ts", side: "new", line: 11, mark: "focus" },
    { file: "src/a.ts", side: "new", line: 12, mark: "safe" }, // custom → ignored
    { file: "src/a.ts", side: "new", line: 13, mark: "glance" }, // llm → ignored
    { file: "src/a.ts", side: "new", line: 99, mark: "focus" }, // no mark → ignored
  ]);
  assert.equal(ch.attention[0].mark, "focus");
  assert.equal(ch.attention[0].markSource, "llm");
  assert.equal(ch.attention[1].markSource, "custom");
  assert.equal(ch.attention[2].mark, "focus");
});

const adapter = (id: string, reply: (req: LlmRequest) => string) => ({
  id,
  call: async (req: LlmRequest) => {
    const out = reply(req);
    if (out === "!") throw new Error("down");
    return out;
  },
});

const root = () => fs.mkdtempSync(path.join(os.tmpdir(), "nar-"));

test("rerunAll: one call per chapter, rules marks rebuilt first, one confirm gate (task 018)", async () => {
  const s = session();
  s.chapters[0].narrative = "human edit";
  s.chapters[0].narrativeEdited = true;
  let calls = 0;
  const a = adapter("shared:1", () => JSON.stringify({ narrative: `n${++calls}`, marks: [] }));
  // any edited narrative → one 409 for all chapters, before any call
  await assert.rejects(
    rerunAll(root(), "git", s, false, { narrate: a, classify: a }),
    (e: ApiError) => e.status === 409 && (e.payload as { needsConfirm: boolean }).needsConfirm,
  );
  assert.equal(calls, 0);
  const out = await rerunAll(root(), "git", s, true, { narrate: a, classify: a });
  assert.equal(calls, 2); // every chapter narrated
  assert.equal(out.chapters[0].narrative, "n1");
  assert.equal(out.chapters[1].narrative, "n2");
  // rules marks rebuilt before narrate: the fixture's custom/llm-mark state
  // is machine-owned and re-derived from the hunks (narrate marks then
  // overwrite "rules" entries only)
  assert.ok(out.chapters[0].attention.every((m) => m.markSource === "rules" || m.markSource === "llm"));
  assert.ok(out.updatedAt > 1); // persisted once
});

test("rerunAll: no adapters → rules marks still rebuilt, classifier-free", async () => {
  const s = session();
  s.chapters[0].attention = [{ file: "src/a.ts", side: "new", line: 11, mark: "safe", markSource: "custom" }];
  const out = await rerunAll(root(), "git", s, false, {});
  assert.ok(out.chapters[0].attention.every((m) => m.markSource === "rules"));
  assert.ok(out.updatedAt > 1);
});

test("rerunChapter: no adapters → session unchanged", async () => {
  const s = session();
  const out = await rerunChapter(root(), "git", s, "abc123", false, {});
  assert.equal(out.chapters[0].narrative, "unanalyzed");
});

test("rerunChapter: shared call sets narrative and refines rules marks", async () => {
  const s = session();
  const a = adapter("shared:1", () =>
    JSON.stringify({ narrative: "sum", marks: [{ file: "src/a.ts", side: "new", line: 11, mark: "focus" }] }));
  const out = await rerunChapter(root(), "git", s, "abc123", false, { narrate: a, classify: a });
  assert.equal(out.chapters[0].narrative, "sum");
  assert.equal(out.chapters[0].attention[0].mark, "focus");
  assert.equal(out.chapters[0].attention[0].markSource, "llm");
  assert.equal(out.chapters[0].attention[1].markSource, "custom");
  assert.ok(out.updatedAt > 1); // persisted
});

test("rerunChapter: malformed shared response discards the whole LLM part", async () => {
  const s = session();
  const a = adapter("shared:1", () => "this is not json");
  const out = await rerunChapter(root(), "git", s, "abc123", false, { narrate: a, classify: a });
  assert.equal(out.chapters[0].narrative, "unanalyzed");
  assert.equal(out.chapters[0].attention[0].mark, "glance");
  assert.equal(out.chapters[0].attention[0].markSource, "rules");
});

test("rerunChapter: different adapters → two calls, independent degradation", async () => {
  const s = session();
  const out = await rerunChapter(root(), "git", s, "abc123", false, {
    narrate: adapter("n:1", () => "plain paragraph"),
    classify: adapter("c:1", () => "!"), // classify call fails → rules marks stay
  });
  assert.equal(out.chapters[0].narrative, "plain paragraph");
  assert.equal(out.chapters[0].attention[0].markSource, "rules");
});

test("rerunChapter: narrativeEdited guard → 409 needsConfirm, confirm regenerates", async () => {
  const s = session();
  s.chapters[0].narrative = "human edit";
  s.chapters[0].narrativeEdited = true;
  const a = adapter("shared:1", () => JSON.stringify({ narrative: "regenerated", marks: [] }));
  await assert.rejects(
    rerunChapter(root(), "git", s, "abc123", false, { narrate: a }),
    (e: ApiError) => e.status === 409 && (e.payload as { needsConfirm: boolean }).needsConfirm,
  );
  const out = await rerunChapter(root(), "git", s, "abc123", true, { narrate: a, classify: a });
  assert.equal(out.chapters[0].narrative, "regenerated");
});

test("rerunChapter: unknown chapter → 404", async () => {
  await assert.rejects(
    rerunChapter(root(), "git", session(), "nope", false, {}),
    (e: ApiError) => e.status === 404,
  );
});
