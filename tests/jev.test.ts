import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_CRITERIA,
  JevError,
  jevClassify,
  jevRequestBody,
  parseJevResponse,
  resolveApiKey,
} from "../src/jev.ts";
import { applyClassifier, classifierRequest, loadClassifierConfig } from "../src/custom-classifier.ts";
import type { Chapter, ClassifierConfig, Hunk } from "../src/types.ts";

const withConfig = (body: unknown): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jev-"));
  fs.mkdirSync(path.join(dir, ".sky-watch"), { recursive: true });
  if (body !== null)
    fs.writeFileSync(path.join(dir, ".sky-watch", "config.json"), JSON.stringify(body));
  return dir;
};

const hunk: Hunk = {
  oldStart: 1,
  newStart: 1,
  oldLines: 2,
  newLines: 2,
  lines: [
    { type: "del", oldLine: 1, text: "old line" },
    { type: "add", newLine: 2, text: "await checkPassword(pwd)" },
  ],
};
const chapter: Chapter = {
  id: "c1",
  files: [{ file: "src/auth.ts", status: "modified", hunks: [hunk] }],
  narrative: "",
  attention: [],
};
const request = (chapters: Chapter[] = [chapter]) => classifierRequest("/repo", "b1", "h1", chapters);
const jevCfg = (extra: object = {}): ClassifierConfig => ({ builtin: "jev", model: "typesafe/jev-1.14", ...extra });

// ---- config ----------------------------------------------------------------

test("loadClassifierConfig: command wins over builtin; jev needs a model", () => {
  assert.equal(loadClassifierConfig(withConfig({ classifier: { command: "x", builtin: "jev", model: "m" } }))?.command, "x");
  assert.equal(loadClassifierConfig(withConfig({ classifier: { builtin: "jev" } })), undefined);
  assert.equal(loadClassifierConfig(withConfig({ classifier: { builtin: "other", model: "m" } })), undefined);
});

test("loadClassifierConfig: jev mode fills defaults, criteria validated", () => {
  const cfg = loadClassifierConfig(withConfig({ classifier: jevCfg({ criteria: { skim: "quick", "bad name": "x", empty: "  " } }) }))!;
  assert.equal(cfg.builtin, "jev");
  assert.equal(cfg.model, "typesafe/jev-1.14");
  assert.equal(cfg.timeoutMs, 30_000);
  assert.equal(cfg.fallback, true);
  assert.deepEqual(cfg.criteria, { skim: "quick" }); // invalid entries dropped
  assert.equal(loadClassifierConfig(withConfig({ classifier: jevCfg({ criteria: { "bad name": "x" } }) }))?.criteria, undefined);
});

test("resolveApiKey: classifier key > env > llm defaults", () => {
  const cfg = loadClassifierConfig(withConfig({ classifier: jevCfg(), defaults: { apiKey: "llm-key" } }))!;
  assert.equal(resolveApiKey(cfg, withConfig({ classifier: jevCfg(), defaults: { apiKey: "llm-key" } })), "llm-key");
  const noKey = withConfig({ classifier: jevCfg() });
  assert.equal(resolveApiKey(jevCfg() as never, noKey), process.env.OPENROUTER_API_KEY);
});

// ---- request building -------------------------------------------------------

test("jevRequestBody: one choice question per changed line, criteria attached", () => {
  const cfg = jevCfg({ criteria: { skim: "quick", hotspot: "read fully" } }) as never;
  const { body, keyMap } = jevRequestBody(request(), cfg);
  const parsed = JSON.parse(body) as { model: string; state: string[]; questions: Record<any, any> };
  assert.equal(parsed.model, "typesafe/jev-1.14");
  assert.equal(Object.keys(parsed.questions).length, 2); // del + add lines
  const q0 = parsed.questions["q0"];
  assert.equal(q0.type, "choice");
  assert.deepEqual(q0.criteria, { skim: "quick", hotspot: "read fully" });
  assert.match(q0.instructions, /src\/auth\.ts \(removed line 1\): "old line"/);
  assert.match(parsed.state[0], /src\/auth\.ts \(modified\)/);
  assert.match(parsed.state[0], /- old line/);
  assert.match(parsed.state[0], /\+ await checkPassword/);
  assert.deepEqual(keyMap.get("q1"), { file: "src/auth.ts", side: "new", line: 2 });
});

test("jevRequestBody: default criteria/instructions when not configured", () => {
  const { body } = jevRequestBody(request(), jevCfg() as never);
  const q = (JSON.parse(body) as { questions: Record<any, any> }).questions["q0"];
  assert.deepEqual(q.criteria, DEFAULT_CRITERIA);
  assert.match(q.instructions as string, /Which attention mark/);
});

// ---- response parsing --------------------------------------------------------

const expectedOf = (req: string) => {
  // coordinates the request carried — same extraction the adapter does
  const parsed = JSON.parse(req) as { chapters: { files: { file: string; hunks: { lines: { side: string; line: number }[] }[] }[] }[] };
  const set = new Set<string>();
  for (const c of parsed.chapters) for (const f of c.files) for (const h of f.hunks) for (const l of h.lines)
    set.add(`${f.file}\u0000${l.side}:${l.line}`);
  return set;
};

test("parseJevResponse: answers → marks; wrong vocabulary and unknown keys skipped", () => {
  const req = request();
  const { keyMap } = jevRequestBody(req, jevCfg() as never);
  const raw = JSON.stringify({
    answers: {
      q0: { type: "choice", choice: "safe" },
      q1: { type: "choice", choice: "focus" },
      q2: { type: "choice", choice: "safe" }, // unknown question key
      q0b: { type: "choice", choice: "not-a-mark" }, // not in vocabulary — and dead key anyway
    },
  });
  const marks = parseJevResponse(raw, DEFAULT_CRITERIA, expectedOf(req), keyMap);
  assert.deepEqual(marks, [
    { file: "src/auth.ts", side: "old", line: 1, mark: "safe", markSource: "custom" },
    { file: "src/auth.ts", side: "new", line: 2, mark: "focus", markSource: "custom" },
  ]);
});

test("parseJevResponse: malformed envelope throws", () => {
  assert.throws(() => parseJevResponse("{}", DEFAULT_CRITERIA, new Set(), new Map()), JevError);
  assert.throws(() => parseJevResponse("not json", DEFAULT_CRITERIA, new Set(), new Map()), JevError);
});

// ---- the HTTP boundary --------------------------------------------------------

test("jevClassify: ok → marks; custom names survive", async () => {
  const cfg = { ...jevCfg({ criteria: { skim: "quick", hotspot: "read fully" } }), apiKey: "cfg-key" };
  const req = request();
  const { keyMap } = jevRequestBody(req, cfg);
  const calls: string[] = [];
  const fakeFetch = async (url: string, init: RequestInit) => {
    calls.push(url);
    assert.equal(new URL(url).pathname, "/api/alpha/decisions");
    assert.equal((init.headers as Record<string, string>).authorization, "Bearer cfg-key");
    const sent = JSON.parse(init.body as string);
    return new Response(JSON.stringify({
      answers: Object.fromEntries([...keyMap.keys()].map((k, i) => [k, { choice: i === 0 ? "skim" : "hotspot" }])),
    }), { status: 200 });
  };
  const root = withConfig({ classifier: { ...cfg, apiKey: "cfg-key" } });
  const run = await jevClassify(cfg, root, req, fakeFetch as typeof fetch);
  assert.equal(run.failed, false);
  assert.deepEqual(run.marks, [
    { file: "src/auth.ts", side: "old", line: 1, mark: "skim", markSource: "custom" },
    { file: "src/auth.ts", side: "new", line: 2, mark: "hotspot", markSource: "custom" },
  ]);
  assert.equal(calls.length, 1);
});

test("jevClassify: HTTP error and missing key degrade to a failed run (no throw)", async () => {
  const run = await jevClassify({ ...jevCfg(), apiKey: "cfg-key" } as never, withConfig(null), request(),
    async () => new Response("nope", { status: 502 }) as Response);
  assert.equal(run.failed, true);
  assert.equal(run.error, "HTTP 502");
  const noKey = await jevClassify(jevCfg() as never, withConfig({ classifier: jevCfg() }), request());
  assert.equal(noKey.failed, true);
  assert.match(noKey.error!, /no api key/);
});

// ---- merge through applyClassifier (shared path, no network) -------------------

test("applyClassifier: jev failure with fallback keeps rules marks; no config → no-op", async () => {
  const root = withConfig({ classifier: jevCfg() }); // no key anywhere → failed run
  const chapters = [{ ...chapter, attention: [{ file: "src/auth.ts", side: "new" as const, line: 2, mark: "focus", markSource: "rules" as const }] }];
  await applyClassifier(root, "b1", "h1", chapters);
  assert.equal(chapters[0].attention[0].mark, "focus"); // rules marks survive
  const noConfig = withConfig(null);
  await applyClassifier(noConfig, "b1", "h1", chapters); // must not throw
});
